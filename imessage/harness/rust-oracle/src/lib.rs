use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use hmac::Hmac;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use srp::{client::SrpClient, groups::G_2048};

pub const SCHEMA_VERSION: u32 = 1;
pub const RUSTPUSH_COMMIT: &str = "a7fab473e7a33325a760635285db2860de8e1cb0";

#[cfg(feature = "live-aps-activation")]
pub mod live_aps_activation;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RawField {
    pub id: u8,
    pub value: Vec<u8>,
}

pub fn encode_raw_aps(command: u8, fields: &[RawField]) -> Result<Vec<u8>, String> {
    let fields = fields
        .iter()
        .map(|field| (field.id, field.value.clone()))
        .collect::<Vec<_>>();
    rustpush::port_oracle_encode_raw(command, &fields).map_err(|error| error.to_string())
}

#[derive(Debug, Deserialize)]
struct Request {
    schema_version: u32,
    request_id: Value,
    #[serde(flatten)]
    operation: Operation,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum Operation {
    EncodeRawAps {
        command: u8,
        #[serde(default)]
        fields: Vec<FieldRequest>,
    },
    EncodePackedAps {
        #[serde(default = "default_value_cache_size")]
        value_cache_size: usize,
        messages: Vec<PackedMessageRequest>,
    },
    DecodePackedAps {
        #[serde(default = "default_value_cache_size")]
        value_cache_size: usize,
        frames_base64: Vec<String>,
    },
    SerializeApsActivationRequest {
        activation_randomness: String,
        build_version: String,
        device_cert_request_base64: String,
        device_class: String,
        product_type: String,
        product_version: String,
        serial_number: String,
        unique_device_id: String,
        fair_play_cert_chain_base64: String,
        fair_play_signature_base64: String,
    },
    EncodeIdsPlistIntegers {
        command: u8,
        message_id: i32,
        original_epoch_nanos: String,
        status: i64,
    },
    GroupIdsSendPayloads {
        payload_lengths: Vec<usize>,
    },
    CompleteAppleSrp {
        username: String,
        password_hash_base64: String,
        protocol: String,
        salt_base64: String,
        iterations: u32,
        private_ephemeral_base64: String,
        server_public_base64: String,
    },
    ComposeNgmPairEc {
        body_base64: String,
        counter: u32,
        padding_base64: String,
        secret_base64: String,
        sender_device_base64: String,
        target_device_base64: String,
        target_prekey_base64: String,
        ephemeral_base64: String,
        signature_base64: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FieldRequest {
    id: u8,
    value_base64: String,
}

fn default_value_cache_size() -> usize {
    0x1000
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PackedMessageRequest {
    command: u8,
    attributes: Vec<PackedAttributeRequest>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PackedAttributeRequest {
    id_base64: String,
    value: PackedValueRequest,
    cached: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum PackedValueRequest {
    Data { value_base64: String },
    String { value: String },
    Int { value: I64Request },
    Dictionary { value: Vec<PackedAttributeRequest> },
    Array { value: Vec<PackedValueRequest> },
    Bool { value: bool },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum I64Request {
    Number(i64),
    String(String),
}

#[derive(Clone, Debug, Serialize)]
struct PackedMessageResponse {
    command: u8,
    attributes: Vec<PackedAttributeResponse>,
}

#[derive(Clone, Debug, Serialize)]
struct PackedAttributeResponse {
    id_base64: String,
    value: PackedValueResponse,
    cached: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum PackedValueResponse {
    Data { value_base64: String },
    String { value: String },
    Int { value: String },
    Dictionary { value: Vec<PackedAttributeResponse> },
    Array { value: Vec<PackedValueResponse> },
    Bool { value: bool },
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
    Success { ok: bool, result: OracleResult },
    Failure { ok: bool, error: ErrorBody },
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum OracleResult {
    RawEncode(EncodeResult),
    PackedEncode(PackedEncodeResult),
    PackedDecode(PackedDecodeResult),
    ApsActivation(ApsActivationResult),
    PlistEncode(PlistEncodeResult),
    SendBatching(SendBatchingResult),
    AppleSrp(AppleSrpResult),
    NgmPairEc(NgmPairEcResult),
}

#[derive(Debug, Serialize)]
struct EncodeResult {
    frame_base64: String,
    byte_length: usize,
    rustpush_commit: &'static str,
}

#[derive(Debug, Serialize)]
struct PackedEncodeResult {
    frames_base64: Vec<String>,
    byte_lengths: Vec<usize>,
    rustpush_commit: &'static str,
}

#[derive(Debug, Serialize)]
struct PackedDecodeResult {
    messages: Vec<PackedMessageResponse>,
    rustpush_commit: &'static str,
}

#[derive(Debug, Serialize)]
struct PlistEncodeResult {
    plist_base64: String,
    byte_length: usize,
    command_plist_base64: String,
    message_id_plist_base64: String,
    original_epoch_nanos_plist_base64: String,
    status_plist_base64: String,
    rustpush_commit: &'static str,
}

#[derive(Debug, Serialize)]
struct ApsActivationResult {
    activation_info_xml_base64: String,
    outer_xml_base64: String,
    form_body_base64: String,
    rustpush_commit: &'static str,
}

#[derive(Debug, Serialize)]
struct IdsPlistIntegerFixture {
    #[serde(rename = "c")]
    command: u8,
    #[serde(rename = "i")]
    message_id: i32,
    #[serde(rename = "oe")]
    original_epoch_nanos: u64,
    #[serde(rename = "s")]
    status: i64,
}

#[derive(Debug, Serialize)]
struct SendBatchingResult {
    group_max_size: usize,
    batches: Vec<SendBatch>,
    rustpush_commit: &'static str,
}

#[derive(Debug, Serialize)]
struct SendBatch {
    fcn: u8,
    target_indexes: Vec<usize>,
    payload_bytes: usize,
}

#[derive(Debug, Serialize)]
struct NgmPairEcResult {
    outer_base64: String,
    inner_base64: String,
    cleartext_base64: String,
    ciphertext_base64: String,
    signature_data_base64: String,
    validator_base64: String,
    rustpush_commit: &'static str,
}

#[derive(Debug, Serialize)]
struct AppleSrpResult {
    public_ephemeral_base64: String,
    proof_base64: String,
    expected_server_proof_base64: String,
    session_key_base64: String,
    rustpush_commit: &'static str,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

pub fn process_line(line: &str) -> String {
    let value = match serde_json::from_str::<Value>(line) {
        Ok(value) => value,
        Err(error) => {
            return serialize_response(Response {
                schema_version: SCHEMA_VERSION,
                request_id: Value::Null,
                outcome: Outcome::Failure {
                    ok: false,
                    error: ErrorBody {
                        code: "invalid_request",
                        message: error.to_string(),
                    },
                },
            });
        }
    };
    let request_id = value.get("request_id").cloned().unwrap_or(Value::Null);

    match serde_json::from_value::<Request>(value) {
        Ok(request) => process_request(request),
        Err(error) => serialize_response(Response {
            schema_version: SCHEMA_VERSION,
            request_id,
            outcome: Outcome::Failure {
                ok: false,
                error: ErrorBody {
                    code: "invalid_request",
                    message: error.to_string(),
                },
            },
        }),
    }
}

fn process_request(request: Request) -> String {
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

    match request.operation {
        Operation::EncodeRawAps { command, fields } => {
            let fields = fields
                .into_iter()
                .map(|field| {
                    BASE64_STANDARD
                        .decode(&field.value_base64)
                        .map(|value| RawField {
                            id: field.id,
                            value,
                        })
                        .map_err(|error| {
                            format!("field {} has invalid value_base64: {error}", field.id)
                        })
                })
                .collect::<Result<Vec<_>, _>>();

            let fields = match fields {
                Ok(fields) => fields,
                Err(message) => return failure(request.request_id, "invalid_base64", message),
            };

            match encode_raw_aps(command, &fields) {
                Ok(frame) => serialize_response(Response {
                    schema_version: SCHEMA_VERSION,
                    request_id: request.request_id,
                    outcome: Outcome::Success {
                        ok: true,
                        result: OracleResult::RawEncode(EncodeResult {
                            frame_base64: BASE64_STANDARD.encode(&frame),
                            byte_length: frame.len(),
                            rustpush_commit: RUSTPUSH_COMMIT,
                        }),
                    },
                }),
                Err(error) => failure(request.request_id, "encode_failed", error),
            }
        }
        Operation::EncodePackedAps {
            value_cache_size,
            messages,
        } => {
            let messages = match messages
                .into_iter()
                .map(convert_packed_message_request)
                .collect::<Result<Vec<_>, _>>()
            {
                Ok(messages) => messages,
                Err(message) => {
                    return failure(request.request_id, "invalid_packed_value", message)
                }
            };
            match rustpush::port_oracle_encode_packed(&messages, value_cache_size) {
                Ok(frames) => serialize_response(Response {
                    schema_version: SCHEMA_VERSION,
                    request_id: request.request_id,
                    outcome: Outcome::Success {
                        ok: true,
                        result: OracleResult::PackedEncode(PackedEncodeResult {
                            byte_lengths: frames.iter().map(Vec::len).collect(),
                            frames_base64: frames
                                .iter()
                                .map(|frame| BASE64_STANDARD.encode(frame))
                                .collect(),
                            rustpush_commit: RUSTPUSH_COMMIT,
                        }),
                    },
                }),
                Err(error) => failure(request.request_id, "encode_failed", error.to_string()),
            }
        }
        Operation::DecodePackedAps {
            value_cache_size,
            frames_base64,
        } => {
            let frames = frames_base64
                .into_iter()
                .map(|frame| {
                    BASE64_STANDARD
                        .decode(frame)
                        .map_err(|error| error.to_string())
                })
                .collect::<Result<Vec<_>, _>>();
            let frames = match frames {
                Ok(frames) => frames,
                Err(message) => return failure(request.request_id, "invalid_base64", message),
            };
            match rustpush::port_oracle_decode_packed(&frames, value_cache_size) {
                Ok(messages) => serialize_response(Response {
                    schema_version: SCHEMA_VERSION,
                    request_id: request.request_id,
                    outcome: Outcome::Success {
                        ok: true,
                        result: OracleResult::PackedDecode(PackedDecodeResult {
                            messages: messages
                                .into_iter()
                                .map(convert_packed_message_response)
                                .collect(),
                            rustpush_commit: RUSTPUSH_COMMIT,
                        }),
                    },
                }),
                Err(error) => failure(request.request_id, "decode_failed", error.to_string()),
            }
        }
        Operation::SerializeApsActivationRequest {
            activation_randomness,
            build_version,
            device_cert_request_base64,
            device_class,
            product_type,
            product_version,
            serial_number,
            unique_device_id,
            fair_play_cert_chain_base64,
            fair_play_signature_base64,
        } => {
            let decoded = [
                ("device_cert_request_base64", device_cert_request_base64),
                ("fair_play_cert_chain_base64", fair_play_cert_chain_base64),
                ("fair_play_signature_base64", fair_play_signature_base64),
            ]
            .into_iter()
            .map(|(name, value)| {
                BASE64_STANDARD
                    .decode(value)
                    .map_err(|error| format!("{name} is invalid: {error}"))
            })
            .collect::<Result<Vec<_>, _>>();
            let decoded = match decoded {
                Ok(decoded) if decoded.iter().all(|value| !value.is_empty()) => decoded,
                Ok(_) => {
                    return failure(
                        request.request_id,
                        "invalid_activation_input",
                        "activation byte fields cannot be empty".to_string(),
                    )
                }
                Err(message) => return failure(request.request_id, "invalid_base64", message),
            };
            let activation = rustpush::PortOracleActivationInfo {
                activation_randomness,
                activation_state: "Unactivated",
                build_version,
                device_cert_request: decoded[0].clone().into(),
                device_class,
                product_type,
                product_version,
                serial_number,
                unique_device_id,
            };
            match rustpush::port_oracle_serialize_activation_request(
                activation,
                decoded[1].clone(),
                decoded[2].clone(),
            ) {
                Ok(serialized) => serialize_response(Response {
                    schema_version: SCHEMA_VERSION,
                    request_id: request.request_id,
                    outcome: Outcome::Success {
                        ok: true,
                        result: OracleResult::ApsActivation(ApsActivationResult {
                            activation_info_xml_base64: BASE64_STANDARD
                                .encode(serialized.activation_info_xml),
                            outer_xml_base64: BASE64_STANDARD.encode(serialized.outer_xml),
                            form_body_base64: BASE64_STANDARD.encode(serialized.form_body),
                            rustpush_commit: RUSTPUSH_COMMIT,
                        }),
                    },
                }),
                Err(error) => failure(
                    request.request_id,
                    "activation_serialize_failed",
                    error.to_string(),
                ),
            }
        }
        Operation::EncodeIdsPlistIntegers {
            command,
            message_id,
            original_epoch_nanos,
            status,
        } => {
            let parse_u64 = |name: &str, value: String| -> Result<u64, String> {
                let parsed = value
                    .parse::<u64>()
                    .map_err(|error| format!("{name} is invalid: {error}"))?;
                if parsed.to_string() != value {
                    return Err(format!("{name} must use canonical unsigned decimal"));
                }
                Ok(parsed)
            };
            let original_epoch_nanos = match parse_u64("original_epoch_nanos", original_epoch_nanos)
            {
                Ok(value) => value,
                Err(message) => {
                    return failure(request.request_id, "invalid_plist_integer", message)
                }
            };
            let fixture = IdsPlistIntegerFixture {
                command,
                message_id,
                original_epoch_nanos,
                status,
            };
            let mut encoded = Vec::new();
            let mut command_encoded = Vec::new();
            let mut message_id_encoded = Vec::new();
            let mut original_epoch_nanos_encoded = Vec::new();
            let mut status_encoded = Vec::new();
            let encoded_result = plist::to_writer_binary(&mut encoded, &fixture)
                .and_then(|()| plist::to_writer_binary(&mut command_encoded, &command))
                .and_then(|()| plist::to_writer_binary(&mut message_id_encoded, &message_id))
                .and_then(|()| {
                    plist::to_writer_binary(
                        &mut original_epoch_nanos_encoded,
                        &original_epoch_nanos,
                    )
                })
                .and_then(|()| plist::to_writer_binary(&mut status_encoded, &status));
            match encoded_result {
                Ok(()) => serialize_response(Response {
                    schema_version: SCHEMA_VERSION,
                    request_id: request.request_id,
                    outcome: Outcome::Success {
                        ok: true,
                        result: OracleResult::PlistEncode(PlistEncodeResult {
                            plist_base64: BASE64_STANDARD.encode(&encoded),
                            byte_length: encoded.len(),
                            command_plist_base64: BASE64_STANDARD.encode(command_encoded),
                            message_id_plist_base64: BASE64_STANDARD.encode(message_id_encoded),
                            original_epoch_nanos_plist_base64: BASE64_STANDARD
                                .encode(original_epoch_nanos_encoded),
                            status_plist_base64: BASE64_STANDARD.encode(status_encoded),
                            rustpush_commit: RUSTPUSH_COMMIT,
                        }),
                    },
                }),
                Err(error) => failure(request.request_id, "encode_failed", error.to_string()),
            }
        }
        Operation::GroupIdsSendPayloads { payload_lengths } => {
            // Credential-free transcription of identity_manager.rs:1081-1105 at RUSTPUSH_COMMIT.
            // The production loop groups already-encrypted bundles, crossing 5,000 before flush.
            const GROUP_MAX_SIZE: usize = 5000;
            let mut groups = Vec::new();
            let mut group = Vec::new();
            let mut group_size = 0usize;
            for (index, payload_length) in payload_lengths.into_iter().enumerate() {
                group_size = match group_size.checked_add(payload_length) {
                    Some(size) => size,
                    None => {
                        return failure(
                            request.request_id,
                            "invalid_payload_length",
                            "payload length sum overflows usize".to_string(),
                        )
                    }
                };
                group.push(index);
                if group_size > GROUP_MAX_SIZE {
                    groups.push((std::mem::take(&mut group), group_size));
                    group_size = 0;
                }
            }
            if !group.is_empty() {
                groups.push((group, group_size));
            }
            let batches = match groups
                .into_iter()
                .enumerate()
                .map(|(index, (target_indexes, payload_bytes))| {
                    u8::try_from(index + 1)
                        .map(|fcn| SendBatch {
                            fcn,
                            target_indexes,
                            payload_bytes,
                        })
                        .map_err(|_| "send grouping exceeds the fcn u8 range")
                })
                .collect::<Result<Vec<_>, _>>()
            {
                Ok(batches) => batches,
                Err(message) => {
                    return failure(request.request_id, "too_many_batches", message.to_string())
                }
            };
            serialize_response(Response {
                schema_version: SCHEMA_VERSION,
                request_id: request.request_id,
                outcome: Outcome::Success {
                    ok: true,
                    result: OracleResult::SendBatching(SendBatchingResult {
                        group_max_size: GROUP_MAX_SIZE,
                        batches,
                        rustpush_commit: RUSTPUSH_COMMIT,
                    }),
                },
            })
        }
        Operation::CompleteAppleSrp {
            username,
            password_hash_base64,
            protocol,
            salt_base64,
            iterations,
            private_ephemeral_base64,
            server_public_base64,
        } => {
            let decoded = [
                ("password_hash_base64", password_hash_base64),
                ("salt_base64", salt_base64),
                ("private_ephemeral_base64", private_ephemeral_base64),
                ("server_public_base64", server_public_base64),
            ]
            .into_iter()
            .map(|(name, value)| {
                BASE64_STANDARD
                    .decode(value)
                    .map_err(|error| format!("{name} is invalid: {error}"))
            })
            .collect::<Result<Vec<_>, _>>();
            let decoded = match decoded {
                Ok(decoded) => decoded,
                Err(message) => return failure(request.request_id, "invalid_base64", message),
            };
            if username.is_empty()
                || decoded[0].len() != 32
                || decoded[2].is_empty()
                || decoded[3].is_empty()
                || iterations == 0
            {
                return failure(
                    request.request_id,
                    "invalid_srp_input",
                    "Apple SRP input is malformed".to_string(),
                );
            }
            let password_input = match protocol.as_str() {
                "s2k" => decoded[0].clone(),
                "s2k_fo" => decoded[0]
                    .iter()
                    .map(|value| format!("{value:02x}"))
                    .collect::<String>()
                    .into_bytes(),
                _ => {
                    return failure(
                        request.request_id,
                        "invalid_srp_input",
                        "Apple SRP protocol is unsupported".to_string(),
                    )
                }
            };
            let mut password = [0_u8; 32];
            pbkdf2::pbkdf2::<Hmac<Sha256>>(&password_input, &decoded[1], iterations, &mut password);
            let client = SrpClient::<Sha256>::new(&G_2048);
            let public_ephemeral = client.compute_public_ephemeral(&decoded[2]);
            let verifier = match client.process_reply(
                &decoded[2],
                username.as_bytes(),
                &password,
                &decoded[1],
                &decoded[3],
                true,
            ) {
                Ok(verifier) => verifier,
                Err(error) => return failure(request.request_id, "srp_failed", error.to_string()),
            };
            let proof = verifier.proof();
            let session_key = verifier.key();
            let server_proof = Sha256::new()
                .chain_update(&public_ephemeral)
                .chain_update(proof)
                .chain_update(session_key)
                .finalize();
            serialize_response(Response {
                schema_version: SCHEMA_VERSION,
                request_id: request.request_id,
                outcome: Outcome::Success {
                    ok: true,
                    result: OracleResult::AppleSrp(AppleSrpResult {
                        public_ephemeral_base64: BASE64_STANDARD.encode(public_ephemeral),
                        proof_base64: BASE64_STANDARD.encode(proof),
                        expected_server_proof_base64: BASE64_STANDARD.encode(server_proof),
                        session_key_base64: BASE64_STANDARD.encode(session_key),
                        rustpush_commit: RUSTPUSH_COMMIT,
                    }),
                },
            })
        }
        Operation::ComposeNgmPairEc {
            body_base64,
            counter,
            padding_base64,
            secret_base64,
            sender_device_base64,
            target_device_base64,
            target_prekey_base64,
            ephemeral_base64,
            signature_base64,
        } => {
            let decoded = [
                ("body_base64", body_base64),
                ("padding_base64", padding_base64),
                ("secret_base64", secret_base64),
                ("sender_device_base64", sender_device_base64),
                ("target_device_base64", target_device_base64),
                ("target_prekey_base64", target_prekey_base64),
                ("ephemeral_base64", ephemeral_base64),
                ("signature_base64", signature_base64),
            ]
            .into_iter()
            .map(|(name, value)| {
                BASE64_STANDARD
                    .decode(value)
                    .map_err(|error| format!("{name} is invalid: {error}"))
            })
            .collect::<Result<Vec<_>, _>>();
            let decoded = match decoded {
                Ok(decoded) => decoded,
                Err(message) => return failure(request.request_id, "invalid_base64", message),
            };
            match rustpush::port_oracle_compose_ngm_pair_ec(
                &decoded[0],
                counter,
                &decoded[1],
                &decoded[2],
                &decoded[3],
                &decoded[4],
                &decoded[5],
                &decoded[6],
                &decoded[7],
            ) {
                Ok(value) => serialize_response(Response {
                    schema_version: SCHEMA_VERSION,
                    request_id: request.request_id,
                    outcome: Outcome::Success {
                        ok: true,
                        result: OracleResult::NgmPairEc(NgmPairEcResult {
                            outer_base64: BASE64_STANDARD.encode(value.outer),
                            inner_base64: BASE64_STANDARD.encode(value.inner),
                            cleartext_base64: BASE64_STANDARD.encode(value.cleartext),
                            ciphertext_base64: BASE64_STANDARD.encode(value.ciphertext),
                            signature_data_base64: BASE64_STANDARD.encode(value.signature_data),
                            validator_base64: BASE64_STANDARD.encode(value.validator),
                            rustpush_commit: RUSTPUSH_COMMIT,
                        }),
                    },
                }),
                Err(error) => failure(request.request_id, "compose_failed", error.to_string()),
            }
        }
    }
}

fn convert_packed_message_request(
    message: PackedMessageRequest,
) -> Result<rustpush::PortOraclePackedMessage, String> {
    Ok(rustpush::PortOraclePackedMessage {
        command: message.command,
        attributes: message
            .attributes
            .into_iter()
            .map(convert_packed_attribute_request)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

fn convert_packed_attribute_request(
    attribute: PackedAttributeRequest,
) -> Result<rustpush::PortOraclePackedAttribute, String> {
    let id = BASE64_STANDARD
        .decode(&attribute.id_base64)
        .map_err(|error| format!("invalid packed attribute id: {error}"))?;
    if id.is_empty() {
        return Err("packed attribute id cannot be empty".to_string());
    }
    Ok(rustpush::PortOraclePackedAttribute {
        id,
        value: convert_packed_value_request(attribute.value)?,
        cached: attribute.cached,
    })
}

fn convert_packed_value_request(
    value: PackedValueRequest,
) -> Result<rustpush::PortOraclePackedValue, String> {
    Ok(match value {
        PackedValueRequest::Data { value_base64 } => rustpush::PortOraclePackedValue::Data(
            BASE64_STANDARD
                .decode(value_base64)
                .map_err(|error| format!("invalid packed data: {error}"))?,
        ),
        PackedValueRequest::String { value } => rustpush::PortOraclePackedValue::String(value),
        PackedValueRequest::Int { value } => rustpush::PortOraclePackedValue::Int(match value {
            I64Request::Number(value) => value,
            I64Request::String(value) => value
                .parse::<i64>()
                .map_err(|error| format!("invalid packed integer: {error}"))?,
        }),
        PackedValueRequest::Dictionary { value } => rustpush::PortOraclePackedValue::Dict(
            value
                .into_iter()
                .map(convert_packed_attribute_request)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        PackedValueRequest::Array { value } => rustpush::PortOraclePackedValue::Array(
            value
                .into_iter()
                .map(convert_packed_value_request)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        PackedValueRequest::Bool { value } => rustpush::PortOraclePackedValue::Bool(value),
    })
}

fn convert_packed_message_response(
    message: rustpush::PortOraclePackedMessage,
) -> PackedMessageResponse {
    PackedMessageResponse {
        command: message.command,
        attributes: message
            .attributes
            .into_iter()
            .map(convert_packed_attribute_response)
            .collect(),
    }
}

fn convert_packed_attribute_response(
    attribute: rustpush::PortOraclePackedAttribute,
) -> PackedAttributeResponse {
    PackedAttributeResponse {
        id_base64: BASE64_STANDARD.encode(attribute.id),
        value: convert_packed_value_response(attribute.value),
        cached: attribute.cached,
    }
}

fn convert_packed_value_response(value: rustpush::PortOraclePackedValue) -> PackedValueResponse {
    match value {
        rustpush::PortOraclePackedValue::Data(value) => PackedValueResponse::Data {
            value_base64: BASE64_STANDARD.encode(value),
        },
        rustpush::PortOraclePackedValue::String(value) => PackedValueResponse::String { value },
        rustpush::PortOraclePackedValue::Int(value) => PackedValueResponse::Int {
            value: value.to_string(),
        },
        rustpush::PortOraclePackedValue::Dict(value) => PackedValueResponse::Dictionary {
            value: value
                .into_iter()
                .map(convert_packed_attribute_response)
                .collect(),
        },
        rustpush::PortOraclePackedValue::Array(value) => PackedValueResponse::Array {
            value: value
                .into_iter()
                .map(convert_packed_value_response)
                .collect(),
        },
        rustpush::PortOraclePackedValue::Bool(value) => PackedValueResponse::Bool { value },
    }
}

fn failure(request_id: Value, code: &'static str, message: String) -> String {
    serialize_response(Response {
        schema_version: SCHEMA_VERSION,
        request_id,
        outcome: Outcome::Failure {
            ok: false,
            error: ErrorBody { code, message },
        },
    })
}

fn serialize_response(response: Response) -> String {
    serde_json::to_string(&response).expect("response serialization cannot fail")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_empty_ping_frame() {
        assert_eq!(encode_raw_aps(0x0c, &[]).unwrap(), [0x0c, 0, 0, 0, 0]);
    }

    #[test]
    fn encodes_fields_in_order_with_big_endian_lengths() {
        let encoded = encode_raw_aps(
            0x0b,
            &[
                RawField {
                    id: 1,
                    value: vec![0x00, 0xff],
                },
                RawField {
                    id: 4,
                    value: 42_i32.to_be_bytes().to_vec(),
                },
            ],
        )
        .unwrap();

        assert_eq!(
            encoded,
            [
                0x0b, 0, 0, 0, 12, // command and body length
                1, 0, 2, 0x00, 0xff, // field 1
                4, 0, 4, 0, 0, 0, 42, // field 4
            ]
        );
    }

    #[test]
    fn packed_oracle_preserves_stateful_value_and_key_caches() {
        let message = rustpush::PortOraclePackedMessage {
            command: 0x0a,
            attributes: vec![rustpush::PortOraclePackedAttribute {
                id: b"t".to_vec(),
                value: rustpush::PortOraclePackedValue::Data(vec![1, 2]),
                cached: true,
            }],
        };

        let frames =
            rustpush::port_oracle_encode_packed(&[message.clone(), message.clone()], 0x1000)
                .unwrap();
        assert_eq!(frames[0], [0x0a, 0x05, 0x50, 0x74, 0x02, 0x01, 0x02]);
        assert_eq!(frames[1], [0x0a, 0x02, 0xa0, 0x00]);
        assert_eq!(
            rustpush::port_oracle_decode_packed(&frames, 0x1000).unwrap(),
            [message.clone(), message]
        );
    }

    #[test]
    fn line_protocol_encodes_and_decodes_packed_sequences() {
        let encode_request = serde_json::json!({
            "schema_version": 1,
            "request_id": "packed-encode",
            "operation": "encode_packed_aps",
            "messages": [{
                "command": 10,
                "attributes": [{
                    "id_base64": "dA==",
                    "value": { "type": "data", "value_base64": "AQI=" },
                    "cached": true
                }]
            }, {
                "command": 10,
                "attributes": [{
                    "id_base64": "dA==",
                    "value": { "type": "data", "value_base64": "AQI=" },
                    "cached": true
                }]
            }]
        });
        let encoded: Value =
            serde_json::from_str(&process_line(&encode_request.to_string())).unwrap();
        assert_eq!(encoded["ok"], true);
        assert_eq!(encoded["result"]["byte_lengths"], serde_json::json!([7, 4]));

        let decode_request = serde_json::json!({
            "schema_version": 1,
            "request_id": "packed-decode",
            "operation": "decode_packed_aps",
            "frames_base64": encoded["result"]["frames_base64"]
        });
        let decoded: Value =
            serde_json::from_str(&process_line(&decode_request.to_string())).unwrap();
        assert_eq!(decoded["ok"], true);
        assert_eq!(
            decoded["result"]["messages"][1]["attributes"][0]["cached"],
            true
        );
        assert_eq!(
            decoded["result"]["messages"][1]["attributes"][0]["id_base64"],
            "dA=="
        );
    }

    #[test]
    fn line_protocol_encodes_ids_plist_integer_signedness() {
        let request = serde_json::json!({
            "schema_version": 1,
            "request_id": "ids-plist-integers",
            "operation": "encode_ids_plist_integers",
            "command": 255,
            "message_id": -1,
            "original_epoch_nanos": "18446744073709551615",
            "status": 5032
        });
        let response: Value = serde_json::from_str(&process_line(&request.to_string())).unwrap();
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["rustpush_commit"], RUSTPUSH_COMMIT);
    }

    #[test]
    fn line_protocol_models_pinned_ids_send_batching() {
        let request = serde_json::json!({
            "schema_version": 1,
            "request_id": "ids-send-batching",
            "operation": "group_ids_send_payloads",
            "payload_lengths": [2500, 2500, 1, 6000, 1]
        });
        let response: Value = serde_json::from_str(&process_line(&request.to_string())).unwrap();
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["group_max_size"], 5000);
        assert_eq!(response["result"]["batches"][0]["fcn"], 1);
        assert_eq!(
            response["result"]["batches"][0]["target_indexes"],
            serde_json::json!([0, 1, 2])
        );
    }

    #[test]
    fn rustpush_rejects_field_larger_than_wire_length() {
        let result = encode_raw_aps(
            0x0a,
            &[RawField {
                id: 3,
                value: vec![0; usize::from(u16::MAX) + 1],
            }],
        );

        assert!(result.is_err());
    }

    #[test]
    fn line_protocol_returns_encoded_frame_and_provenance() {
        let response = process_line(
            r#"{"schema_version":1,"request_id":"ping-1","operation":"encode_raw_aps","command":12,"fields":[]}"#,
        );
        let value: Value = serde_json::from_str(&response).unwrap();

        assert_eq!(value["request_id"], "ping-1");
        assert_eq!(value["ok"], true);
        assert_eq!(value["result"]["frame_base64"], "DAAAAAA=");
        assert_eq!(value["result"]["byte_length"], 5);
        assert_eq!(value["result"]["rustpush_commit"], RUSTPUSH_COMMIT);
    }

    #[test]
    fn line_protocol_rejects_invalid_base64_without_panicking() {
        let response = process_line(
            r#"{"schema_version":1,"request_id":7,"operation":"encode_raw_aps","command":10,"fields":[{"id":3,"value_base64":"***"}]}"#,
        );
        let value: Value = serde_json::from_str(&response).unwrap();

        assert_eq!(value["request_id"], 7);
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "invalid_base64");
    }

    #[test]
    fn malformed_json_has_a_machine_readable_error() {
        let response = process_line("{");
        let value: Value = serde_json::from_str(&response).unwrap();

        assert_eq!(value["request_id"], Value::Null);
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "invalid_request");
    }

    #[test]
    fn structurally_invalid_request_preserves_its_id() {
        let response =
            process_line(r#"{"schema_version":1,"request_id":"bad-op","operation":"unknown"}"#);
        let value: Value = serde_json::from_str(&response).unwrap();

        assert_eq!(value["request_id"], "bad-op");
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "invalid_request");
    }
}
