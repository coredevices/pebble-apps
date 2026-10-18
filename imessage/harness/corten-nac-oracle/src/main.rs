use std::io::{self, BufRead, Write};

use corten_nac_oracle::{oversized_request_response, OracleSessionServer, MAX_REQUEST_LINE_BYTES};

#[derive(Debug, Eq, PartialEq)]
enum BoundedLine {
    Eof,
    Line(String),
    TooLong,
}

fn read_bounded_line<R: BufRead>(reader: &mut R, maximum: usize) -> io::Result<BoundedLine> {
    let mut bytes = Vec::new();
    let mut saw_input = false;
    let mut too_long = false;

    loop {
        let (consumed, reached_newline) = {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                if !saw_input {
                    return Ok(BoundedLine::Eof);
                }
                if too_long {
                    return Ok(BoundedLine::TooLong);
                }
                let line = String::from_utf8(bytes)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                return Ok(BoundedLine::Line(line));
            }
            saw_input = true;

            let newline = available.iter().position(|byte| *byte == b'\n');
            let segment_end = newline.unwrap_or(available.len());
            if !too_long {
                if segment_end > maximum.saturating_sub(bytes.len()) {
                    too_long = true;
                } else {
                    bytes.extend_from_slice(&available[..segment_end]);
                }
            }
            (
                newline.map_or(available.len(), |position| position + 1),
                newline.is_some(),
            )
        };
        reader.consume(consumed);

        if reached_newline {
            if too_long {
                return Ok(BoundedLine::TooLong);
            }
            let line = String::from_utf8(bytes)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            return Ok(BoundedLine::Line(line));
        }
    }
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut input = stdin.lock();
    let mut server = OracleSessionServer::from_environment();
    loop {
        let response = match read_bounded_line(&mut input, MAX_REQUEST_LINE_BYTES)? {
            BoundedLine::Eof => break,
            BoundedLine::Line(line) if line.trim().is_empty() => continue,
            BoundedLine::Line(line) => server.process_line(&line),
            BoundedLine::TooLong => oversized_request_response(),
        };
        writeln!(stdout, "{response}")?;
        stdout.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn drains_an_oversized_line_without_buffering_it_then_reads_the_next_line() {
        let mut input = Cursor::new(b"123456789\nok\n".to_vec());
        assert_eq!(
            read_bounded_line(&mut input, 4).unwrap(),
            BoundedLine::TooLong
        );
        assert_eq!(
            read_bounded_line(&mut input, 4).unwrap(),
            BoundedLine::Line("ok".to_string())
        );
        assert_eq!(read_bounded_line(&mut input, 4).unwrap(), BoundedLine::Eof);
    }

    #[test]
    fn accepts_a_line_exactly_at_the_limit_without_a_trailing_newline() {
        let mut input = Cursor::new(b"1234".to_vec());
        assert_eq!(
            read_bounded_line(&mut input, 4).unwrap(),
            BoundedLine::Line("1234".to_string())
        );
        assert_eq!(read_bounded_line(&mut input, 4).unwrap(), BoundedLine::Eof);
    }
}
