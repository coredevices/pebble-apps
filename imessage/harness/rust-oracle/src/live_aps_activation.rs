use std::{
    fs::{File, OpenOptions},
    io::Read,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
};

use rustpush::macos::{HardwareConfig, MacOSConfig};
use serde::Deserialize;

const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_STRING_BYTES: usize = 16 * 1024;
const MAX_BINARY_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LiveActivationInput {
    inner: HardwareInput,
    version: String,
    protocol_version: u32,
    #[serde(default)]
    device_id: Option<String>,
    icloud_ua: String,
    aoskit_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HardwareInput {
    product_name: String,
    io_mac_address: Vec<u8>,
    platform_serial_number: String,
    platform_uuid: String,
    root_disk_uuid: String,
    board_id: String,
    os_build_num: String,
    platform_serial_number_enc: Vec<u8>,
    platform_uuid_enc: Vec<u8>,
    root_disk_uuid_enc: Vec<u8>,
    rom: Vec<u8>,
    rom_enc: Vec<u8>,
    mlb: String,
    mlb_enc: Vec<u8>,
}

fn validate_string(value: &str, name: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_STRING_BYTES
        || value.bytes().any(|byte| matches!(byte, 0 | b'\r' | b'\n'))
    {
        return Err(format!("{name} is invalid"));
    }
    Ok(())
}

fn validate_binary(value: &[u8], name: &str, exact_length: Option<usize>) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_BINARY_BYTES
        || exact_length.is_some_and(|length| value.len() != length)
    {
        return Err(format!("{name} is invalid"));
    }
    Ok(())
}

fn read_open_file<F>(file: File, after_metadata: F) -> Result<Vec<u8>, &'static str>
where
    F: FnOnce(),
{
    let metadata = file.metadata().map_err(|_| "input_unavailable")?;
    if !metadata.file_type().is_file()
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.len() == 0
        || metadata.len() > MAX_INPUT_BYTES as u64
    {
        return Err("input_permissions_or_size_invalid");
    }

    after_metadata();
    let mut input = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_INPUT_BYTES as u64 + 1)
        .read_to_end(&mut input)
        .map_err(|_| "input_unavailable")?;
    if input.is_empty() || input.len() > MAX_INPUT_BYTES {
        input.fill(0);
        return Err("input_permissions_or_size_invalid");
    }
    Ok(input)
}

pub fn read_owner_only_input(path: &Path) -> Result<Vec<u8>, &'static str> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "input_unavailable")?;
    read_open_file(file, || {})
}

pub fn parse_hardware_only_input(input: &[u8]) -> Result<MacOSConfig, String> {
    if input.is_empty() || input.len() > MAX_INPUT_BYTES {
        return Err("input size is invalid".to_string());
    }
    let input: LiveActivationInput =
        serde_json::from_slice(input).map_err(|_| "input JSON is invalid".to_string())?;

    for (name, value) in [
        ("version", input.version.as_str()),
        ("icloud_ua", input.icloud_ua.as_str()),
        ("aoskit_version", input.aoskit_version.as_str()),
        ("product_name", input.inner.product_name.as_str()),
        (
            "platform_serial_number",
            input.inner.platform_serial_number.as_str(),
        ),
        ("platform_uuid", input.inner.platform_uuid.as_str()),
        ("root_disk_uuid", input.inner.root_disk_uuid.as_str()),
        ("board_id", input.inner.board_id.as_str()),
        ("os_build_num", input.inner.os_build_num.as_str()),
        ("mlb", input.inner.mlb.as_str()),
    ] {
        validate_string(value, name)?;
    }
    if let Some(device_id) = input.device_id.as_deref() {
        validate_string(device_id, "device_id")?;
    }
    if input.protocol_version == 0 {
        return Err("protocol_version is invalid".to_string());
    }
    if input.icloud_ua.split_once(char::is_whitespace).is_none() {
        return Err("icloud_ua is invalid".to_string());
    }

    validate_binary(&input.inner.io_mac_address, "io_mac_address", Some(6))?;
    validate_binary(
        &input.inner.platform_serial_number_enc,
        "platform_serial_number_enc",
        Some(17),
    )?;
    validate_binary(
        &input.inner.platform_uuid_enc,
        "platform_uuid_enc",
        Some(17),
    )?;
    validate_binary(
        &input.inner.root_disk_uuid_enc,
        "root_disk_uuid_enc",
        Some(17),
    )?;
    validate_binary(&input.inner.rom, "rom", Some(6))?;
    validate_binary(&input.inner.rom_enc, "rom_enc", Some(17))?;
    validate_binary(&input.inner.mlb_enc, "mlb_enc", Some(17))?;

    let io_mac_address: [u8; 6] = input
        .inner
        .io_mac_address
        .try_into()
        .map_err(|_| "io_mac_address is invalid".to_string())?;
    let normalized_device_id = input.inner.platform_uuid.to_uppercase();
    Ok(MacOSConfig {
        inner: HardwareConfig {
            product_name: input.inner.product_name,
            io_mac_address,
            platform_serial_number: input.inner.platform_serial_number,
            platform_uuid: input.inner.platform_uuid,
            root_disk_uuid: input.inner.root_disk_uuid,
            board_id: input.inner.board_id,
            os_build_num: input.inner.os_build_num,
            platform_serial_number_enc: input.inner.platform_serial_number_enc,
            platform_uuid_enc: input.inner.platform_uuid_enc,
            root_disk_uuid_enc: input.inner.root_disk_uuid_enc,
            rom: input.inner.rom,
            rom_enc: input.inner.rom_enc,
            mlb: input.inner.mlb,
            mlb_enc: input.inner.mlb_enc,
        },
        version: input.version,
        protocol_version: input.protocol_version,
        device_id: normalized_device_id.clone(),
        icloud_ua: input.icloud_ua,
        aoskit_version: input.aoskit_version,
        udid: Some(normalized_device_id),
        captured_validation_data: None,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        parse_hardware_only_input, read_open_file, read_owner_only_input, MAX_INPUT_BYTES,
    };
    use serde_json::{json, Value};
    use std::{
        fs::{self, File, OpenOptions},
        io::Write,
        os::unix::fs::{symlink, OpenOptionsExt, PermissionsExt},
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "imessage-live-aps-oracle-{}-{}",
                std::process::id(),
                TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_file(path: &Path, value: &[u8], mode: u32) {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(mode)
            .open(path)
            .unwrap();
        file.write_all(value).unwrap();
    }

    fn valid_input() -> Value {
        let mut value = json!({
            "inner": {
                "product_name": "MacBookPro18,3",
                "io_mac_address": [1, 2, 3, 4, 5, 6],
                "platform_serial_number": "SYNTHETIC-SERIAL",
                "platform_uuid": "12345678-ABCD-4DEF-8123-1234567890AB",
                "root_disk_uuid": "22345678-ABCD-4DEF-8123-1234567890AB",
                "board_id": "Mac-SYNTHETIC",
                "os_build_num": "22G513",
                "platform_serial_number_enc": [],
                "platform_uuid_enc": [],
                "root_disk_uuid_enc": [],
                "rom": [7, 8, 9, 10, 11, 12],
                "rom_enc": [],
                "mlb": "SYNTHETIC-MLB",
                "mlb_enc": []
            },
            "version": "13.6.4",
            "protocol_version": 1660,
            "device_id": "12345678-ABCD-4DEF-8123-1234567890AB",
            "icloud_ua": "com.apple.iCloudHelper/282 CFNetwork/1408.0.4",
            "aoskit_version": "com.apple.AOSKit/282"
        });
        for field in [
            "platform_serial_number_enc",
            "platform_uuid_enc",
            "root_disk_uuid_enc",
            "rom_enc",
            "mlb_enc",
        ] {
            value["inner"][field] = json!(vec![17; 17]);
        }
        value
    }

    #[test]
    fn converts_array_valued_extract_key_hardware() {
        let value = valid_input();
        let config = parse_hardware_only_input(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(config.inner.io_mac_address, [1, 2, 3, 4, 5, 6]);
        assert_eq!(config.inner.rom, [7, 8, 9, 10, 11, 12]);
        assert_eq!(config.device_id, "12345678-ABCD-4DEF-8123-1234567890AB");
        assert_eq!(config.udid.as_deref(), Some(config.device_id.as_str()));
    }

    #[test]
    fn rejects_account_credentials_and_unknown_fields() {
        let mut value = valid_input();
        value["password"] = json!("not-a-real-password");
        assert!(parse_hardware_only_input(&serde_json::to_vec(&value).unwrap()).is_err());

        let mut value = valid_input();
        value["pushBootstrap"] = json!({});
        assert!(parse_hardware_only_input(&serde_json::to_vec(&value).unwrap()).is_err());
    }

    #[test]
    fn rejects_values_that_would_panic_the_pinned_user_agent_builder() {
        let mut value = valid_input();
        value["icloud_ua"] = json!("single-token");
        assert!(parse_hardware_only_input(&serde_json::to_vec(&value).unwrap()).is_err());
    }

    #[test]
    fn normalizes_informational_root_device_id_to_platform_uuid_like_js() {
        let mut value = valid_input();
        value["device_id"] = json!("DIFFERENT-DEVICE-ID");
        let config = parse_hardware_only_input(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(config.device_id, "12345678-ABCD-4DEF-8123-1234567890AB");
        assert_eq!(config.udid.as_deref(), Some(config.device_id.as_str()));
    }

    #[test]
    fn owner_only_reader_rejects_symlinks_permissions_and_oversize_files() {
        let directory = TempDirectory::new();
        let valid = directory.path("valid.json");
        write_file(&valid, b"{}", 0o600);
        assert_eq!(read_owner_only_input(&valid).unwrap(), b"{}");

        let permissive = directory.path("permissive.json");
        write_file(&permissive, b"{}", 0o600);
        fs::set_permissions(&permissive, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_owner_only_input(&permissive).is_err());

        let symlink_path = directory.path("symlink.json");
        symlink(&valid, &symlink_path).unwrap();
        assert!(read_owner_only_input(&symlink_path).is_err());

        let oversized = directory.path("oversized.json");
        write_file(&oversized, b"x", 0o600);
        File::options()
            .write(true)
            .open(&oversized)
            .unwrap()
            .set_len(MAX_INPUT_BYTES as u64 + 1)
            .unwrap();
        assert!(read_owner_only_input(&oversized).is_err());
    }

    #[test]
    fn descriptor_reader_bounds_growth_and_ignores_path_replacement() {
        let directory = TempDirectory::new();
        let growing = directory.path("growing.json");
        write_file(&growing, b"x", 0o600);
        let growing_reader = File::open(&growing).unwrap();
        assert!(read_open_file(growing_reader, || {
            File::options()
                .write(true)
                .open(&growing)
                .unwrap()
                .set_len(MAX_INPUT_BYTES as u64 + 1)
                .unwrap();
        })
        .is_err());

        let original = directory.path("replace.json");
        let moved = directory.path("replace-original.json");
        write_file(&original, b"original", 0o600);
        let original_reader = File::open(&original).unwrap();
        let result = read_open_file(original_reader, || {
            fs::rename(&original, &moved).unwrap();
            write_file(&original, b"replacement", 0o600);
        })
        .unwrap();
        assert_eq!(result, b"original");
    }
}
