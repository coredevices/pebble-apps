use std::error::Error;
use std::fmt::{self, Display};
use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};
use sha2::Sha256;

pub mod nac;

pub const SCHEMA_VERSION: u32 = 1;
pub const CORTEN_COMMIT: &str = "501403fcbe8802cc427e9ccab3573c5367508fdf";
pub const NAC_BINARY_SHA1: &str = "e1181ccad82e6629d52c6a006645ad87ee59bd13";
pub const NAC_BINARY_SHA256: &str =
    "74c2a8fe826a478f14f6e17b3709a8b315e8c0e0e34e3fba6b9c4eee2f4516e9";
pub const NAC_X86_64_SLICE_SHA256: &str =
    "7f225430438171b2d460cd953fe1110a2d6699e6d0d944780471ef58fd075d9f";
pub const NAC_BINARY_ENV: &str = "NAC_BINARY_FILE";

const MAX_BINARY_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_REQUEST_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PROTOCOL_BYTES: usize = 1024 * 1024;
const MAX_RANDOM_WORDS: usize = 4096;
const MAX_HARDWARE_STRING_BYTES: usize = 512;

#[derive(Debug)]
pub enum AbsintheError {
    NacError(i32),
    Other(String),
}

impl Display for AbsintheError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NacError(code) => write!(f, "NAC error: {code}"),
            Self::Other(message) => f.write_str(message),
        }
    }
}

impl Error for AbsintheError {}

impl From<String> for AbsintheError {
    fn from(value: String) -> Self {
        Self::Other(value)
    }
}

impl From<&str> for AbsintheError {
    fn from(value: &str) -> Self {
        Self::Other(value.to_string())
    }
}

impl From<std::io::Error> for AbsintheError {
    fn from(value: std::io::Error) -> Self {
        Self::Other(format!("IO error: {value}"))
    }
}

#[derive(Debug)]
struct OracleError {
    code: &'static str,
    message: String,
}

impl OracleError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunRequest {
    schema_version: u32,
    request_id: Value,
    operation: String,
    cert_chain_base64: String,
    session_info_base64: String,
    hardware: nac::HardwareConfig,
    arc4random_words: Vec<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InitializeRequest {
    schema_version: u32,
    request_id: Value,
    operation: String,
    cert_chain_base64: String,
    hardware: nac::HardwareConfig,
    arc4random_words: Vec<u32>,
    replace_pending: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompleteRequest {
    schema_version: u32,
    request_id: Value,
    operation: String,
    session_id: String,
    session_info_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelRequest {
    schema_version: u32,
    request_id: Value,
    operation: String,
    session_id: String,
}

#[derive(Debug, Serialize)]
struct Response {
    schema_version: u32,
    request_id: Value,
    #[serde(flatten)]
    outcome: Outcome,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum Outcome {
    Success { ok: bool, result: Value },
    Failure { ok: bool, error: ErrorBody },
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Serialize)]
struct RunResult {
    session_info_request_base64: String,
    validation_data_base64: String,
    arc4random_words_consumed: usize,
    corten_commit: &'static str,
    nac_binary_sha1: &'static str,
    nac_binary_sha256: &'static str,
    nac_x86_64_slice_sha256: &'static str,
}

#[derive(Debug, Serialize)]
struct InitializeResult {
    session_id: String,
    session_info_request_base64: String,
}

#[derive(Debug, Serialize)]
struct CompleteResult {
    session_id: String,
    validation_data_base64: String,
    arc4random_words_consumed: usize,
    corten_commit: &'static str,
    nac_binary_sha1: &'static str,
    nac_binary_sha256: &'static str,
    nac_x86_64_slice_sha256: &'static str,
}

#[derive(Debug, Serialize)]
struct CancelResult {
    session_id: String,
    cancelled: bool,
}

struct NativeCompletion {
    validation_data: Vec<u8>,
    arc4random_words_consumed: usize,
}

trait PendingNacContext {
    fn complete(self: Box<Self>, session_info: &[u8]) -> Result<NativeCompletion, OracleError>;
}

impl PendingNacContext for nac::ValidationCtx {
    fn complete(mut self: Box<Self>, session_info: &[u8]) -> Result<NativeCompletion, OracleError> {
        self.key_establishment(session_info)
            .map_err(map_nac_error)?;
        let validation_data = self.sign().map_err(map_nac_error)?;
        let arc4random_words_consumed = self.finish_random_words().map_err(map_nac_error)?;
        Ok(NativeCompletion {
            validation_data,
            arc4random_words_consumed,
        })
    }
}

struct InitializedContext {
    context: Box<dyn PendingNacContext>,
    session_info_request: Vec<u8>,
}

trait SessionInitializer {
    fn initialize(
        &mut self,
        certificate: &[u8],
        hardware: &nac::HardwareConfig,
        random_words: Vec<u32>,
    ) -> Result<InitializedContext, OracleError>;
}

type BinaryLoader = dyn FnMut(Option<&Path>) -> Result<Vec<u8>, OracleError>;

struct NativeSessionInitializer {
    binary_path: Option<PathBuf>,
    verified_binary: Option<Vec<u8>>,
    binary_loader: Box<BinaryLoader>,
}

impl NativeSessionInitializer {
    fn verified_binary(&mut self) -> Result<&[u8], OracleError> {
        if self.verified_binary.is_none() {
            self.verified_binary = Some((self.binary_loader)(self.binary_path.as_deref())?);
        }
        Ok(self
            .verified_binary
            .as_deref()
            .expect("verified binary was initialized"))
    }
}

impl SessionInitializer for NativeSessionInitializer {
    fn initialize(
        &mut self,
        certificate: &[u8],
        hardware: &nac::HardwareConfig,
        random_words: Vec<u32>,
    ) -> Result<InitializedContext, OracleError> {
        let binary = self.verified_binary()?;
        let mut session_info_request = Vec::new();
        let context = nac::ValidationCtx::new_deterministic(
            binary,
            certificate,
            &mut session_info_request,
            hardware,
            random_words,
        )
        .map_err(map_nac_error)?;
        Ok(InitializedContext {
            context: Box::new(context),
            session_info_request,
        })
    }
}

struct PendingSession {
    id: String,
    context: Box<dyn PendingNacContext>,
}

pub struct OracleSessionServer {
    binary_path: Option<PathBuf>,
    initializer: Box<dyn SessionInitializer>,
    pending: Option<PendingSession>,
    session_generation: u64,
}

impl OracleSessionServer {
    pub fn from_environment() -> Self {
        Self::with_binary_path(std::env::var_os(NAC_BINARY_ENV).map(PathBuf::from))
    }

    fn with_binary_path(binary_path: Option<PathBuf>) -> Self {
        Self {
            initializer: Box::new(NativeSessionInitializer {
                binary_path: binary_path.clone(),
                verified_binary: None,
                binary_loader: Box::new(load_pinned_binary),
            }),
            binary_path,
            pending: None,
            session_generation: 0,
        }
    }

    #[cfg(test)]
    fn with_initializer(initializer: Box<dyn SessionInitializer>) -> Self {
        Self {
            binary_path: None,
            initializer,
            pending: None,
            session_generation: 0,
        }
    }

    pub fn process_line(&mut self, line: &str) -> String {
        if line.len() > MAX_REQUEST_LINE_BYTES {
            return failure(
                Value::Null,
                "invalid_request",
                format!("request exceeds {MAX_REQUEST_LINE_BYTES} bytes"),
            );
        }
        let value = match serde_json::from_str::<Value>(line) {
            Ok(value) => value,
            Err(error) => return failure(Value::Null, "invalid_request", error.to_string()),
        };
        let request_id = value.get("request_id").cloned().unwrap_or(Value::Null);
        match value.get("operation").and_then(Value::as_str) {
            Some("initialize_nac_validation") => self.initialize(value, request_id),
            Some("complete_nac_validation") => self.complete(value, request_id),
            Some("cancel_nac_validation") => self.cancel(value, request_id),
            _ => process_run_value(value, request_id, self.binary_path.as_deref()),
        }
    }

    fn initialize(&mut self, value: Value, request_id: Value) -> String {
        let request = match serde_json::from_value::<InitializeRequest>(value) {
            Ok(request) => request,
            Err(_) => return code_failure(request_id, "invalid_request"),
        };
        if request.schema_version != SCHEMA_VERSION {
            return code_failure(request.request_id, "unsupported_schema_version");
        }
        if request.operation != "initialize_nac_validation" {
            return code_failure(request.request_id, "unsupported_operation");
        }
        let certificate =
            match decode_protocol_bytes("cert_chain_base64", &request.cert_chain_base64) {
                Ok(value) => value,
                Err(error) => return code_failure(request.request_id, error.code),
            };
        if let Err(error) = validate_hardware(&request.hardware) {
            return code_failure(request.request_id, error.code);
        }
        if request.arc4random_words.len() > MAX_RANDOM_WORDS {
            return code_failure(request.request_id, "invalid_random_words");
        }
        if self.pending.is_some() && !request.replace_pending {
            return code_failure(request.request_id, "pending_context_exists");
        }
        let next_generation = match self.session_generation.checked_add(1) {
            Some(value) => value,
            None => return code_failure(request.request_id, "session_id_exhausted"),
        };
        if request.replace_pending {
            self.pending.take();
        }
        let initialized = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.initializer
                .initialize(&certificate, &request.hardware, request.arc4random_words)
        }));
        let initialized = match initialized {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => return code_failure(request.request_id, error.code),
            Err(_) => return code_failure(request.request_id, "nac_execution_panicked"),
        };
        if initialized.session_info_request.is_empty()
            || initialized.session_info_request.len() > MAX_PROTOCOL_BYTES
        {
            return code_failure(request.request_id, "nac_execution_failed");
        }
        let session_id = session_id(next_generation);
        let result = InitializeResult {
            session_id: session_id.clone(),
            session_info_request_base64: BASE64_STANDARD.encode(initialized.session_info_request),
        };
        self.pending = Some(PendingSession {
            id: session_id,
            context: initialized.context,
        });
        self.session_generation = next_generation;
        success(request.request_id, result)
    }

    fn complete(&mut self, value: Value, request_id: Value) -> String {
        let request = match serde_json::from_value::<CompleteRequest>(value) {
            Ok(request) => request,
            Err(_) => return code_failure(request_id, "invalid_request"),
        };
        if request.schema_version != SCHEMA_VERSION {
            return code_failure(request.request_id, "unsupported_schema_version");
        }
        if request.operation != "complete_nac_validation" || !is_session_id(&request.session_id) {
            return code_failure(request.request_id, "invalid_request");
        }
        let pending = match self.pending.as_ref() {
            Some(pending) => pending,
            None => return code_failure(request.request_id, "no_pending_context"),
        };
        if pending.id != request.session_id {
            return code_failure(request.request_id, "session_id_mismatch");
        }
        let session_info =
            match decode_protocol_bytes("session_info_base64", &request.session_info_base64) {
                Ok(value) => value,
                Err(error) => return code_failure(request.request_id, error.code),
            };
        let pending = self.pending.take().expect("pending context was checked");
        let completion = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            pending.context.complete(&session_info)
        }));
        let completion = match completion {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => return code_failure(request.request_id, error.code),
            Err(_) => return code_failure(request.request_id, "nac_execution_panicked"),
        };
        if completion.validation_data.is_empty()
            || completion.validation_data.len() > MAX_PROTOCOL_BYTES
            || completion.arc4random_words_consumed > MAX_RANDOM_WORDS
        {
            return code_failure(request.request_id, "nac_execution_failed");
        }
        success(
            request.request_id,
            CompleteResult {
                session_id: request.session_id,
                validation_data_base64: BASE64_STANDARD.encode(completion.validation_data),
                arc4random_words_consumed: completion.arc4random_words_consumed,
                corten_commit: CORTEN_COMMIT,
                nac_binary_sha1: NAC_BINARY_SHA1,
                nac_binary_sha256: NAC_BINARY_SHA256,
                nac_x86_64_slice_sha256: NAC_X86_64_SLICE_SHA256,
            },
        )
    }

    fn cancel(&mut self, value: Value, request_id: Value) -> String {
        let request = match serde_json::from_value::<CancelRequest>(value) {
            Ok(request) => request,
            Err(_) => return code_failure(request_id, "invalid_request"),
        };
        if request.schema_version != SCHEMA_VERSION {
            return code_failure(request.request_id, "unsupported_schema_version");
        }
        if request.operation != "cancel_nac_validation" || !is_session_id(&request.session_id) {
            return code_failure(request.request_id, "invalid_request");
        }
        let pending = match self.pending.as_ref() {
            Some(pending) => pending,
            None => return code_failure(request.request_id, "no_pending_context"),
        };
        if pending.id != request.session_id {
            return code_failure(request.request_id, "session_id_mismatch");
        }
        self.pending.take();
        success(
            request.request_id,
            CancelResult {
                session_id: request.session_id,
                cancelled: true,
            },
        )
    }
}

pub fn process_line(line: &str) -> String {
    if line.len() > MAX_REQUEST_LINE_BYTES {
        return failure(
            Value::Null,
            "invalid_request",
            format!("request exceeds {MAX_REQUEST_LINE_BYTES} bytes"),
        );
    }
    let value = match serde_json::from_str::<Value>(line) {
        Ok(value) => value,
        Err(error) => return failure(Value::Null, "invalid_request", error.to_string()),
    };
    let request_id = value.get("request_id").cloned().unwrap_or(Value::Null);
    if matches!(
        value.get("operation").and_then(Value::as_str),
        Some("initialize_nac_validation" | "complete_nac_validation" | "cancel_nac_validation")
    ) {
        return code_failure(request_id, "stateful_server_required");
    }
    process_run_value(
        value,
        request_id,
        std::env::var_os(NAC_BINARY_ENV)
            .map(PathBuf::from)
            .as_deref(),
    )
}

#[cfg(test)]
fn process_line_with_binary_path(line: &str, binary_path: Option<&Path>) -> String {
    OracleSessionServer::with_binary_path(binary_path.map(Path::to_path_buf)).process_line(line)
}

fn process_run_value(value: Value, request_id: Value, binary_path: Option<&Path>) -> String {
    let request = match serde_json::from_value::<RunRequest>(value) {
        Ok(request) => request,
        Err(error) => return failure(request_id, "invalid_request", error.to_string()),
    };
    if request.schema_version != SCHEMA_VERSION {
        return failure(
            request.request_id,
            "unsupported_schema_version",
            format!(
                "schema_version {} is unsupported; expected {SCHEMA_VERSION}",
                request.schema_version
            ),
        );
    }
    if request.operation != "run_nac_validation" {
        return failure(
            request.request_id,
            "unsupported_operation",
            "operation must be run_nac_validation".to_string(),
        );
    }

    let cert_chain = match decode_protocol_bytes("cert_chain_base64", &request.cert_chain_base64) {
        Ok(value) => value,
        Err(error) => return failure(request.request_id, error.code, error.message),
    };
    let session_info =
        match decode_protocol_bytes("session_info_base64", &request.session_info_base64) {
            Ok(value) => value,
            Err(error) => return failure(request.request_id, error.code, error.message),
        };
    if let Err(error) = validate_hardware(&request.hardware) {
        return failure(request.request_id, error.code, error.message);
    }
    if request.arc4random_words.len() > MAX_RANDOM_WORDS {
        return failure(
            request.request_id,
            "invalid_random_words",
            format!("arc4random_words exceeds {MAX_RANDOM_WORDS} entries"),
        );
    }

    let binary = match load_pinned_binary(binary_path) {
        Ok(binary) => binary,
        Err(error) => return failure(request.request_id, error.code, error.message),
    };

    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_validation(
            &binary,
            &cert_chain,
            &session_info,
            &request.hardware,
            request.arc4random_words,
        )
    }));
    match run {
        Ok(Ok(result)) => success(request.request_id, result),
        Ok(Err(error)) => failure(request.request_id, error.code, error.message),
        Err(_) => failure(
            request.request_id,
            "nac_execution_panicked",
            "Corten NAC emulation panicked".to_string(),
        ),
    }
}

fn run_validation(
    binary: &[u8],
    cert_chain: &[u8],
    session_info: &[u8],
    hardware: &nac::HardwareConfig,
    random_words: Vec<u32>,
) -> Result<RunResult, OracleError> {
    let mut session_info_request = Vec::new();
    let mut context = nac::ValidationCtx::new_deterministic(
        binary,
        cert_chain,
        &mut session_info_request,
        hardware,
        random_words,
    )
    .map_err(map_nac_error)?;
    context
        .key_establishment(session_info)
        .map_err(map_nac_error)?;
    let validation_data = context.sign().map_err(map_nac_error)?;
    let consumed = context.finish_random_words().map_err(map_nac_error)?;

    Ok(RunResult {
        session_info_request_base64: BASE64_STANDARD.encode(session_info_request),
        validation_data_base64: BASE64_STANDARD.encode(validation_data),
        arc4random_words_consumed: consumed,
        corten_commit: CORTEN_COMMIT,
        nac_binary_sha1: NAC_BINARY_SHA1,
        nac_binary_sha256: NAC_BINARY_SHA256,
        nac_x86_64_slice_sha256: NAC_X86_64_SLICE_SHA256,
    })
}

fn map_nac_error(error: AbsintheError) -> OracleError {
    let message = error.to_string();
    let code = if message.contains("deterministic arc4random") {
        "deterministic_random_mismatch"
    } else {
        "nac_execution_failed"
    };
    OracleError::new(code, message)
}

fn decode_protocol_bytes(name: &str, encoded: &str) -> Result<Vec<u8>, OracleError> {
    let decoded = BASE64_STANDARD.decode(encoded).map_err(|error| {
        OracleError::new("invalid_base64", format!("{name} is invalid: {error}"))
    })?;
    if decoded.is_empty() {
        return Err(OracleError::new(
            "invalid_protocol_input",
            format!("{name} is empty"),
        ));
    }
    if decoded.len() > MAX_PROTOCOL_BYTES {
        return Err(OracleError::new(
            "invalid_protocol_input",
            format!("{name} exceeds {MAX_PROTOCOL_BYTES} decoded bytes"),
        ));
    }
    if BASE64_STANDARD.encode(&decoded) != encoded {
        return Err(OracleError::new(
            "invalid_base64",
            format!("{name} must use canonical padded base64"),
        ));
    }
    Ok(decoded)
}

fn validate_hardware(hardware: &nac::HardwareConfig) -> Result<(), OracleError> {
    for (name, value) in [
        ("product_name", hardware.product_name.as_str()),
        (
            "platform_serial_number",
            hardware.platform_serial_number.as_str(),
        ),
        ("platform_uuid", hardware.platform_uuid.as_str()),
        ("root_disk_uuid", hardware.root_disk_uuid.as_str()),
        ("board_id", hardware.board_id.as_str()),
        ("os_build_num", hardware.os_build_num.as_str()),
        ("mlb", hardware.mlb.as_str()),
    ] {
        if value.is_empty() || value.len() > MAX_HARDWARE_STRING_BYTES {
            return Err(OracleError::new(
                "invalid_hardware",
                format!("hardware.{name} must contain 1..={MAX_HARDWARE_STRING_BYTES} bytes"),
            ));
        }
        if value.chars().any(char::is_control) {
            return Err(OracleError::new(
                "invalid_hardware",
                format!("hardware.{name} contains a control character"),
            ));
        }
    }
    for (name, value) in [
        ("platform_uuid", hardware.platform_uuid.as_str()),
        ("root_disk_uuid", hardware.root_disk_uuid.as_str()),
    ] {
        if !is_canonical_uuid(value) {
            return Err(OracleError::new(
                "invalid_hardware",
                format!("hardware.{name} must use canonical 8-4-4-4-12 UUID syntax"),
            ));
        }
    }
    if hardware.rom.len() != 6 {
        return Err(OracleError::new(
            "invalid_hardware",
            "hardware.rom must contain exactly 6 bytes",
        ));
    }
    for (name, value) in [
        (
            "platform_serial_number_enc",
            hardware.platform_serial_number_enc.as_slice(),
        ),
        ("platform_uuid_enc", hardware.platform_uuid_enc.as_slice()),
        ("root_disk_uuid_enc", hardware.root_disk_uuid_enc.as_slice()),
        ("rom_enc", hardware.rom_enc.as_slice()),
        ("mlb_enc", hardware.mlb_enc.as_slice()),
    ] {
        if value.len() != 17 {
            return Err(OracleError::new(
                "invalid_hardware",
                format!("hardware.{name} must contain exactly 17 bytes"),
            ));
        }
    }
    Ok(())
}

fn is_canonical_uuid(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }
    value.bytes().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    })
}

fn session_id(generation: u64) -> String {
    let mut digest = Sha256::new();
    digest.update(b"corten-nac-oracle-session-v1\0");
    digest.update(generation.to_be_bytes());
    hex_lower(digest.finalize())
}

fn is_session_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn load_pinned_binary(binary_path: Option<&Path>) -> Result<Vec<u8>, OracleError> {
    let binary_path = match binary_path {
        Some(path) if !path.as_os_str().is_empty() => path,
        _ => {
            return Err(OracleError::new(
                "nac_binary_not_configured",
                format!("set {NAC_BINARY_ENV} to the pinned NAC binary"),
            ));
        }
    };
    load_binary_checked(
        binary_path,
        NAC_BINARY_SHA1,
        NAC_BINARY_SHA256,
        NAC_X86_64_SLICE_SHA256,
        MAX_BINARY_BYTES,
    )
}

fn load_binary_checked(
    path: &Path,
    expected_sha1: &str,
    expected_sha256: &str,
    expected_x86_64_slice_sha256: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, OracleError> {
    let metadata = fs::metadata(path).map_err(|error| {
        OracleError::new(
            "nac_binary_read_failed",
            format!("cannot inspect NAC binary: {error}"),
        )
    })?;
    if !metadata.is_file() {
        return Err(OracleError::new(
            "nac_binary_read_failed",
            "NAC_BINARY_FILE must identify a regular file",
        ));
    }
    if metadata.len() > max_bytes {
        return Err(OracleError::new(
            "nac_binary_too_large",
            format!("NAC binary exceeds {max_bytes} bytes"),
        ));
    }
    let binary = fs::read(path).map_err(|error| {
        OracleError::new(
            "nac_binary_read_failed",
            format!("cannot read NAC binary: {error}"),
        )
    })?;
    if binary.len() as u64 > max_bytes {
        return Err(OracleError::new(
            "nac_binary_too_large",
            format!("NAC binary exceeds {max_bytes} bytes"),
        ));
    }
    let actual_sha1 = hex_lower(Sha1::digest(&binary));
    if actual_sha1 != expected_sha1 {
        return Err(OracleError::new(
            "nac_binary_hash_mismatch",
            format!("NAC binary SHA-1 is {actual_sha1}; expected {expected_sha1}"),
        ));
    }
    let actual_sha256 = hex_lower(Sha256::digest(&binary));
    if actual_sha256 != expected_sha256 {
        return Err(OracleError::new(
            "nac_binary_hash_mismatch",
            format!("NAC binary SHA-256 is {actual_sha256}; expected {expected_sha256}"),
        ));
    }
    let x86_64_slice = nac::extract_x86_64_slice(&binary).map_err(|error| {
        OracleError::new(
            "nac_binary_invalid",
            format!("cannot select pinned x86_64 NAC slice: {error}"),
        )
    })?;
    let actual_slice_sha256 = hex_lower(Sha256::digest(&x86_64_slice));
    if actual_slice_sha256 != expected_x86_64_slice_sha256 {
        return Err(OracleError::new(
            "nac_binary_hash_mismatch",
            format!(
                "NAC x86_64 slice SHA-256 is {actual_slice_sha256}; expected {expected_x86_64_slice_sha256}"
            ),
        ));
    }
    Ok(binary)
}

pub fn oversized_request_response() -> String {
    failure(
        Value::Null,
        "invalid_request",
        format!("request exceeds {MAX_REQUEST_LINE_BYTES} bytes"),
    )
}

fn hex_lower(bytes: impl AsRef<[u8]>) -> String {
    let mut output = String::with_capacity(bytes.as_ref().len() * 2);
    for byte in bytes.as_ref() {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

fn failure(request_id: Value, code: &'static str, message: String) -> String {
    serialize_response(Response {
        schema_version: SCHEMA_VERSION,
        request_id,
        outcome: Outcome::Failure {
            ok: false,
            error: ErrorBody {
                code,
                message: Some(message),
            },
        },
    })
}

fn code_failure(request_id: Value, code: &'static str) -> String {
    serialize_response(Response {
        schema_version: SCHEMA_VERSION,
        request_id,
        outcome: Outcome::Failure {
            ok: false,
            error: ErrorBody {
                code,
                message: None,
            },
        },
    })
}

fn success(result_id: Value, result: impl Serialize) -> String {
    let result = serde_json::to_value(result).expect("result serialization cannot fail");
    serialize_response(Response {
        schema_version: SCHEMA_VERSION,
        request_id: result_id,
        outcome: Outcome::Success { ok: true, result },
    })
}

fn serialize_response(response: Response) -> String {
    serde_json::to_string(&response).expect("response serialization cannot fail")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn request() -> String {
        serde_json::json!({
            "schema_version": 1,
            "request_id": "nac-1",
            "operation": "run_nac_validation",
            "cert_chain_base64": "AQ==",
            "session_info_base64": "Ag==",
            "hardware": {
                "product_name": "SyntheticMac1,1",
                "io_mac_address": [2, 0, 0, 0, 0, 1],
                "platform_serial_number": "SYNTHETIC0001",
                "platform_uuid": "00000000-0000-4000-8000-000000000001",
                "root_disk_uuid": "00000000-0000-4000-8000-000000000002",
                "board_id": "Synthetic-Board",
                "os_build_num": "00A000",
            "platform_serial_number_enc": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            "platform_uuid_enc": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            "root_disk_uuid_enc": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            "rom": [2, 0, 0, 0, 0, 1],
            "rom_enc": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            "mlb": "SYNTHETICMLB00001",
            "mlb_enc": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
            },
            "arc4random_words": [1]
        })
        .to_string()
    }

    fn temp_file(contents: &[u8]) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "corten-nac-oracle-{}-{nonce}.bin",
            std::process::id()
        ));
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn requires_an_explicit_binary_path() {
        let response: Value =
            serde_json::from_str(&process_line_with_binary_path(&request(), None)).unwrap();
        assert_eq!(response["error"]["code"], "nac_binary_not_configured");
    }

    #[test]
    fn rejects_a_wrong_binary_hash_before_emulation() {
        let path = temp_file(b"not the pinned binary");
        let response: Value =
            serde_json::from_str(&process_line_with_binary_path(&request(), Some(&path))).unwrap();
        fs::remove_file(path).unwrap();
        assert_eq!(response["error"]["code"], "nac_binary_hash_mismatch");
    }

    #[test]
    fn persistent_native_initializer_reuses_its_hash_verified_binary() {
        let load_calls = Rc::new(RefCell::new(0));
        let observed_calls = load_calls.clone();
        let mut initializer = NativeSessionInitializer {
            binary_path: Some(PathBuf::from("explicit-test-path")),
            verified_binary: None,
            binary_loader: Box::new(move |path| {
                assert_eq!(path, Some(Path::new("explicit-test-path")));
                *load_calls.borrow_mut() += 1;
                Ok(vec![1, 2, 3])
            }),
        };
        assert_eq!(initializer.verified_binary().unwrap(), [1, 2, 3]);
        assert_eq!(initializer.verified_binary().unwrap(), [1, 2, 3]);
        assert_eq!(*observed_calls.borrow(), 1);
    }

    fn minimal_x86_64_macho() -> Vec<u8> {
        vec![
            0xcf, 0xfa, 0xed, 0xfe, // MH_MAGIC_64
            0x07, 0x00, 0x00, 0x01, // CPU_TYPE_X86_64
            0x03, 0x00, 0x00, 0x00, // CPU_SUBTYPE_X86_64_ALL
            0x02, 0x00, 0x00, 0x00, // MH_EXECUTE
            0x00, 0x00, 0x00, 0x00, // ncmds
            0x00, 0x00, 0x00, 0x00, // sizeofcmds
            0x00, 0x00, 0x00, 0x00, // flags
            0x00, 0x00, 0x00, 0x00, // reserved
        ]
    }

    fn minimal_fat_macho_with_x86_64_slice() -> Vec<u8> {
        let i386_slice = vec![
            0xce, 0xfa, 0xed, 0xfe, // MH_MAGIC
            0x07, 0x00, 0x00, 0x00, // CPU_TYPE_I386
            0x03, 0x00, 0x00, 0x00, // CPU_SUBTYPE_I386_ALL
            0x02, 0x00, 0x00, 0x00, // MH_EXECUTE
            0x00, 0x00, 0x00, 0x00, // ncmds
            0x00, 0x00, 0x00, 0x00, // sizeofcmds
            0x00, 0x00, 0x00, 0x00, // flags
        ];
        let x86_64_slice = minimal_x86_64_macho();
        let mut fat = Vec::new();
        for word in [
            0xcafe_babe_u32, // FAT_MAGIC
            2,               // nfat_arch
            7,               // CPU_TYPE_I386
            3,               // CPU_SUBTYPE_I386_ALL
            48,              // first slice offset
            i386_slice.len() as u32,
            2,           // 4-byte alignment
            0x0100_0007, // CPU_TYPE_X86_64
            3,           // CPU_SUBTYPE_X86_64_ALL
            80,          // second slice offset
            x86_64_slice.len() as u32,
            2, // 4-byte alignment
        ] {
            fat.extend_from_slice(&word.to_be_bytes());
        }
        fat.extend_from_slice(&i386_slice);
        fat.resize(80, 0);
        fat.extend_from_slice(&x86_64_slice);
        fat
    }

    #[test]
    fn checked_loader_requires_all_three_expected_hashes() {
        let contents = minimal_fat_macho_with_x86_64_slice();
        let selected_slice = minimal_x86_64_macho();
        let expected_sha1 = hex_lower(Sha1::digest(&contents));
        let expected_sha256 = hex_lower(Sha256::digest(&contents));
        let expected_slice_sha256 = hex_lower(Sha256::digest(&selected_slice));
        assert_ne!(expected_sha256, expected_slice_sha256);
        let path = temp_file(&contents);
        assert_eq!(
            load_binary_checked(
                &path,
                &expected_sha1,
                &expected_sha256,
                &expected_slice_sha256,
                1024,
            )
            .unwrap(),
            contents
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn checked_loader_rejects_full_sha256_mismatch() {
        let contents = minimal_fat_macho_with_x86_64_slice();
        let selected_slice = minimal_x86_64_macho();
        let expected_sha1 = hex_lower(Sha1::digest(&contents));
        let expected_slice_sha256 = hex_lower(Sha256::digest(&selected_slice));
        let path = temp_file(&contents);
        let error = load_binary_checked(
            &path,
            &expected_sha1,
            &"0".repeat(64),
            &expected_slice_sha256,
            1024,
        )
        .unwrap_err();
        fs::remove_file(path).unwrap();
        assert_eq!(error.code, "nac_binary_hash_mismatch");
        assert!(error.message.contains("binary SHA-256"));
    }

    #[test]
    fn checked_loader_rejects_selected_slice_sha256_mismatch() {
        let contents = minimal_fat_macho_with_x86_64_slice();
        let expected_sha1 = hex_lower(Sha1::digest(&contents));
        let expected_sha256 = hex_lower(Sha256::digest(&contents));
        let path = temp_file(&contents);
        let error = load_binary_checked(
            &path,
            &expected_sha1,
            &expected_sha256,
            &"0".repeat(64),
            1024,
        )
        .unwrap_err();
        fs::remove_file(path).unwrap();
        assert_eq!(error.code, "nac_binary_hash_mismatch");
        assert!(error.message.contains("x86_64 slice SHA-256"));
    }

    #[test]
    fn validates_input_before_reading_the_binary() {
        let mut value: Value = serde_json::from_str(&request()).unwrap();
        value["cert_chain_base64"] = Value::String("***".to_string());
        let response: Value = serde_json::from_str(&process_line_with_binary_path(
            &value.to_string(),
            Some(Path::new("/does/not/exist")),
        ))
        .unwrap();
        assert_eq!(response["error"]["code"], "invalid_base64");
    }

    #[test]
    fn rejects_unknown_input_fields() {
        let mut value: Value = serde_json::from_str(&request()).unwrap();
        value["credential"] = Value::String("must-not-be-accepted".to_string());
        let response: Value =
            serde_json::from_str(&process_line_with_binary_path(&value.to_string(), None)).unwrap();
        assert_eq!(response["error"]["code"], "invalid_request");
    }

    #[test]
    fn rejects_oversized_binary_before_reading_it() {
        let path = temp_file(b"12345");
        let error = load_binary_checked(&path, "unused", "unused", "unused", 4).unwrap_err();
        fs::remove_file(path).unwrap();
        assert_eq!(error.code, "nac_binary_too_large");
    }

    #[test]
    fn rejects_noncanonical_base64() {
        let mut value: Value = serde_json::from_str(&request()).unwrap();
        value["cert_chain_base64"] = Value::String("AQ".to_string());
        let response: Value =
            serde_json::from_str(&process_line_with_binary_path(&value.to_string(), None)).unwrap();
        assert_eq!(response["error"]["code"], "invalid_base64");
    }

    #[test]
    fn rejects_an_oversized_request_before_json_parsing() {
        let line = " ".repeat(MAX_REQUEST_LINE_BYTES + 1);
        let response: Value =
            serde_json::from_str(&process_line_with_binary_path(&line, None)).unwrap();
        assert_eq!(response["error"]["code"], "invalid_request");
        assert_eq!(response["request_id"], Value::Null);
    }

    #[test]
    fn requires_every_encrypted_hardware_property_to_be_17_bytes() {
        let mut value: Value = serde_json::from_str(&request()).unwrap();
        value["hardware"]["rom_enc"] = serde_json::json!([]);
        let response: Value =
            serde_json::from_str(&process_line_with_binary_path(&value.to_string(), None)).unwrap();
        assert_eq!(response["error"]["code"], "invalid_hardware");
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("exactly 17 bytes"));
    }

    #[test]
    fn rejects_an_empty_mac_instead_of_defaulting_it_to_zeroes() {
        let mut value: Value = serde_json::from_str(&request()).unwrap();
        value["hardware"]["io_mac_address"] = serde_json::json!([]);
        let response: Value =
            serde_json::from_str(&process_line_with_binary_path(&value.to_string(), None)).unwrap();
        assert_eq!(response["error"]["code"], "invalid_request");
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("expected 6 bytes for MAC address"));
    }

    #[test]
    fn requires_rom_to_be_exactly_6_bytes() {
        let mut value: Value = serde_json::from_str(&request()).unwrap();
        value["hardware"]["rom"] = serde_json::json!([1, 2, 3, 4, 5]);
        let response: Value =
            serde_json::from_str(&process_line_with_binary_path(&value.to_string(), None)).unwrap();
        assert_eq!(response["error"]["code"], "invalid_hardware");
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("exactly 6 bytes"));
    }

    #[test]
    fn uuid_validation_matches_the_js_8_4_4_4_12_pattern() {
        assert!(is_canonical_uuid("3ba98e0d-baa9-5f97-bdfd-32f127f62874"));
        for invalid in [
            "3BA98E0DBAA95F97BDFD32F127F62874",
            "3BA98E0D-BAA9-5F97-BDFD-32F127F6287",
            "3BA98E0D-BAA9-5F97-BDFD-32F127F6287G",
            "{3BA98E0D-BAA9-5F97-BDFD-32F127F62874}",
        ] {
            assert!(!is_canonical_uuid(invalid), "accepted {invalid}");
        }

        let mut value: Value = serde_json::from_str(&request()).unwrap();
        value["hardware"]["root_disk_uuid"] =
            Value::String("00000000000040008000000000000002".to_string());
        let response: Value =
            serde_json::from_str(&process_line_with_binary_path(&value.to_string(), None)).unwrap();
        assert_eq!(response["error"]["code"], "invalid_hardware");
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("8-4-4-4-12"));
    }

    #[derive(Default)]
    struct FakeState {
        initialize_calls: usize,
        complete_calls: usize,
        contexts_alive: usize,
        context_drops: usize,
        initialized_while_context_alive: bool,
        fail_initialize: bool,
        panic_initialize: bool,
        fail_complete: bool,
        panic_complete: bool,
        session_request: Vec<u8>,
        validation_data: Vec<u8>,
        consumed_override: Option<usize>,
    }

    struct FakeInitializer {
        state: Rc<RefCell<FakeState>>,
    }

    struct FakeContext {
        state: Rc<RefCell<FakeState>>,
        supplied_random_words: usize,
    }

    impl Drop for FakeContext {
        fn drop(&mut self) {
            let mut state = self.state.borrow_mut();
            state.contexts_alive -= 1;
            state.context_drops += 1;
        }
    }

    impl SessionInitializer for FakeInitializer {
        fn initialize(
            &mut self,
            _certificate: &[u8],
            _hardware: &nac::HardwareConfig,
            random_words: Vec<u32>,
        ) -> Result<InitializedContext, OracleError> {
            let (fail, should_panic, session_request) = {
                let mut state = self.state.borrow_mut();
                state.initialize_calls += 1;
                if state.contexts_alive != 0 {
                    state.initialized_while_context_alive = true;
                }
                (
                    state.fail_initialize,
                    state.panic_initialize,
                    state.session_request.clone(),
                )
            };
            if should_panic {
                panic!("fake initializer panic");
            }
            if fail {
                return Err(OracleError::new(
                    "nac_execution_failed",
                    "fake initializer failure",
                ));
            }
            self.state.borrow_mut().contexts_alive += 1;
            Ok(InitializedContext {
                context: Box::new(FakeContext {
                    state: self.state.clone(),
                    supplied_random_words: random_words.len(),
                }),
                session_info_request: session_request,
            })
        }
    }

    impl PendingNacContext for FakeContext {
        fn complete(self: Box<Self>, session_info: &[u8]) -> Result<NativeCompletion, OracleError> {
            let (fail, should_panic, validation_data, consumed_override) = {
                let mut state = self.state.borrow_mut();
                state.complete_calls += 1;
                (
                    state.fail_complete,
                    state.panic_complete,
                    state.validation_data.clone(),
                    state.consumed_override,
                )
            };
            if should_panic {
                panic!("fake completion panic");
            }
            if fail || session_info != [2] {
                return Err(OracleError::new(
                    "nac_execution_failed",
                    "fake completion failure",
                ));
            }
            Ok(NativeCompletion {
                validation_data,
                arc4random_words_consumed: consumed_override.unwrap_or(self.supplied_random_words),
            })
        }
    }

    fn server_with_fake() -> (OracleSessionServer, Rc<RefCell<FakeState>>) {
        let state = Rc::new(RefCell::new(FakeState {
            session_request: vec![0x11, 0x12],
            validation_data: vec![0x33, 0x34],
            ..FakeState::default()
        }));
        let server = OracleSessionServer::with_initializer(Box::new(FakeInitializer {
            state: state.clone(),
        }));
        (server, state)
    }

    fn synthetic_hardware() -> Value {
        serde_json::from_str::<Value>(&request()).unwrap()["hardware"].clone()
    }

    fn initialize_request(request_id: &str, replace_pending: bool) -> Value {
        serde_json::json!({
            "schema_version": SCHEMA_VERSION,
            "request_id": request_id,
            "operation": "initialize_nac_validation",
            "cert_chain_base64": "AQ==",
            "hardware": synthetic_hardware(),
            "arc4random_words": [7, 8, 9],
            "replace_pending": replace_pending
        })
    }

    fn complete_request(request_id: &str, session_id: &str, session_info: &str) -> Value {
        serde_json::json!({
            "schema_version": SCHEMA_VERSION,
            "request_id": request_id,
            "operation": "complete_nac_validation",
            "session_id": session_id,
            "session_info_base64": session_info
        })
    }

    fn cancel_request(request_id: &str, session_id: &str) -> Value {
        serde_json::json!({
            "schema_version": SCHEMA_VERSION,
            "request_id": request_id,
            "operation": "cancel_nac_validation",
            "session_id": session_id
        })
    }

    fn process_json(server: &mut OracleSessionServer, request: &Value) -> Value {
        serde_json::from_str(&server.process_line(&request.to_string())).unwrap()
    }

    fn initialize_and_get_id(server: &mut OracleSessionServer) -> String {
        let response = process_json(server, &initialize_request("init", false));
        assert_eq!(response["ok"], true);
        response["result"]["session_id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn assert_code_only(response: &Value, code: &str) {
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], code);
        assert_eq!(response["error"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn two_stage_session_initializes_and_completes_the_same_context() {
        let (mut server, state) = server_with_fake();
        let initialize = process_json(&mut server, &initialize_request("init-1", false));
        assert_eq!(initialize["request_id"], "init-1");
        assert_eq!(initialize["result"]["session_info_request_base64"], "ERI=");
        let session_id = initialize["result"]["session_id"].as_str().unwrap();
        assert!(is_session_id(session_id));
        assert_eq!(state.borrow().contexts_alive, 1);

        let complete = process_json(
            &mut server,
            &complete_request("complete-1", session_id, "Ag=="),
        );
        assert_eq!(complete["ok"], true);
        assert_eq!(complete["request_id"], "complete-1");
        assert_eq!(complete["result"]["session_id"], session_id);
        assert_eq!(complete["result"]["validation_data_base64"], "MzQ=");
        assert_eq!(complete["result"]["arc4random_words_consumed"], 3);
        assert_eq!(complete["result"]["corten_commit"], CORTEN_COMMIT);
        assert_eq!(complete["result"]["nac_binary_sha1"], NAC_BINARY_SHA1);
        assert_eq!(complete["result"]["nac_binary_sha256"], NAC_BINARY_SHA256);
        assert_eq!(
            complete["result"]["nac_x86_64_slice_sha256"],
            NAC_X86_64_SLICE_SHA256
        );
        let state = state.borrow();
        assert_eq!(state.initialize_calls, 1);
        assert_eq!(state.complete_calls, 1);
        assert_eq!(state.contexts_alive, 0);
        assert_eq!(state.context_drops, 1);
    }

    #[test]
    fn only_one_context_is_live_and_replacement_drops_it_before_initializing() {
        let (mut server, state) = server_with_fake();
        let first_id = initialize_and_get_id(&mut server);

        let rejected = process_json(&mut server, &initialize_request("second", false));
        assert_code_only(&rejected, "pending_context_exists");
        assert_eq!(state.borrow().initialize_calls, 1);
        assert_eq!(state.borrow().contexts_alive, 1);

        let replaced = process_json(&mut server, &initialize_request("replacement", true));
        assert_eq!(replaced["ok"], true);
        let replacement_id = replaced["result"]["session_id"].as_str().unwrap();
        assert_ne!(replacement_id, first_id);
        let state_snapshot = state.borrow();
        assert_eq!(state_snapshot.initialize_calls, 2);
        assert_eq!(state_snapshot.contexts_alive, 1);
        assert_eq!(state_snapshot.context_drops, 1);
        assert!(!state_snapshot.initialized_while_context_alive);
        drop(state_snapshot);

        let cancelled = process_json(&mut server, &cancel_request("cancel", replacement_id));
        assert_eq!(cancelled["result"]["cancelled"], true);
        assert_eq!(state.borrow().contexts_alive, 0);
        assert_eq!(state.borrow().context_drops, 2);
    }

    #[test]
    fn mismatch_and_invalid_session_info_preserve_pending_context() {
        let (mut server, state) = server_with_fake();
        let active_id = initialize_and_get_id(&mut server);
        let wrong_id = session_id(999);

        let mismatch = process_json(&mut server, &complete_request("wrong", &wrong_id, "Ag=="));
        assert_code_only(&mismatch, "session_id_mismatch");
        assert_eq!(state.borrow().contexts_alive, 1);
        assert_eq!(state.borrow().complete_calls, 0);

        let invalid = process_json(
            &mut server,
            &complete_request("bad-base64", &active_id, "Ag"),
        );
        assert_code_only(&invalid, "invalid_base64");
        assert_eq!(state.borrow().contexts_alive, 1);
        assert_eq!(state.borrow().complete_calls, 0);

        let complete = process_json(&mut server, &complete_request("good", &active_id, "Ag=="));
        assert_eq!(complete["ok"], true);
    }

    #[test]
    fn cancellation_requires_the_matching_session_and_drops_the_context() {
        let (mut server, state) = server_with_fake();
        let no_pending = process_json(&mut server, &cancel_request("none", &session_id(1)));
        assert_code_only(&no_pending, "no_pending_context");

        let active_id = initialize_and_get_id(&mut server);
        let mismatch = process_json(&mut server, &cancel_request("wrong", &session_id(999)));
        assert_code_only(&mismatch, "session_id_mismatch");
        assert_eq!(state.borrow().contexts_alive, 1);

        let cancelled = process_json(&mut server, &cancel_request("right", &active_id));
        assert_eq!(cancelled["result"]["session_id"], active_id);
        assert_eq!(cancelled["result"]["cancelled"], true);
        assert_eq!(state.borrow().contexts_alive, 0);
        assert_eq!(state.borrow().context_drops, 1);

        let again = process_json(&mut server, &cancel_request("again", &active_id));
        assert_code_only(&again, "no_pending_context");
    }

    #[test]
    fn a_native_completion_attempt_consumes_context_on_error_or_panic() {
        for panic_complete in [false, true] {
            let (mut server, state) = server_with_fake();
            let session_id = initialize_and_get_id(&mut server);
            state.borrow_mut().fail_complete = !panic_complete;
            state.borrow_mut().panic_complete = panic_complete;
            let response = process_json(
                &mut server,
                &complete_request("complete", &session_id, "Ag=="),
            );
            assert_code_only(
                &response,
                if panic_complete {
                    "nac_execution_panicked"
                } else {
                    "nac_execution_failed"
                },
            );
            assert_eq!(state.borrow().contexts_alive, 0);
            assert_eq!(state.borrow().context_drops, 1);
            let retry = process_json(&mut server, &complete_request("retry", &session_id, "Ag=="));
            assert_code_only(&retry, "no_pending_context");
        }
    }

    #[test]
    fn failed_or_panicking_replacement_leaves_no_pending_context() {
        for panic_initialize in [false, true] {
            let (mut server, state) = server_with_fake();
            let old_id = initialize_and_get_id(&mut server);
            state.borrow_mut().fail_initialize = !panic_initialize;
            state.borrow_mut().panic_initialize = panic_initialize;
            let response = process_json(&mut server, &initialize_request("replace", true));
            assert_code_only(
                &response,
                if panic_initialize {
                    "nac_execution_panicked"
                } else {
                    "nac_execution_failed"
                },
            );
            assert_eq!(state.borrow().contexts_alive, 0);
            assert_eq!(state.borrow().context_drops, 1);
            let retry = process_json(&mut server, &complete_request("old", &old_id, "Ag=="));
            assert_code_only(&retry, "no_pending_context");
        }
    }

    #[test]
    fn strict_requests_reject_unknown_fields_and_malformed_hardware() {
        let (mut server, state) = server_with_fake();
        let mut unknown = initialize_request("unknown", false);
        unknown["credential"] = Value::String("must-not-be-accepted".to_string());
        let response = process_json(&mut server, &unknown);
        assert_code_only(&response, "invalid_request");
        assert_eq!(state.borrow().initialize_calls, 0);

        let mut malformed_hardware = initialize_request("hardware", false);
        malformed_hardware["hardware"]["platform_uuid"] = Value::String("not-a-uuid".to_string());
        let response = process_json(&mut server, &malformed_hardware);
        assert_code_only(&response, "invalid_hardware");
        assert_eq!(state.borrow().initialize_calls, 0);

        let mut complete = complete_request("complete", &session_id(1), "Ag==");
        complete["password"] = Value::String("must-not-be-accepted".to_string());
        assert_code_only(&process_json(&mut server, &complete), "invalid_request");
    }

    #[test]
    fn protocol_bounds_are_enforced_and_failed_native_outputs_are_cleaned_up() {
        let (mut server, state) = server_with_fake();
        let mut too_many_words = initialize_request("words", false);
        too_many_words["arc4random_words"] =
            serde_json::to_value(vec![0_u32; MAX_RANDOM_WORDS + 1]).unwrap();
        assert_code_only(
            &process_json(&mut server, &too_many_words),
            "invalid_random_words",
        );
        assert_eq!(state.borrow().initialize_calls, 0);

        state.borrow_mut().session_request = Vec::new();
        assert_code_only(
            &process_json(&mut server, &initialize_request("empty", false)),
            "nac_execution_failed",
        );
        assert_eq!(state.borrow().contexts_alive, 0);
        assert_eq!(state.borrow().context_drops, 1);

        state.borrow_mut().session_request = vec![1];
        state.borrow_mut().validation_data = vec![2];
        state.borrow_mut().consumed_override = Some(MAX_RANDOM_WORDS + 1);
        let session_id = initialize_and_get_id(&mut server);
        assert_code_only(
            &process_json(
                &mut server,
                &complete_request("consumed", &session_id, "Ag=="),
            ),
            "nac_execution_failed",
        );
        assert_eq!(state.borrow().contexts_alive, 0);
        assert_eq!(state.borrow().context_drops, 2);
    }

    #[test]
    fn dropping_the_server_drops_its_pending_native_context() {
        let state = {
            let (mut server, state) = server_with_fake();
            initialize_and_get_id(&mut server);
            assert_eq!(state.borrow().contexts_alive, 1);
            state
        };
        assert_eq!(state.borrow().contexts_alive, 0);
        assert_eq!(state.borrow().context_drops, 1);
    }

    #[test]
    fn stateful_errors_are_code_only_but_atomic_errors_remain_compatible() {
        let (mut server, _) = server_with_fake();
        let mut unsupported = initialize_request("schema", false);
        unsupported["schema_version"] = serde_json::json!(2);
        let response = process_json(&mut server, &unsupported);
        assert_code_only(&response, "unsupported_schema_version");

        let atomic: Value =
            serde_json::from_str(&process_line_with_binary_path(&request(), None)).unwrap();
        assert_eq!(atomic["error"]["code"], "nac_binary_not_configured");
        assert!(atomic["error"]["message"].is_string());
    }

    #[test]
    fn stateless_compatibility_helper_never_returns_an_unusable_session() {
        let response: Value = serde_json::from_str(&process_line(
            &initialize_request("init", false).to_string(),
        ))
        .unwrap();
        assert_code_only(&response, "stateful_server_required");
    }
}
