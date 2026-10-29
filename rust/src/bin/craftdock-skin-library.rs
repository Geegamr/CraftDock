use serde_json::{Value, json};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

fn meta_path(directory: &Path) -> PathBuf {
    directory.join("skins.json")
}

fn ensure_regular_metadata(directory: &Path) -> Result<PathBuf, String> {
    let path = meta_path(directory);
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("Skin metadata path cannot be a symbolic link".into());
    }
    Ok(path)
}

fn is_inside_directory(directory: &Path, file: &Path) -> bool {
    let Ok(root) = fs::canonicalize(directory) else {
        return false;
    };
    let Ok(resolved) = fs::canonicalize(file) else {
        return false;
    };
    let Ok(relative) = resolved.strip_prefix(root) else {
        return false;
    };
    !relative.as_os_str().is_empty()
}

fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => {
            let number = value.to_string();
            number
                .strip_suffix(".0")
                .map_or(number.clone(), str::to_owned)
        }
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::Null => String::new(),
                Value::Array(_) | Value::Object(_) => js_string(Some(value)),
                _ => js_string(Some(value)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

fn skin_image_path(directory: &Path, id: Option<&Value>) -> Result<PathBuf, String> {
    let filename = format!("{}.png", js_string(id));
    if filename.contains(['/', '\\', ':', '\0']) {
        return Err("Invalid skin id".into());
    }
    let image = directory.join(filename);
    if fs::symlink_metadata(&image).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("Skin image path cannot be a symbolic link".into());
    }
    Ok(image)
}

fn decode_base64(input: &str) -> Vec<u8> {
    let mut output = Vec::with_capacity(input.len() * 3 / 4);
    let mut accumulator = 0u32;
    let mut bits = 0u8;
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => continue,
        };
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((accumulator >> bits) as u8);
        }
    }
    output
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        output.push(TABLE[(a >> 2) as usize] as char);
        output.push(TABLE[(((a & 0x03) << 4) | (b >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[(((b & 0x0f) << 2) | (c >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(c & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn read_skins(directory: &Path) -> Result<Value, String> {
    let metadata_path = ensure_regular_metadata(directory)?;
    if !metadata_path.exists() {
        return Ok(json!([]));
    }
    let contents = fs::read_to_string(&metadata_path).map_err(|error| error.to_string())?;
    let mut skins: Vec<Value> =
        serde_json::from_str(&contents).map_err(|error| error.to_string())?;
    for skin in &mut skins {
        if let Some(file_path) = skin.get("filePath").and_then(Value::as_str) {
            let image = Path::new(file_path);
            if image.exists() && is_inside_directory(directory, image) {
                let bytes = fs::read(image).map_err(|error| error.to_string())?;
                skin["dataUrl"] =
                    Value::String(format!("data:image/png;base64,{}", encode_base64(&bytes)));
            }
        }
    }
    Ok(json!(skins))
}

fn js_strict_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Number(left)), Some(Value::Number(right))) => left.as_f64() == right.as_f64(),
        (Some(Value::Array(_) | Value::Object(_)), Some(Value::Array(_) | Value::Object(_))) => {
            false
        }
        (Some(left), Some(right))
            if std::mem::discriminant(left) == std::mem::discriminant(right) =>
        {
            left == right
        }
        _ => false,
    }
}

fn save_skin(directory: &Path, payload: &str) -> Result<Value, String> {
    let mut skin: Value = serde_json::from_str(payload).map_err(|error| error.to_string())?;
    let metadata_path = ensure_regular_metadata(directory)?;
    let mut skins: Vec<Value> = if metadata_path.exists() {
        serde_json::from_slice(&fs::read(&metadata_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?
    } else {
        Vec::new()
    };
    if skin
        .get("dataUrl")
        .and_then(Value::as_str)
        .is_some_and(|data| data.starts_with("data:image"))
    {
        let id = skin.get("id");
        let image_path = skin_image_path(directory, id)?;
        let data_url = skin["dataUrl"].as_str().unwrap();
        let base64 = data_url
            .strip_prefix("data:image/png;base64,")
            .unwrap_or(data_url);
        fs::write(&image_path, decode_base64(base64)).map_err(|error| error.to_string())?;
        skin["filePath"] = Value::String(image_path.to_string_lossy().into_owned());
        if let Some(object) = skin.as_object_mut() {
            object.remove("dataUrl");
        }
    }
    let id = skin.get("id");
    if let Some(index) = skins
        .iter()
        .position(|existing| js_strict_equal(existing.get("id"), id))
    {
        skins[index] = skin;
    } else {
        skins.push(skin);
    }
    fs::write(
        metadata_path,
        serde_json::to_vec_pretty(&skins).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(json!({"success": true}))
}
fn delete_skin(directory: &Path, id: Option<&Value>) -> Result<Value, String> {
    let metadata_path = ensure_regular_metadata(directory)?;
    if !metadata_path.exists() {
        return Ok(Value::Null);
    }
    let image_path = skin_image_path(directory, id)?;
    let mut skins: Vec<Value> =
        serde_json::from_slice(&fs::read(&metadata_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    skins.retain(|skin| !js_strict_equal(skin.get("id"), id));
    fs::write(
        &metadata_path,
        serde_json::to_vec_pretty(&skins).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if image_path.exists() {
        fs::remove_file(image_path).map_err(|error| error.to_string())?;
    }
    Ok(json!({"success": true}))
}

fn execute(command: &str, directory: &Path, input: &str) -> Result<Value, String> {
    match command {
        "get" => read_skins(directory),
        "save" => save_skin(directory, input),
        "delete" => {
            let payload: Value = serde_json::from_str(input).map_err(|error| error.to_string())?;
            delete_skin(directory, payload.get("id"))
        }
        _ => Err("Unknown command".into()),
    }
}

fn main() {
    let mut args = env::args_os().skip(1);
    let Some(command) = args.next() else {
        eprintln!("Usage: craftdock-skin-library <get|save|delete> <skins-directory> [id]");
        std::process::exit(2);
    };
    let Some(directory) = args.next() else {
        eprintln!("Usage: craftdock-skin-library <get|save|delete> <skins-directory> [id]");
        std::process::exit(2);
    };
    let command = command.to_string_lossy();
    let mut input = String::new();
    if command == "save" || command == "delete" {
        if let Err(error) = io::stdin().lock().read_to_string(&mut input) {
            eprintln!("Could not process skin library: {error}");
            std::process::exit(1);
        }
    }
    match execute(&command, Path::new(&directory), &input) {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("Could not process skin library: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_directory() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("craftdock-skin-library-{stamp}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn absent_metadata_returns_empty_array_and_delete_returns_null() {
        let directory = temp_directory();
        assert_eq!(read_skins(&directory).unwrap(), json!([]));
        assert_eq!(
            delete_skin(&directory, Some(&json!("missing"))).unwrap(),
            Value::Null
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn saves_upserts_and_get_hydrates_image_while_retaining_missing_paths() {
        let directory = temp_directory();
        let first = json!({"id":"one","name":"Original","dataUrl":"data:image/png;base64,AQID"});
        save_skin(&directory, &first.to_string()).unwrap();
        assert_eq!(fs::read(directory.join("one.png")).unwrap(), [1, 2, 3]);
        let second = json!({"id":"one","name":"Updated","dataUrl":"data:image/png;base64,/w=="});
        save_skin(&directory, &second.to_string()).unwrap();
        let skins = read_skins(&directory).unwrap();
        assert_eq!(skins.as_array().unwrap().len(), 1);
        assert_eq!(skins[0]["name"], "Updated");
        assert_eq!(skins[0]["dataUrl"], "data:image/png;base64,/w==");
        assert!(skins[0].get("filePath").is_some());
        fs::write(
            directory.join("skins.json"),
            r#"[{"id":"missing","filePath":"absent.png"}]"#,
        )
        .unwrap();
        let missing = read_skins(&directory).unwrap();
        assert_eq!(missing[0]["filePath"], "absent.png");
        assert!(missing[0].get("dataUrl").is_none());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn delete_removes_only_matching_metadata_and_image() {
        let directory = temp_directory();
        fs::write(directory.join("one.png"), [1]).unwrap();
        fs::write(directory.join("two.png"), [2]).unwrap();
        fs::write(
            directory.join("skins.json"),
            r#"[{"id":"one"},{"id":"two"}]"#,
        )
        .unwrap();
        assert_eq!(
            delete_skin(&directory, Some(&json!("one"))).unwrap(),
            json!({"success":true})
        );
        assert_eq!(read_skins(&directory).unwrap(), json!([{"id":"two"}]));
        assert!(!directory.join("one.png").exists());
        assert_eq!(fs::read(directory.join("two.png")).unwrap(), [2]);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn preserves_javascript_string_coercion_for_non_string_ids() {
        assert_eq!(js_string(None), "undefined");
        assert_eq!(js_string(Some(&Value::Null)), "null");
        assert_eq!(js_string(Some(&json!(7))), "7");
        assert_eq!(js_string(Some(&json!(["a", null, 2]))), "a,,2");
        assert_eq!(js_string(Some(&json!({"key":"value"}))), "[object Object]");
        assert!(skin_image_path(Path::new("skins"), Some(&json!("../outside"))).is_err());
        assert!(skin_image_path(Path::new("skins"), Some(&json!("C:/outside"))).is_err());
        assert!(skin_image_path(Path::new("skins"), Some(&json!("\\\\server\\share"))).is_err());
    }
}
