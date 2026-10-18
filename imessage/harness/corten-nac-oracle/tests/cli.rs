use std::io::Write;
use std::process::{Command, Stdio};

use corten_nac_oracle::{MAX_REQUEST_LINE_BYTES, NAC_BINARY_ENV};
use serde_json::Value;

#[test]
fn cli_survives_bad_input_and_never_discovers_a_binary_implicitly() {
    let request = serde_json::json!({
        "schema_version": 1,
        "request_id": "nac-cli",
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
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_corten-nac-oracle"))
        .env_remove(NAC_BINARY_ENV)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{{").unwrap();
    stdin
        .write_all(&vec![b'x'; MAX_REQUEST_LINE_BYTES + 1])
        .unwrap();
    writeln!(stdin).unwrap();
    writeln!(stdin, "{request}").unwrap();
    drop(stdin);

    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let responses = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 3);
    assert_eq!(responses[0]["error"]["code"], "invalid_request");
    assert_eq!(responses[1]["error"]["code"], "invalid_request");
    assert_eq!(responses[1]["request_id"], Value::Null);
    assert_eq!(responses[2]["request_id"], "nac-cli");
    assert_eq!(responses[2]["error"]["code"], "nac_binary_not_configured");
}
