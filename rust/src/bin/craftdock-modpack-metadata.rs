use flate2::read::DeflateDecoder;
use serde_json::{Map, Value, json};
use std::env;
use std::fs;
use std::io::Read;
use std::path::Path;

const MAX_ARCHIVE_SIZE: usize = 512 * 1024 * 1024;
const MAX_MANIFEST_SIZE: usize = 16 * 1024 * 1024;

fn u16_at(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let value = bytes.get(offset..offset + 2).ok_or("Invalid ZIP: truncated header")?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let value = bytes.get(offset..offset + 4).ok_or("Invalid ZIP: truncated header")?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn zip_entry(bytes: &[u8], wanted: &str) -> Result<Option<Vec<u8>>, String> {
    if bytes.len() > MAX_ARCHIVE_SIZE {
        return Err("Invalid ZIP: archive exceeds size limit".into());
    }
    let search_start = bytes.len().saturating_sub(22 + u16::MAX as usize);
    let eocd = (search_start..=bytes.len().saturating_sub(22))
        .rev()
        .find(|&offset| bytes.get(offset..offset + 4) == Some(&[0x50, 0x4b, 0x05, 0x06]));
    let Some(eocd) = eocd else { return Err("Invalid ZIP: EOCD not found".into()); };
    let count = u16_at(bytes, eocd + 10)? as usize;
    let directory_size = u32_at(bytes, eocd + 12)? as usize;
    let directory_offset = u32_at(bytes, eocd + 16)? as usize;
    let directory_end = directory_offset.checked_add(directory_size).ok_or("Invalid ZIP: directory overflow")?;
    if directory_end > bytes.len() { return Err("Invalid ZIP: central directory is out of bounds".into()); }

    let mut position = directory_offset;
    for _ in 0..count {
        if u32_at(bytes, position)? != 0x0201_4b50 { return Err("Invalid ZIP: bad central directory entry".into()); }
        let compression = u16_at(bytes, position + 10)?;
        let compressed_size = u32_at(bytes, position + 20)? as usize;
        let name_len = u16_at(bytes, position + 28)? as usize;
        let extra_len = u16_at(bytes, position + 30)? as usize;
        let comment_len = u16_at(bytes, position + 32)? as usize;
        let local_offset = u32_at(bytes, position + 42)? as usize;
        let name_start = position + 46;
        let name_end = name_start.checked_add(name_len).ok_or("Invalid ZIP: filename overflow")?;
        let name = std::str::from_utf8(bytes.get(name_start..name_end).ok_or("Invalid ZIP: truncated filename")?)
            .map_err(|_| "Invalid ZIP: non-UTF-8 filename")?;
        let next = name_end.checked_add(extra_len).and_then(|value| value.checked_add(comment_len))
            .ok_or("Invalid ZIP: central directory overflow")?;
        if next > directory_end { return Err("Invalid ZIP: central directory entry is out of bounds".into()); }
        position = next;

        if name != wanted { continue; }
        if compressed_size > MAX_MANIFEST_SIZE { return Err("Invalid modpack manifest: exceeds size limit".into()); }
        if u32_at(bytes, local_offset)? != 0x0403_4b50 { return Err("Invalid ZIP: bad local file header".into()); }
        let local_name_len = u16_at(bytes, local_offset + 26)? as usize;
        let local_extra_len = u16_at(bytes, local_offset + 28)? as usize;
        let data_start = local_offset.checked_add(30)
            .and_then(|value| value.checked_add(local_name_len))
            .and_then(|value| value.checked_add(local_extra_len))
            .ok_or("Invalid ZIP: data offset overflow")?;
        let data_end = data_start.checked_add(compressed_size).ok_or("Invalid ZIP: data length overflow")?;
        let compressed = bytes.get(data_start..data_end).ok_or("Invalid ZIP: entry data is out of bounds")?;
        let data = match compression {
            0 => compressed.to_vec(),
            8 => {
                let mut output = Vec::new();
                DeflateDecoder::new(compressed)
                    .take((MAX_MANIFEST_SIZE + 1) as u64)
                    .read_to_end(&mut output)
                    .map_err(|error| format!("Invalid ZIP: could not inflate manifest: {error}"))?;
                if output.len() > MAX_MANIFEST_SIZE { return Err("Invalid modpack manifest: exceeds size limit".into()); }
                output
            }
            _ => return Err("Invalid ZIP: unsupported manifest compression".into()),
        };
        return Ok(Some(data));
    }
    Ok(None)
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().map(|number| number != 0.0).unwrap_or(true),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

fn parse_metadata(manifest: &[u8], file_name: &str, is_modrinth: bool) -> Result<Value, String> {
    let parsed: Value = serde_json::from_slice(manifest).map_err(|error| error.to_string())?;
    let fallback_name = Path::new(file_name).file_stem().and_then(|name| name.to_str()).unwrap_or(file_name);
    let mut pack_name = Value::String(fallback_name.to_string());
    let mut mc_version = Value::String("1.21.4".into());
    let mut loader = String::new();
    let mut loader_version = Value::String(String::new());
    let mut mods = Vec::new();

    if is_modrinth {
        if let Some(value) = parsed.get("name").filter(|value| js_truthy(value)) { pack_name = value.clone(); }
        let dependencies = parsed.get("dependencies").and_then(Value::as_object);
        if let Some(value) = dependencies.and_then(|deps| deps.get("minecraft")).filter(|value| js_truthy(value)) {
            mc_version = value.clone();
        }
        if let Some((key, value)) = dependencies.and_then(|deps| deps.iter().find(|(key, _)| key.as_str() != "minecraft")) {
            loader = key.clone();
            loader_version = value.clone();
        }
        if let Some(files) = parsed.get("files").and_then(Value::as_array) {
            for file in files {
                let url = file.get("downloads").and_then(Value::as_array).and_then(|urls| urls.first());
                if let Some(url) = url.filter(|value| js_truthy(value)) {
                    let mut item = Map::new();
                    item.insert("url".into(), url.clone());
                    if let Some(value) = file.get("path") { item.insert("path".into(), value.clone()); }
                    if let Some(value) = file.get("hashes").and_then(|hashes| hashes.get("sha512")) {
                        item.insert("sha512".into(), value.clone());
                    }
                    mods.push(Value::Object(item));
                }
            }
        }
    } else {
        if let Some(value) = parsed.get("name").filter(|value| js_truthy(value)) { pack_name = value.clone(); }
        let minecraft = parsed.get("minecraft");
        if let Some(value) = minecraft.and_then(|value| value.get("version")).filter(|value| js_truthy(value)) {
            mc_version = value.clone();
        }
        let primary = minecraft.and_then(|value| value.get("modLoaders"))
            .and_then(Value::as_array)
            .and_then(|loaders| loaders.iter().find(|item| item.get("primary").is_some_and(js_truthy)));
        if let Some(id) = primary.and_then(|item| item.get("id")).filter(|value| js_truthy(value)).and_then(Value::as_str) {
            for prefix in ["forge-", "fabric-", "neoforge-", "quilt-"] {
                if let Some(version) = id.strip_prefix(prefix) {
                    loader = prefix.trim_end_matches('-').to_string();
                    loader_version = Value::String(version.to_string());
                    break;
                }
            }
        }
        if let Some(files) = parsed.get("files").and_then(Value::as_array) {
            for file in files {
                let mut item = Map::new();
                if let Some(value) = file.get("projectID") { item.insert("projectId".into(), value.clone()); }
                if let Some(value) = file.get("fileID") { item.insert("fileId".into(), value.clone()); }
                item.insert("required".into(), Value::Bool(file.get("required") != Some(&Value::Bool(false))));
                mods.push(Value::Object(item));
            }
        }
    }

    Ok(json!({
        "packName": pack_name,
        "mcVersion": mc_version,
        "loader": loader,
        "loaderVersion": loader_version,
        "mods": mods,
    }))
}

fn inspect(path: &Path, format: &str) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let is_modrinth = format == "mr";
    let manifest_name = if is_modrinth { "modrinth.index.json" } else { "manifest.json" };
    let manifest = zip_entry(&bytes, manifest_name)?
        .ok_or_else(|| if is_modrinth { "Invalid .mrpack: missing modrinth.index.json" } else { "Invalid CurseForge zip: missing manifest.json" }.to_string())?;
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
    parse_metadata(&manifest, file_name, is_modrinth)
}

fn main() {
    let mut args = env::args_os().skip(1);
    let Some(command) = args.next() else {
        eprintln!("Usage: craftdock-modpack-metadata inspect <archive> <mr|cf>");
        std::process::exit(2);
    };
    let Some(archive) = args.next() else {
        eprintln!("Usage: craftdock-modpack-metadata inspect <archive> <mr|cf>");
        std::process::exit(2);
    };
    let Some(format) = args.next() else {
        eprintln!("Usage: craftdock-modpack-metadata inspect <archive> <mr|cf>");
        std::process::exit(2);
    };
    let result = if command.to_string_lossy() == "inspect" {
        inspect(Path::new(&archive), &format.to_string_lossy())
    } else {
        Err("Unknown command".into())
    };
    match result {
        Ok(metadata) => println!("{metadata}"),
        Err(error) => {
            eprintln!("Could not parse modpack metadata: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modrinth_keeps_first_loader_defaults_and_downloaded_file_shape() {
        let manifest = r#"{"name":"Pack 🌍","dependencies":{"minecraft":"1.20.1","fabric-loader":"0.15.0"},"files":[{"path":"mods/a.jar","downloads":["https://example.invalid/a.jar"],"hashes":{"sha512":"abc"}},{"downloads":[]}] }"#.as_bytes();
        let value = parse_metadata(manifest, "fallback.mrpack", true).unwrap();
        assert_eq!(value["packName"], "Pack 🌍");
        assert_eq!(value["mcVersion"], "1.20.1");
        assert_eq!(value["loader"], "fabric-loader");
        assert_eq!(value["loaderVersion"], "0.15.0");
        assert_eq!(value["mods"], json!([{"url":"https://example.invalid/a.jar","path":"mods/a.jar","sha512":"abc"}]));
    }

    #[test]
    fn curseforge_unknown_loader_preserves_mod_records_and_defaults() {
        let manifest = r#"{"minecraft":{"modLoaders":[{"id":"other-1.2","primary":true}]},"files":[{"projectID":7,"fileID":9},{"required":false}]}"#.as_bytes();
        let value = parse_metadata(manifest, "fallback.zip", false).unwrap();
        assert_eq!(value["packName"], "fallback");
        assert_eq!(value["mcVersion"], "1.21.4");
        assert_eq!(value["loader"], "");
        assert_eq!(value["loaderVersion"], "");
        assert_eq!(value["mods"], json!([
            {"projectId":7,"fileId":9,"required":true},
            {"required":false}
        ]));
    }
}
