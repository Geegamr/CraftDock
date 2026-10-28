use serde_json::json;
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::Path;

fn js_trim(value: &str) -> &str {
    value.trim_matches(|character: char| {
        matches!(character,
            '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' |
            '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' |
            '\u{205F}' | '\u{3000}' | '\u{FEFF}')
    })
}

fn parse_properties(contents: &str) -> serde_json::Value {
    let entries = contents
        .split('\n')
        .filter_map(|line| {
            let equals = line.find('=')?;
            if equals == 0 || line.starts_with('#') {
                return None;
            }
            Some((js_trim(&line[..equals]), js_trim(&line[equals + 1..])))
        })
        .collect::<Vec<_>>();
    json!(entries)
}

fn read_properties(path: &Path) -> Result<serde_json::Value, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    Ok(parse_properties(&String::from_utf8_lossy(&bytes)))
}

fn serialize_properties(entries: &[(String, String)]) -> String {
    entries
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn write_properties(path: &Path, payload: &str) -> Result<(), String> {
    let entries: Vec<(String, String)> = serde_json::from_str(payload)
        .map_err(|error| format!("Invalid server.properties payload: {error}"))?;
    fs::write(path, serialize_properties(&entries).as_bytes())
        .map_err(|error| error.to_string())
}

fn main() {
    let mut args = env::args_os().skip(1);
    let Some(command) = args.next() else {
        eprintln!("Usage: craftdock-server-properties <read|write> <path>");
        std::process::exit(2);
    };
    let Some(path) = args.next() else {
        eprintln!("Usage: craftdock-server-properties <read|write> <path>");
        std::process::exit(2);
    };

    let result = match command.to_string_lossy().as_ref() {
        "read" => read_properties(Path::new(&path)).map(|entries| println!("{entries}")),
        "write" => {
            let mut payload = String::new();
            io::stdin()
                .lock()
                .read_to_string(&mut payload)
                .map_err(|error| error.to_string())
                .and_then(|_| write_properties(Path::new(&path), &payload))
        }
        _ => Err("Unknown command".into()),
    };
    if let Err(error) = result {
        eprintln!("Could not process server.properties: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_file() -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("craftdock-server-properties-{stamp}.properties"))
    }

    #[test]
    fn parses_comments_duplicate_keys_and_values_containing_equals() {
        let result = parse_properties(
            "# comment\n\n  online-mode = true \nmessage=a=b=c\nempty=\n duplicate = first\nduplicate= last \n=ignored\n",
        );
        assert_eq!(result, json!([
            ["online-mode", "true"],
            ["message", "a=b=c"],
            ["empty", ""],
            ["duplicate", "first"],
            ["duplicate", "last"],
        ]));
    }

    #[test]
    fn writes_exact_serialized_bytes() {
        let path = temp_file();
        let payload = r#"[["motd","hello=world"],["online-mode","true"]]"#;
        write_properties(&path, payload).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"motd=hello=world\nonline-mode=true\n");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_missing_input_file() {
        assert!(read_properties(&temp_file()).is_err());
    }
}
