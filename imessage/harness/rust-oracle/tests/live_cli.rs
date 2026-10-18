#![cfg(feature = "live-aps-activation")]

use std::process::Command;

use serde_json::Value;

#[test]
fn live_binary_rejects_missing_input_without_entering_the_network_path() {
    let output = Command::new(env!("CARGO_BIN_EXE_imessage-rust-live-aps-oracle"))
        .env_remove("IMESSAGE_RUST_LIVE_APS_INPUT")
        .output()
        .expect("live oracle must start");

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty());
    let value: Value = serde_json::from_slice(&output.stdout).expect("result must be JSON");
    assert_eq!(value["status"], "input_rejected");
    assert_eq!(value["error_code"], "input_path_missing");
    assert!(value.get("certificate_sha256").is_none());
    assert!(value.get("public_key_der_sha256").is_none());
}
