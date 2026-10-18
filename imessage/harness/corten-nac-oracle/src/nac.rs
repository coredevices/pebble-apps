use std::cell::{RefCell, UnsafeCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::rc::Rc;

use goblin::mach::cputype::CPU_TYPE_X86_64;
use goblin::mach::Mach;
use log::{debug, warn};
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use unicorn_engine::unicorn_const::{Arch, Mode, Prot};
use unicorn_engine::{RegisterX86, Unicorn};

use crate::AbsintheError;

// ============================================================================
// Serde helpers
// ============================================================================

pub fn bin_serialize<S>(x: &[u8], s: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    s.serialize_bytes(x)
}

pub fn bin_deserialize_mac<'de, D>(d: D) -> Result<[u8; 6], D::Error>
where
    D: Deserializer<'de>,
{
    let v = bin_deserialize(d)?;
    v.try_into().map_err(|v: Vec<u8>| {
        de::Error::custom(format!("expected 6 bytes for MAC address, got {}", v.len()))
    })
}

pub fn bin_deserialize<'de, D>(d: D) -> Result<Vec<u8>, D::Error>
where
    D: Deserializer<'de>,
{
    struct DataVisitor;

    impl<'de> de::Visitor<'de> for DataVisitor {
        type Value = Vec<u8>;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("a byte array, sequence of u8, or null")
        }

        fn visit_bytes<E>(self, v: &[u8]) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(v.to_owned())
        }

        fn visit_byte_buf<E>(self, v: Vec<u8>) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(v)
        }

        // serde_json represents byte arrays as JSON arrays [u8, u8, ...],
        // which calls visit_seq instead of visit_bytes.
        fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
        where
            A: de::SeqAccess<'de>,
        {
            let mut bytes = Vec::with_capacity(seq.size_hint().unwrap_or(0));
            while let Some(b) = seq.next_element::<u8>()? {
                bytes.push(b);
            }
            Ok(bytes)
        }
    }

    d.deserialize_any(DataVisitor)
}

// ============================================================================
// HardwareConfig
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HardwareConfig {
    pub product_name: String,
    #[serde(
        serialize_with = "bin_serialize",
        deserialize_with = "bin_deserialize_mac"
    )]
    pub io_mac_address: [u8; 6],
    pub platform_serial_number: String,
    pub platform_uuid: String,
    pub root_disk_uuid: String,
    pub board_id: String,
    pub os_build_num: String,
    #[serde(serialize_with = "bin_serialize", deserialize_with = "bin_deserialize")]
    pub platform_serial_number_enc: Vec<u8>, // Gq3489ugfi
    #[serde(serialize_with = "bin_serialize", deserialize_with = "bin_deserialize")]
    pub platform_uuid_enc: Vec<u8>, // Fyp98tpgj
    #[serde(serialize_with = "bin_serialize", deserialize_with = "bin_deserialize")]
    pub root_disk_uuid_enc: Vec<u8>, // kbjfrfpoJU
    #[serde(serialize_with = "bin_serialize", deserialize_with = "bin_deserialize")]
    pub rom: Vec<u8>,
    #[serde(serialize_with = "bin_serialize", deserialize_with = "bin_deserialize")]
    pub rom_enc: Vec<u8>, // oycqAZloTNDm
    pub mlb: String,
    #[serde(serialize_with = "bin_serialize", deserialize_with = "bin_deserialize")]
    pub mlb_enc: Vec<u8>, // abKPld1EcMni
}

impl HardwareConfig {
    pub fn from_validation_data(_data: &[u8]) -> Result<HardwareConfig, AbsintheError> {
        Err(AbsintheError::Other(
            "from_validation_data is not supported in emulation mode".into(),
        ))
    }
}

// ============================================================================
// Constants
// ============================================================================

const HOOK_BASE: u64 = 0xD0_0000;
const HOOK_SIZE: u64 = 0x1000;
const STACK_BASE: u64 = 0x30_0000;
const STACK_SIZE: u64 = 0x10_0000;
const HEAP_BASE: u64 = 0x40_0000;
const HEAP_SIZE: u64 = 0x10_0000;
const STOP_ADDR: u64 = 0x90_0000;

const NAC_INIT: u64 = 0xB_1DB0;
const NAC_KEY_EST: u64 = 0xB_1DD0;
const NAC_SIGN: u64 = 0xB_1DF0;
const EMULATION_TIMEOUT_MICROS: u64 = 60_000_000;
const EMULATION_INSTRUCTION_LIMIT: usize = 500_000_000;
const MAX_NATIVE_SESSION_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_NATIVE_VALIDATION_DATA_BYTES: usize = 1024 * 1024;

/// x86-64 SysV integer argument registers, in order.
const ARG_REGS: [RegisterX86; 6] = [
    RegisterX86::RDI,
    RegisterX86::RSI,
    RegisterX86::RDX,
    RegisterX86::RCX,
    RegisterX86::R8,
    RegisterX86::R9,
];

// ============================================================================
// CF Object types for the emulated CoreFoundation
// ============================================================================

#[derive(Clone, Debug)]
enum CfObj {
    Data(Vec<u8>),
    Str(String),
    Dict(HashMap<String, usize>), // values are 1-based cf_objects indices
}

// ============================================================================
// Emulator shared state
// ============================================================================

struct EmuState {
    cf_objects: Vec<CfObj>,
    heap_use: u64,
    hook_map: HashMap<u64, String>, // hook addr → symbol name
    hw_iokit: HashMap<String, CfObj>,
    root_disk_uuid: String,
    eth_iterator_hack: bool,
    random: DeterministicRandomWords,
    unsupported_import_called: bool,
}

#[derive(Debug)]
struct DeterministicRandomWords {
    words: VecDeque<u32>,
    consumed: usize,
    exhausted: bool,
}

impl DeterministicRandomWords {
    fn new(words: Vec<u32>) -> Self {
        Self {
            words: words.into(),
            consumed: 0,
            exhausted: false,
        }
    }

    fn next(&mut self) -> u32 {
        match self.words.pop_front() {
            Some(word) => {
                self.consumed += 1;
                word
            }
            None => {
                self.exhausted = true;
                0
            }
        }
    }

    fn finish(&self) -> Result<usize, AbsintheError> {
        if self.exhausted {
            return Err(AbsintheError::Other(
                "deterministic arc4random word input was exhausted".into(),
            ));
        }
        if !self.words.is_empty() {
            return Err(AbsintheError::Other(format!(
                "{} deterministic arc4random words were not consumed",
                self.words.len()
            )));
        }
        Ok(self.consumed)
    }
}

impl EmuState {
    fn new(hw: &HardwareConfig, arc4random_words: Vec<u32>) -> Self {
        let mut iokit = HashMap::new();

        // Data (raw bytes) properties
        iokit.insert(
            "4D1EDE05-38C7-4A6A-9CC6-4BCCA8B38C14:MLB".into(),
            CfObj::Data(hw.mlb.as_bytes().to_vec()),
        );
        iokit.insert(
            "4D1EDE05-38C7-4A6A-9CC6-4BCCA8B38C14:ROM".into(),
            CfObj::Data(hw.rom.clone()),
        );
        // Encrypted/obfuscated IOKit properties — present on Intel Macs.
        // On Apple Silicon these are empty; skip them so the binary gets NULL
        // (same as a real Apple Silicon Mac's IOKit registry).
        if !hw.platform_uuid_enc.is_empty() {
            iokit.insert(
                "Fyp98tpgj".into(),
                CfObj::Data(hw.platform_uuid_enc.clone()),
            );
        }
        if !hw.platform_serial_number_enc.is_empty() {
            iokit.insert(
                "Gq3489ugfi".into(),
                CfObj::Data(hw.platform_serial_number_enc.clone()),
            );
        }
        iokit.insert(
            "IOMACAddress".into(),
            CfObj::Data(hw.io_mac_address.to_vec()),
        );
        if !hw.mlb_enc.is_empty() {
            iokit.insert("abKPld1EcMni".into(), CfObj::Data(hw.mlb_enc.clone()));
        }
        if !hw.root_disk_uuid_enc.is_empty() {
            iokit.insert(
                "kbjfrfpoJU".into(),
                CfObj::Data(hw.root_disk_uuid_enc.clone()),
            );
        }
        if !hw.rom_enc.is_empty() {
            iokit.insert("oycqAZloTNDm".into(), CfObj::Data(hw.rom_enc.clone()));
        }

        // String properties
        iokit.insert(
            "IOPlatformSerialNumber".into(),
            CfObj::Str(hw.platform_serial_number.clone()),
        );
        iokit.insert(
            "IOPlatformUUID".into(),
            CfObj::Str(hw.platform_uuid.clone()),
        );

        // Null-terminated C-string data
        let mut pn = hw.product_name.as_bytes().to_vec();
        pn.push(0);
        iokit.insert("product-name".into(), CfObj::Data(pn));
        let mut bi = hw.board_id.as_bytes().to_vec();
        bi.push(0);
        iokit.insert("board-id".into(), CfObj::Data(bi));

        Self {
            cf_objects: Vec::new(),
            heap_use: 0,
            hook_map: HashMap::new(),
            hw_iokit: iokit,
            root_disk_uuid: hw.root_disk_uuid.clone(),
            eth_iterator_hack: false,
            random: DeterministicRandomWords::new(arc4random_words),
            unsupported_import_called: false,
        }
    }

    fn heap_alloc(&mut self, size: u64) -> u64 {
        // Align to 16 bytes
        let aligned = (size + 15) & !15;
        let addr = HEAP_BASE + self.heap_use;
        self.heap_use += aligned;
        if self.heap_use > HEAP_SIZE {
            panic!(
                "NAC emulator heap overflow ({} > {})",
                self.heap_use, HEAP_SIZE
            );
        }
        addr
    }

    /// Add a CF object, return its 1-based "pointer".
    fn cf_add(&mut self, obj: CfObj) -> u64 {
        self.cf_objects.push(obj);
        self.cf_objects.len() as u64
    }

    fn cf_get(&self, id: u64) -> Option<&CfObj> {
        if id == 0 || (id as usize) > self.cf_objects.len() {
            None
        } else {
            Some(&self.cf_objects[(id as usize) - 1])
        }
    }
}

/// Extract the x86_64 slice from a (possibly fat) Mach-O binary.
pub(crate) fn extract_x86_64_slice(data: &[u8]) -> Result<Vec<u8>, AbsintheError> {
    match Mach::parse(data)
        .map_err(|e| AbsintheError::Other(format!("Mach-O parse error: {}", e)))?
    {
        Mach::Fat(fat) => {
            for arch in fat.iter_arches() {
                let arch =
                    arch.map_err(|e| AbsintheError::Other(format!("Fat arch parse error: {}", e)))?;
                if arch.cputype == CPU_TYPE_X86_64 {
                    let start = arch.offset as usize;
                    let end = start + arch.size as usize;
                    if end > data.len() {
                        return Err(AbsintheError::Other(
                            "x86_64 slice extends beyond file".into(),
                        ));
                    }
                    return Ok(data[start..end].to_vec());
                }
            }
            Err(AbsintheError::Other("No x86_64 slice in fat binary".into()))
        }
        Mach::Binary(macho) => {
            if macho.header.cputype != CPU_TYPE_X86_64 {
                return Err(AbsintheError::Other(
                    "Single-arch Mach-O binary is not x86_64".into(),
                ));
            }
            Ok(data.to_vec())
        }
    }
}

// ============================================================================
// Unicorn helpers
// ============================================================================

fn uc_read_u64(uc: &Unicorn<()>, addr: u64) -> u64 {
    let buf = uc.mem_read_as_vec(addr, 8).unwrap_or_default();
    u64::from_le_bytes(buf.try_into().unwrap_or([0u8; 8]))
}

fn uc_write_u64(uc: &mut Unicorn<()>, addr: u64, val: u64) {
    uc.mem_write(addr, &val.to_le_bytes()).unwrap();
}

fn uc_read_cstr(uc: &Unicorn<()>, addr: u64, max: usize) -> String {
    let buf = uc.mem_read_as_vec(addr, max).unwrap_or_default();
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

/// Parse a __builtin_CFString pointer: { isa, flags, str_ptr, length }
fn uc_read_cfstr(uc: &Unicorn<()>, ptr: u64) -> String {
    let buf = uc.mem_read_as_vec(ptr, 32).unwrap_or_default();
    if buf.len() < 32 {
        return String::new();
    }
    // isa = bytes 0..8 (ignored)
    // flags = bytes 8..16 (ignored)
    let str_ptr = u64::from_le_bytes(buf[16..24].try_into().unwrap());
    let length = u64::from_le_bytes(buf[24..32].try_into().unwrap());
    let str_data = uc
        .mem_read_as_vec(str_ptr, length as usize)
        .unwrap_or_default();
    String::from_utf8_lossy(&str_data).into_owned()
}

fn arg(uc: &Unicorn<()>, n: usize) -> u64 {
    uc.reg_read(ARG_REGS[n]).unwrap_or(0)
}

fn set_ret(uc: &mut Unicorn<()>, val: u64) {
    uc.reg_write(RegisterX86::RAX, val).unwrap();
}

// ============================================================================
// Hook dispatch
// ============================================================================

/// Master hook dispatcher — called by the Unicorn code hook for every
/// instruction in the HOOK_BASE region.
fn dispatch(uc: &mut Unicorn<()>, state: &mut EmuState, addr: u64) {
    let name = match state.hook_map.get(&addr) {
        Some(n) => n.clone(),
        None => return,
    };

    let ret: Option<u64> = match name.as_str() {
        UNSUPPORTED_IMPORT_HOOK_NAME => {
            state.unsupported_import_called = true;
            Some(0)
        }
        // Memory / system
        "_malloc" => {
            let size = arg(uc, 0);
            Some(state.heap_alloc(size.max(1)))
        }
        "_free" => Some(0),
        "___stack_chk_guard" => Some(0),
        "___memset_chk" => {
            let dest = arg(uc, 0);
            let c = arg(uc, 1) as u8;
            let len = arg(uc, 2) as usize;
            let buf = vec![c; len];
            uc.mem_write(dest, &buf).unwrap();
            Some(0)
        }
        "_memcpy" => {
            let dest = arg(uc, 0);
            let src = arg(uc, 1);
            let len = arg(uc, 2) as usize;
            let buf = uc.mem_read_as_vec(src, len).unwrap_or_default();
            uc.mem_write(dest, &buf).unwrap();
            Some(0)
        }
        "___bzero" => {
            let ptr = arg(uc, 0);
            let len = arg(uc, 1) as usize;
            let buf = vec![0u8; len];
            uc.mem_write(ptr, &buf).unwrap();
            Some(0)
        }
        "_sysctlbyname" => Some(0),
        "_statfs$INODE64" => Some(0),
        "_arc4random" => {
            let word = state.random.next();
            Some(word as u64)
        }

        // IOKit
        "_kIOMasterPortDefault" => Some(0), // data symbol, value doesn't matter
        "_IORegistryEntryFromPath" => Some(1),
        "_IORegistryEntryCreateCFProperty" => {
            // (entry, key_cfstr, allocator, options) -> cf_id
            let key_ptr = arg(uc, 1);
            let key_name = uc_read_cfstr(uc, key_ptr);
            debug!("IORegistryEntryCreateCFProperty: key={}", key_name);
            if let Some(obj) = state.hw_iokit.get(&key_name).cloned() {
                Some(state.cf_add(obj))
            } else {
                debug!("  -> key not found, returning NULL");
                Some(0)
            }
        }
        "_IOServiceMatching" => {
            let name_ptr = arg(uc, 0);
            let name = uc_read_cstr(uc, name_ptr, 256);
            debug!("IOServiceMatching: {}", name);
            let str_id = state.cf_add(CfObj::Str(name));
            let dict_id = {
                let mut d = HashMap::new();
                d.insert("IOProviderClass".into(), str_id as usize);
                state.cf_add(CfObj::Dict(d))
            };
            Some(dict_id)
        }
        "_IOServiceGetMatchingService" => Some(92),
        "_IOServiceGetMatchingServices" => {
            state.eth_iterator_hack = true;
            // Write iterator handle (93) to the output pointer (arg 2)
            let existing_ptr = arg(uc, 2);
            uc.mem_write(existing_ptr, &[93u8]).unwrap();
            Some(0)
        }
        "_IOIteratorNext" => {
            if state.eth_iterator_hack {
                state.eth_iterator_hack = false;
                Some(94)
            } else {
                Some(0)
            }
        }
        "_IORegistryEntryGetParentEntry" => {
            let entry = arg(uc, 0) as u8;
            let parent_ptr = arg(uc, 2);
            uc.mem_write(parent_ptr, &[entry.wrapping_add(100)])
                .unwrap();
            Some(0)
        }
        "_IOObjectRelease" => Some(0),

        // DiskArbitration
        "_DASessionCreate" => Some(201),
        "_DADiskCreateFromBSDName" => Some(202),
        "_DADiskCopyDescription" => {
            // Create a dictionary containing the volume UUID
            let mut d = HashMap::new();
            let uuid_id = state.cf_add(CfObj::Str(state.root_disk_uuid.clone()));
            d.insert("DADiskDescriptionVolumeUUIDKey".into(), uuid_id as usize);
            Some(state.cf_add(CfObj::Dict(d)))
        }
        "_kDADiskDescriptionVolumeUUIDKey" => Some(0), // data symbol

        // CoreFoundation allocator / boolean
        "_kCFAllocatorDefault" => Some(0),
        "_kCFBooleanTrue" => Some(0),

        // CoreFoundation type IDs
        "_CFGetTypeID" => {
            let obj_id = arg(uc, 0);
            match state.cf_get(obj_id) {
                Some(CfObj::Data(_)) => Some(1),
                Some(CfObj::Str(_)) => Some(2),
                _ => Some(0),
            }
        }
        "_CFStringGetTypeID" => Some(2),
        "_CFDataGetTypeID" => Some(1),

        // CFData
        "_CFDataGetLength" => {
            let obj_id = arg(uc, 0);
            match state.cf_get(obj_id) {
                Some(CfObj::Data(d)) => Some(d.len() as u64),
                _ => Some(0),
            }
        }
        "_CFDataGetBytes" => {
            let obj_id = arg(uc, 0);
            let range_start = arg(uc, 1) as usize;
            let range_end = arg(uc, 2) as usize;
            let buf_ptr = arg(uc, 3);
            if let Some(CfObj::Data(d)) = state.cf_get(obj_id).cloned() {
                let slice = &d[range_start..range_end.min(d.len())];
                uc.mem_write(buf_ptr, slice).unwrap();
                Some(slice.len() as u64)
            } else {
                Some(0)
            }
        }

        // CFString
        "_CFStringGetLength" => {
            let obj_id = arg(uc, 0);
            match state.cf_get(obj_id) {
                Some(CfObj::Str(s)) => Some(s.len() as u64),
                _ => Some(0),
            }
        }
        "_CFStringGetMaximumSizeForEncoding" => {
            let length = arg(uc, 0);
            Some(length) // UTF-8 max = length for ASCII
        }
        "_CFStringGetCString" => {
            let obj_id = arg(uc, 0);
            let buf_ptr = arg(uc, 1);
            if let Some(CfObj::Str(s)) = state.cf_get(obj_id).cloned() {
                uc.mem_write(buf_ptr, s.as_bytes()).unwrap();
                Some(s.len() as u64)
            } else {
                Some(0)
            }
        }
        "_CFUUIDCreateString" => {
            // (allocator, uuid) -> uuid  (pass-through)
            Some(arg(uc, 1))
        }

        // CFDictionary
        "_CFDictionaryCreateMutable" => Some(state.cf_add(CfObj::Dict(HashMap::new()))),
        "_CFDictionarySetValue" => {
            let dict_id = arg(uc, 0);
            let key_raw = arg(uc, 1);
            let val_raw = arg(uc, 2);
            // Resolve key to string
            let key_str = resolve_cf_or_raw(state, key_raw);
            let val_idx = val_raw as usize;
            if dict_id > 0 && (dict_id as usize) <= state.cf_objects.len() {
                if let CfObj::Dict(ref mut d) = state.cf_objects[(dict_id as usize) - 1] {
                    d.insert(key_str, val_idx);
                }
            }
            None // void return
        }
        "_CFDictionaryGetValue" => {
            let dict_id = arg(uc, 0);
            let key_raw = arg(uc, 1);
            // The _kDADiskDescriptionVolumeUUIDKey data symbol resolves to a
            // hook address filled with 0xC3 bytes, so reading 8 bytes yields
            // 0xC3C3C3C3C3C3C3C3.  Recognise that sentinel.
            let key_str = if key_raw == 0xC3C3_C3C3_C3C3_C3C3 {
                "DADiskDescriptionVolumeUUIDKey".to_string()
            } else {
                resolve_cf_or_raw(state, key_raw)
            };
            debug!("CFDictionaryGetValue dict={} key={}", dict_id, key_str);
            if let Some(CfObj::Dict(d)) = state.cf_get(dict_id).cloned() {
                if let Some(&val_idx) = d.get(&key_str) {
                    // Re-add the referenced object so we return a fresh id
                    if let Some(obj) = state.cf_objects.get(val_idx - 1).cloned() {
                        Some(state.cf_add(obj))
                    } else {
                        Some(val_idx as u64)
                    }
                } else {
                    warn!("CFDictionaryGetValue: key '{}' not found", key_str);
                    Some(0)
                }
            } else {
                Some(0)
            }
        }

        // CFRelease
        "_CFRelease" => Some(0),

        _ => {
            debug!("Unhandled hook: {}", name);
            Some(0)
        }
    };

    if let Some(v) = ret {
        set_ret(uc, v);
    }
}

/// Resolve a value that might be a CF object id or a raw pointer.
fn resolve_cf_or_raw(state: &EmuState, val: u64) -> String {
    if val > 0 && (val as usize) <= state.cf_objects.len() {
        match &state.cf_objects[(val as usize) - 1] {
            CfObj::Str(s) => return s.clone(),
            CfObj::Data(d) => {
                // Try interpreting as a C string
                let end = d.iter().position(|&b| b == 0).unwrap_or(d.len());
                return String::from_utf8_lossy(&d[..end]).into_owned();
            }
            _ => {}
        }
    }
    // Return the raw value as a string for use as a dict key
    format!("0x{:x}", val)
}

// ============================================================================
// Hook symbol list
// ============================================================================

/// All external symbols that the NAC binary might reference.
const HOOK_SYMBOLS: &[&str] = &[
    "_malloc",
    "_free",
    "___stack_chk_guard",
    "___memset_chk",
    "_memcpy",
    "___bzero",
    "_sysctlbyname",
    "_statfs$INODE64",
    "_arc4random",
    "_kIOMasterPortDefault",
    "_IORegistryEntryFromPath",
    "_IORegistryEntryCreateCFProperty",
    "_IOServiceMatching",
    "_IOServiceGetMatchingService",
    "_IOServiceGetMatchingServices",
    "_IOIteratorNext",
    "_IORegistryEntryGetParentEntry",
    "_IOObjectRelease",
    "_DASessionCreate",
    "_DADiskCreateFromBSDName",
    "_DADiskCopyDescription",
    "_kDADiskDescriptionVolumeUUIDKey",
    "_kCFAllocatorDefault",
    "_kCFBooleanTrue",
    "_CFGetTypeID",
    "_CFStringGetTypeID",
    "_CFDataGetTypeID",
    "_CFDataGetLength",
    "_CFDataGetBytes",
    "_CFStringGetLength",
    "_CFStringGetMaximumSizeForEncoding",
    "_CFStringGetCString",
    "_CFUUIDCreateString",
    "_CFDictionaryCreateMutable",
    "_CFDictionarySetValue",
    "_CFDictionaryGetValue",
    "_CFRelease",
];
const UNSUPPORTED_IMPORT_HOOK_NAME: &str = "__corten_nac_unsupported_import";
const UNSUPPORTED_IMPORT_HOOK_ADDR: u64 = HOOK_BASE + HOOK_SYMBOLS.len() as u64;

// ============================================================================
// ValidationCtx
// ============================================================================

pub struct ValidationCtx {
    uc: UnsafeCell<Unicorn<'static, ()>>,
    state: Rc<RefCell<EmuState>>,
    validation_ctx_addr: u64,
}

unsafe impl Send for ValidationCtx {}

impl ValidationCtx {
    /// Initialise NAC validation.
    ///
    /// * `cert_chain`        — certificate bytes from Apple's validation cert endpoint
    /// * `out_request_bytes` — filled with the session-info-request to send to Apple
    /// * `hw_config`         — hardware identifiers (extracted from a real Mac)
    pub fn new_deterministic(
        nac_binary: &[u8],
        cert_chain: &[u8],
        out_request_bytes: &mut Vec<u8>,
        hw_config: &HardwareConfig,
        arc4random_words: Vec<u32>,
    ) -> Result<ValidationCtx, AbsintheError> {
        // 1. Use only the caller-supplied, hash-checked NAC binary.
        let binary = extract_x86_64_slice(nac_binary)?;

        // 2. Create emulator state
        let state = Rc::new(RefCell::new(EmuState::new(hw_config, arc4random_words)));

        // 3. Create Unicorn x86-64 engine
        let mut uc = Unicorn::new(Arch::X86, Mode::MODE_64)
            .map_err(|e| AbsintheError::Other(format!("Unicorn init failed: {:?}", e)))?;

        // 4. Map binary at address 0
        let bin_pages = round_up(binary.len(), 0x1000) as u64;
        uc.mem_map(0, bin_pages, Prot::ALL)
            .map_err(|e| AbsintheError::Other(format!("Failed to map binary: {:?}", e)))?;
        uc.mem_write(0, &binary)
            .map_err(|e| AbsintheError::Other(format!("Failed to write binary: {:?}", e)))?;

        // 5. Map hook space (filled with RET instructions)
        uc.mem_map(HOOK_BASE, HOOK_SIZE, Prot::ALL)
            .map_err(|e| AbsintheError::Other(format!("Failed to map hooks: {:?}", e)))?;
        uc.mem_write(HOOK_BASE, &vec![0xC3u8; HOOK_SIZE as usize])
            .map_err(|e| AbsintheError::Other(format!("Failed to write hooks: {:?}", e)))?;

        // 6. Map stack
        uc.mem_map(STACK_BASE, STACK_SIZE, Prot::ALL)
            .map_err(|e| AbsintheError::Other(format!("Failed to map stack: {:?}", e)))?;
        uc.reg_write(RegisterX86::RSP, STACK_BASE + STACK_SIZE)
            .map_err(|e| AbsintheError::Other(format!("Failed to set RSP: {:?}", e)))?;
        uc.reg_write(RegisterX86::RBP, STACK_BASE + STACK_SIZE)
            .map_err(|e| AbsintheError::Other(format!("Failed to set RBP: {:?}", e)))?;

        // 7. Map heap
        uc.mem_map(HEAP_BASE, HEAP_SIZE, Prot::ALL)
            .map_err(|e| AbsintheError::Other(format!("Failed to map heap: {:?}", e)))?;

        // 8. Map stop page
        uc.mem_map(STOP_ADDR, 0x1000, Prot::ALL)
            .map_err(|e| AbsintheError::Other(format!("Failed to map stop page: {:?}", e)))?;
        uc.mem_write(STOP_ADDR, &vec![0xC3u8; 0x1000])
            .map_err(|e| AbsintheError::Other(format!("Failed to write stop page: {:?}", e)))?;

        // 9. Assign hook addresses and build lookup table
        {
            let mut st = state.borrow_mut();
            for (i, &sym) in HOOK_SYMBOLS.iter().enumerate() {
                let addr = HOOK_BASE + i as u64;
                st.hook_map.insert(addr, sym.to_string());
            }
            st.hook_map.insert(
                UNSUPPORTED_IMPORT_HOOK_ADDR,
                UNSUPPORTED_IMPORT_HOOK_NAME.to_string(),
            );
        }

        // 10. Resolve Mach-O imports → write hook addresses into GOT
        resolve_imports(&mut uc, &binary, &state.borrow())?;

        // 11. Add code hook for the hook space
        let hook_state = state.clone();
        uc.add_code_hook(
            HOOK_BASE,
            HOOK_BASE + HOOK_SIZE - 1,
            move |uc, addr, _size| {
                let mut st = hook_state.borrow_mut();
                dispatch(uc, &mut st, addr);
            },
        )
        .map_err(|e| AbsintheError::Other(format!("Failed to add code hook: {:?}", e)))?;

        // 12. Call nac_init
        let cert_addr;
        let out_ctx_ptr;
        let out_req_ptr;
        let out_req_len_ptr;
        {
            let mut st = state.borrow_mut();
            cert_addr = st.heap_alloc(cert_chain.len() as u64);
            out_ctx_ptr = st.heap_alloc(8);
            out_req_ptr = st.heap_alloc(8);
            out_req_len_ptr = st.heap_alloc(8);
        }
        uc.mem_write(cert_addr, cert_chain)
            .map_err(|e| AbsintheError::Other(format!("Failed to write cert: {:?}", e)))?;

        let ret = call_func(
            &mut uc,
            NAC_INIT,
            &[
                cert_addr,
                cert_chain.len() as u64,
                out_ctx_ptr,
                out_req_ptr,
                out_req_len_ptr,
            ],
        )?;
        ensure_runtime_state(&state.borrow())?;

        if ret != 0 {
            return Err(AbsintheError::NacError(-(ret as i64 as i32)));
        }

        // Read outputs
        let validation_ctx_addr = uc_read_u64(&uc, out_ctx_ptr);
        let req_bytes_addr = uc_read_u64(&uc, out_req_ptr);
        let req_len = usize::try_from(uc_read_u64(&uc, out_req_len_ptr)).map_err(|_| {
            AbsintheError::Other("NACInit session-info request length does not fit usize".into())
        })?;
        validate_native_output_length(
            "NACInit session-info request",
            req_len,
            MAX_NATIVE_SESSION_REQUEST_BYTES,
        )?;

        debug!(
            "nac_init: ctx=0x{:x} req_addr=0x{:x} req_len={}",
            validation_ctx_addr, req_bytes_addr, req_len
        );

        let request_data = uc
            .mem_read_as_vec(req_bytes_addr, req_len)
            .map_err(|e| AbsintheError::Other(format!("Failed to read request: {:?}", e)))?;
        *out_request_bytes = request_data;

        Ok(ValidationCtx {
            uc: UnsafeCell::new(uc),
            state,
            validation_ctx_addr,
        })
    }

    /// Process the session-info response from Apple.
    pub fn key_establishment(&mut self, response: &[u8]) -> Result<(), AbsintheError> {
        let resp_addr = {
            let mut st = self.state.borrow_mut();
            st.heap_alloc(response.len() as u64)
        };
        let uc = self.uc.get_mut();
        uc.mem_write(resp_addr, response)
            .map_err(|e| AbsintheError::Other(format!("Failed to write response: {:?}", e)))?;

        let ret = call_func(
            uc,
            NAC_KEY_EST,
            &[self.validation_ctx_addr, resp_addr, response.len() as u64],
        )?;
        ensure_runtime_state(&self.state.borrow())?;

        if ret != 0 {
            return Err(AbsintheError::NacError(-(ret as i64 as i32)));
        }
        Ok(())
    }

    /// Generate signed validation data.
    pub fn sign(&self) -> Result<Vec<u8>, AbsintheError> {
        // sign() takes &self but we need &mut for the emulator.
        // Safety: ValidationCtx is only used from one thread (enforced by
        // the single-threaded usage pattern and unsafe Send impl).
        let uc = unsafe { &mut *self.uc.get() };

        let out_data_ptr;
        let out_data_len_ptr;
        {
            let mut st = self.state.borrow_mut();
            out_data_ptr = st.heap_alloc(8);
            out_data_len_ptr = st.heap_alloc(8);
        }

        let ret = call_func(
            uc,
            NAC_SIGN,
            &[
                self.validation_ctx_addr,
                0,
                0,
                out_data_ptr,
                out_data_len_ptr,
            ],
        )?;
        ensure_runtime_state(&self.state.borrow())?;

        if ret != 0 {
            return Err(AbsintheError::NacError(-(ret as i64 as i32)));
        }

        let data_addr = uc_read_u64(uc, out_data_ptr);
        let data_len = usize::try_from(uc_read_u64(uc, out_data_len_ptr)).map_err(|_| {
            AbsintheError::Other("NACSign validation data length does not fit usize".into())
        })?;
        validate_native_output_length(
            "NACSign validation data",
            data_len,
            MAX_NATIVE_VALIDATION_DATA_BYTES,
        )?;

        debug!("nac_sign: data_addr=0x{:x} len={}", data_addr, data_len);

        let validation_data = uc.mem_read_as_vec(data_addr, data_len).map_err(|e| {
            AbsintheError::Other(format!("Failed to read validation data: {:?}", e))
        })?;

        Ok(validation_data)
    }

    pub fn finish_random_words(&self) -> Result<usize, AbsintheError> {
        self.state.borrow().random.finish()
    }
}

fn ensure_runtime_state(state: &EmuState) -> Result<(), AbsintheError> {
    if state.unsupported_import_called {
        return Err(AbsintheError::Other(
            "NAC code called an unsupported executable import".into(),
        ));
    }
    if state.random.exhausted {
        return Err(AbsintheError::Other(
            "deterministic arc4random word input was exhausted".into(),
        ));
    }
    Ok(())
}

fn validate_native_output_length(
    name: &str,
    length: usize,
    maximum: usize,
) -> Result<(), AbsintheError> {
    if length == 0 || length > maximum {
        return Err(AbsintheError::Other(format!(
            "{name} length {length} is outside 1..={maximum} bytes"
        )));
    }
    Ok(())
}

// ============================================================================
// Function calling helper
// ============================================================================

/// Call a function at `addr` with the given arguments, using the x86-64 SysV
/// calling convention. Returns the value in RAX.
fn call_func(uc: &mut Unicorn<'static, ()>, addr: u64, args: &[u64]) -> Result<u64, AbsintheError> {
    call_func_with_limits(
        uc,
        addr,
        args,
        EMULATION_TIMEOUT_MICROS,
        EMULATION_INSTRUCTION_LIMIT,
    )
}

fn call_func_with_limits(
    uc: &mut Unicorn<'static, ()>,
    addr: u64,
    args: &[u64],
    timeout_micros: u64,
    instruction_limit: usize,
) -> Result<u64, AbsintheError> {
    // Push return address (STOP_ADDR)
    let mut rsp = uc.reg_read(RegisterX86::RSP).unwrap();
    rsp -= 8;
    uc.reg_write(RegisterX86::RSP, rsp).unwrap();
    uc_write_u64(uc, rsp, STOP_ADDR);

    // Set argument registers
    for (i, &val) in args.iter().enumerate() {
        if i < 6 {
            uc.reg_write(ARG_REGS[i], val).unwrap();
        } else {
            // Push remaining args on stack (right to left order already handled)
            rsp -= 8;
            uc.reg_write(RegisterX86::RSP, rsp).unwrap();
            uc_write_u64(uc, rsp, val);
        }
    }

    // Run emulation
    uc.emu_start(addr, STOP_ADDR, timeout_micros, instruction_limit)
        .map_err(|e| AbsintheError::Other(format!("Emulation error at 0x{:x}: {:?}", addr, e)))?;

    let stopped_at = uc
        .reg_read(RegisterX86::RIP)
        .map_err(|e| AbsintheError::Other(format!("Failed to read RIP: {e:?}")))?;
    if stopped_at != STOP_ADDR {
        return Err(AbsintheError::Other(format!(
            "Emulation execution limit reached before NAC function 0x{addr:x} returned"
        )));
    }

    Ok(uc.reg_read(RegisterX86::RAX).unwrap())
}

// ============================================================================
// Mach-O import resolution
// ============================================================================

#[derive(Debug, Eq, PartialEq)]
struct PlannedImport<'a> {
    name: &'a str,
    offset: u64,
    hook_addr: u64,
    supported: bool,
}

fn plan_import_bindings<'a, I>(
    imports: I,
    supported_hooks: &HashMap<&str, u64>,
) -> Result<Vec<PlannedImport<'a>>, AbsintheError>
where
    I: IntoIterator<Item = (&'a str, u64)>,
{
    let mut matched = HashSet::new();
    let mut seen_offsets = HashSet::new();
    let mut bindings = Vec::new();

    for (name, offset) in imports {
        if !seen_offsets.insert(offset) {
            return Err(AbsintheError::Other(
                "NAC Mach-O imports contain overlapping pointer offsets".into(),
            ));
        }
        let (hook_addr, supported) = match supported_hooks.get(name) {
            Some(&address) => {
                matched.insert(name.to_string());
                (address, true)
            }
            None => (UNSUPPORTED_IMPORT_HOOK_ADDR, false),
        };
        bindings.push(PlannedImport {
            name,
            offset,
            hook_addr,
            supported,
        });
    }

    let mut missing = supported_hooks
        .keys()
        .filter(|name| !matched.contains(**name))
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        missing.sort_unstable();
        return Err(AbsintheError::Other(format!(
            "NAC Mach-O is missing required host imports: {}",
            missing.join(", ")
        )));
    }
    Ok(bindings)
}

fn resolve_imports(
    uc: &mut Unicorn<'static, ()>,
    binary: &[u8],
    state: &EmuState,
) -> Result<(), AbsintheError> {
    let macho = match goblin::mach::MachO::parse(binary, 0) {
        Ok(m) => m,
        Err(e) => return Err(AbsintheError::Other(format!("Mach-O parse error: {}", e))),
    };

    // Build symbol → hook address lookup
    let mut sym_to_hook: HashMap<&str, u64> = HashMap::new();
    for (&addr, name) in &state.hook_map {
        // The trap hook is internal and must not become a required Mach-O import.
        if name != UNSUPPORTED_IMPORT_HOOK_NAME {
            // hook_map has full names like "_malloc"; imports use the same spelling.
            sym_to_hook.insert(name.as_str(), addr);
        }
    }

    // Bind every executable import. Required imports point to their emulated
    // host hooks; all unrelated imports point to a trap hook so the NAC path
    // fails deterministically if it tries to execute one.
    let imports = macho.imports().map_err(|error| {
        AbsintheError::Other(format!("Failed to parse Mach-O imports: {error}"))
    })?;
    let bindings = plan_import_bindings(
        imports.iter().map(|import| (import.name, import.offset)),
        &sym_to_hook,
    )?;
    for binding in bindings {
        uc.mem_write(binding.offset, &binding.hook_addr.to_le_bytes())
            .map_err(|error| {
                AbsintheError::Other(format!(
                    "Failed to write import {} at 0x{:x}: {:?}",
                    binding.name, binding.offset, error
                ))
            })?;
        debug!(
            "Bound {} import {} at offset 0x{:x} → hook 0x{:x}",
            if binding.supported {
                "supported"
            } else {
                "unsupported"
            },
            binding.name,
            binding.offset,
            binding.hook_addr
        );
    }

    Ok(())
}

// ============================================================================
// Utility
// ============================================================================

fn round_up(val: usize, align: usize) -> usize {
    (val + align - 1) & !(align - 1)
}

#[cfg(test)]
mod deterministic_random_tests {
    use super::*;

    #[test]
    fn consumes_words_in_exact_order() {
        let mut words = DeterministicRandomWords::new(vec![7, u32::MAX]);
        assert_eq!(words.next(), 7);
        assert_eq!(words.next(), u32::MAX);
        assert_eq!(words.finish().unwrap(), 2);
    }

    #[test]
    fn rejects_unused_words() {
        let words = DeterministicRandomWords::new(vec![7]);
        assert!(words
            .finish()
            .unwrap_err()
            .to_string()
            .contains("not consumed"));
    }

    #[test]
    fn rejects_exhaustion_even_though_hook_returns_zero() {
        let mut words = DeterministicRandomWords::new(Vec::new());
        assert_eq!(words.next(), 0);
        assert!(words
            .finish()
            .unwrap_err()
            .to_string()
            .contains("exhausted"));
    }

    #[test]
    fn rejects_native_output_lengths_before_memory_reads() {
        assert!(validate_native_output_length("test output", 0, 16).is_err());
        assert!(validate_native_output_length("test output", 17, 16).is_err());
        assert!(validate_native_output_length("test output", 16, 16).is_ok());
    }

    #[test]
    fn instruction_limit_stops_code_that_never_returns() {
        let mut uc = Unicorn::new(Arch::X86, Mode::MODE_64).unwrap();
        uc.mem_map(0x1000, 0x1000, Prot::ALL).unwrap();
        uc.mem_write(0x1000, &[0xeb, 0xfe]).unwrap(); // jmp 0x1000
        uc.mem_map(STACK_BASE, STACK_SIZE, Prot::ALL).unwrap();
        uc.reg_write(RegisterX86::RSP, STACK_BASE + STACK_SIZE)
            .unwrap();
        uc.mem_map(STOP_ADDR, 0x1000, Prot::ALL).unwrap();

        let error = call_func_with_limits(&mut uc, 0x1000, &[], 1_000_000, 32).unwrap_err();
        assert!(error.to_string().contains("execution limit reached"));
    }

    #[test]
    fn wall_clock_limit_stops_code_that_never_returns() {
        let mut uc = Unicorn::new(Arch::X86, Mode::MODE_64).unwrap();
        uc.mem_map(0x1000, 0x1000, Prot::ALL).unwrap();
        uc.mem_write(0x1000, &[0xeb, 0xfe]).unwrap(); // jmp 0x1000
        uc.mem_map(STACK_BASE, STACK_SIZE, Prot::ALL).unwrap();
        uc.reg_write(RegisterX86::RSP, STACK_BASE + STACK_SIZE)
            .unwrap();
        uc.mem_map(STOP_ADDR, 0x1000, Prot::ALL).unwrap();

        let error = call_func_with_limits(&mut uc, 0x1000, &[], 10_000, 1_000_000_000).unwrap_err();
        assert!(error.to_string().contains("execution limit reached"));
    }

    fn supported_hook_addresses() -> HashMap<&'static str, u64> {
        HOOK_SYMBOLS
            .iter()
            .enumerate()
            .map(|(index, &name)| (name, HOOK_BASE + index as u64))
            .collect()
    }

    #[test]
    fn import_plan_rejects_a_missing_required_hook() {
        let hooks = supported_hook_addresses();
        let imports = HOOK_SYMBOLS
            .iter()
            .skip(1)
            .enumerate()
            .map(|(index, &name)| (name, index as u64 * 8));
        let error = plan_import_bindings(imports, &hooks).unwrap_err();
        assert!(error.to_string().contains("_malloc"));
    }

    #[test]
    fn import_plan_routes_unexpected_executable_imports_to_the_trap() {
        let hooks = supported_hook_addresses();
        let mut imports = HOOK_SYMBOLS
            .iter()
            .enumerate()
            .map(|(index, &name)| (name, index as u64 * 8))
            .collect::<Vec<_>>();
        imports.push(("_unexpected_host_call", 0x1000));
        let plan = plan_import_bindings(imports, &hooks).unwrap();
        let unexpected = plan.last().unwrap();
        assert!(!unexpected.supported);
        assert_eq!(unexpected.hook_addr, UNSUPPORTED_IMPORT_HOOK_ADDR);
    }

    #[test]
    fn executing_the_unexpected_import_trap_marks_runtime_failure() {
        let mut state = EmuState {
            cf_objects: Vec::new(),
            heap_use: 0,
            hook_map: HashMap::from([(
                UNSUPPORTED_IMPORT_HOOK_ADDR,
                UNSUPPORTED_IMPORT_HOOK_NAME.to_string(),
            )]),
            hw_iokit: HashMap::new(),
            root_disk_uuid: String::new(),
            eth_iterator_hack: false,
            random: DeterministicRandomWords::new(Vec::new()),
            unsupported_import_called: false,
        };
        let mut uc = Unicorn::new(Arch::X86, Mode::MODE_64).unwrap();
        dispatch(&mut uc, &mut state, UNSUPPORTED_IMPORT_HOOK_ADDR);
        assert!(ensure_runtime_state(&state)
            .unwrap_err()
            .to_string()
            .contains("unsupported executable import"));
    }
}
