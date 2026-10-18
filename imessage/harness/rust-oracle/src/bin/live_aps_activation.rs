use std::{env, path::Path, process::ExitCode, sync::RwLock, time::Duration};

use imessage_rust_oracle::{
    live_aps_activation::{parse_hardware_only_input, read_owner_only_input},
    RUSTPUSH_COMMIT, SCHEMA_VERSION,
};
use keystore::{
    init_keystore,
    software::{NoEncryptor, SoftwareKeystore, SoftwareKeystoreState},
    KeystorePublicKey,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

const INPUT_ENV: &str = "IMESSAGE_RUST_LIVE_APS_INPUT";

#[derive(Serialize)]
struct ResultLine {
    schema_version: u32,
    rustpush_commit: &'static str,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    certificate_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    certificate_length: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    public_key_der_sha256: Option<String>,
}

fn line(status: &'static str, error_code: Option<&'static str>) -> ResultLine {
    ResultLine {
        schema_version: SCHEMA_VERSION,
        rustpush_commit: RUSTPUSH_COMMIT,
        status,
        error_code,
        certificate_sha256: None,
        certificate_length: None,
        public_key_der_sha256: None,
    }
}

fn emit(result: &ResultLine) {
    println!(
        "{}",
        serde_json::to_string(result).expect("fixed result must serialize")
    );
}

fn read_input() -> Result<Vec<u8>, &'static str> {
    let path = env::var_os(INPUT_ENV).ok_or("input_path_missing")?;
    read_owner_only_input(Path::new(&path))
}

fn digest_hex(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn classify(error: &rustpush::PushError) -> &'static str {
    match error {
        rustpush::PushError::AlbertCertParseError => "albert_certificate_rejected",
        rustpush::PushError::RequestError(_) => "transport_failure",
        rustpush::PushError::PlistError(_) => "albert_protocol_invalid",
        rustpush::PushError::SSLError(_) | rustpush::PushError::KeystoreError(_) => {
            "local_crypto_failure"
        }
        _ => "rustpush_activation_failure",
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    std::panic::set_hook(Box::new(|_| {
        eprintln!("live APS oracle terminated unexpectedly");
    }));

    let mut raw = match read_input() {
        Ok(value) => value,
        Err(code) => {
            emit(&line("input_rejected", Some(code)));
            return ExitCode::from(2);
        }
    };
    let parsed = parse_hardware_only_input(&raw);
    raw.fill(0);
    let config = match parsed {
        Ok(value) => value,
        Err(_) => {
            emit(&line("input_rejected", Some("hardware_input_invalid")));
            return ExitCode::from(2);
        }
    };

    init_keystore(SoftwareKeystore {
        state: RwLock::new(SoftwareKeystoreState::default()),
        update_state: Box::new(|_| {}),
        encryptor: NoEncryptor,
    });

    let mut task = tokio::spawn(async move { rustpush::port_oracle_activate(&config).await });
    let result = match tokio::time::timeout(Duration::from_secs(30), &mut task).await {
        Err(_) => {
            task.abort();
            emit(&line("rejected", Some("timeout")));
            return ExitCode::SUCCESS;
        }
        Ok(Err(_)) => {
            emit(&line("failed", Some("rustpush_panic")));
            return ExitCode::from(3);
        }
        Ok(Ok(result)) => result,
    };

    match result {
        Ok(identity) => match identity.private.get_public_key() {
            Ok(public_key) => {
                let mut accepted = line("accepted", None);
                accepted.certificate_sha256 = Some(digest_hex(&identity.cert));
                accepted.certificate_length = Some(identity.cert.len());
                accepted.public_key_der_sha256 = Some(digest_hex(&public_key));
                emit(&accepted);
                ExitCode::SUCCESS
            }
            Err(_) => {
                emit(&line("failed", Some("public_key_unavailable")));
                ExitCode::from(3)
            }
        },
        Err(error) => {
            emit(&line("rejected", Some(classify(&error))));
            ExitCode::SUCCESS
        }
    }
}
