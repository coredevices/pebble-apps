use std::io::{self, BufRead, Write};

use imessage_rust_oracle::process_line;

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        writeln!(stdout, "{}", process_line(&line))?;
        stdout.flush()?;
    }

    Ok(())
}
