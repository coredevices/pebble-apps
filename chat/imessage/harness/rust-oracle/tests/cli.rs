use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::Value;

#[test]
fn processes_multiple_lines_and_survives_a_bad_request() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_imessage-rust-oracle"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{{").unwrap();
    writeln!(
        stdin,
        r#"{{"schema_version":1,"request_id":"next","operation":"encode_raw_aps","command":12}}"#
    )
    .unwrap();
    drop(stdin);

    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());

    let responses = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0]["error"]["code"], "invalid_request");
    assert_eq!(responses[1]["request_id"], "next");
    assert_eq!(responses[1]["result"]["frame_base64"], "DAAAAAA=");
}
