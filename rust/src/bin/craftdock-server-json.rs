use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

fn process(command: &str, path: &Path, input: &[u8]) -> io::Result<Vec<u8>> {
    match command {
        "read" => fs::read(path),
        "write" => {
            fs::write(path, input)?;
            Ok(Vec::new())
        }
        _ => Err(io::Error::new(io::ErrorKind::InvalidInput, "Unknown command")),
    }
}

fn main() {
    let mut args = env::args_os().skip(1);
    let Some(command) = args.next() else {
        eprintln!("Usage: craftdock-server-json <read|write> <path>");
        std::process::exit(2);
    };
    let Some(path) = args.next() else {
        eprintln!("Usage: craftdock-server-json <read|write> <path>");
        std::process::exit(2);
    };

    let command = command.to_string_lossy();
    let result = if command == "write" {
        let mut input = Vec::new();
        io::stdin().lock().read_to_end(&mut input).and_then(|_| {
            process(&command, Path::new(&path), &input)
        })
    } else {
        process(&command, Path::new(&path), &[])
    };
    match result {
        Ok(output) => {
            if !output.is_empty() {
                if let Err(error) = io::stdout().lock().write_all(&output) {
                    eprintln!("Could not process server JSON: {error}");
                    std::process::exit(1);
                }
            }
        }
        Err(error) => {
            eprintln!("Could not process server JSON: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_file() -> std::path::PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("craftdock-server-json-{stamp}.json"))
    }

    #[test]
    fn reads_exact_json_bytes() {
        let path = temp_file();
        let contents = b"[\n  {\"name\":\"world \\ud83c\\udf0d\"}\n]\n";
        fs::write(&path, contents).unwrap();
        assert_eq!(process("read", &path, &[]).unwrap(), contents);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn writes_exact_input_bytes_without_adding_a_newline() {
        let path = temp_file();
        let contents = b"{\n  \"name\": \"world\"\n}";
        process("write", &path, contents).unwrap();
        assert_eq!(fs::read(&path).unwrap(), contents);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn missing_read_path_returns_an_error() {
        assert!(process("read", &temp_file(), &[]).is_err());
    }
}
