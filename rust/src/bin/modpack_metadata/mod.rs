use serde_json::{Map, Value, json};
use std::path::Path;

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().map(|number| number != 0.0).unwrap_or(true),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

struct ModpackMetadata {
    pack_name: Value,
    mc_version: Value,
    loader: String,
    loader_version: Value,
    mods: Vec<Value>,
}

impl ModpackMetadata {
    fn new(file_name: &str) -> Self {
        let fallback_name = Path::new(file_name)
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or(file_name);
        Self {
            pack_name: Value::String(fallback_name.to_string()),
            mc_version: Value::String("1.21.4".into()),
            loader: String::new(),
            loader_version: Value::String(String::new()),
            mods: Vec::new(),
        }
    }

    fn into_value(self) -> Value {
        json!({
            "packName": self.pack_name,
            "mcVersion": self.mc_version,
            "loader": self.loader,
            "loaderVersion": self.loader_version,
            "mods": self.mods,
        })
    }
}

fn manifest_array<'a>(
    value: Option<&'a Value>,
    format: &str,
    field: &str,
    falsey_is_missing: bool,
) -> Result<Option<&'a [Value]>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() || (falsey_is_missing && !js_truthy(value)) {
        return Ok(None);
    }
    let Some(items) = value.as_array() else {
        return Err(format!(
            "Invalid {format} manifest: {field} must be an array"
        ));
    };
    if items.iter().any(Value::is_null) {
        return Err(format!(
            "Invalid {format} manifest: {field} entries cannot be null"
        ));
    }
    Ok(Some(items))
}

fn parse_modrinth(parsed: &Value, metadata: &mut ModpackMetadata) -> Result<(), String> {
    if let Some(value) = parsed.get("name").filter(|value| js_truthy(value)) {
        metadata.pack_name = value.clone();
    }
    let dependencies = parsed.get("dependencies").and_then(Value::as_object);
    if let Some(value) = dependencies
        .and_then(|deps| deps.get("minecraft"))
        .filter(|value| js_truthy(value))
    {
        metadata.mc_version = value.clone();
    }
    if let Some((key, value)) =
        dependencies.and_then(|deps| deps.iter().find(|(key, _)| key.as_str() != "minecraft"))
    {
        metadata.loader = key.clone();
        metadata.loader_version = value.clone();
    }

    if let Some(files) = manifest_array(parsed.get("files"), "Modrinth", "files", true)? {
        for file in files {
            let url = file
                .get("downloads")
                .and_then(Value::as_array)
                .and_then(|urls| urls.first());
            if let Some(url) = url.filter(|value| js_truthy(value)) {
                let mut item = Map::new();
                item.insert("url".into(), url.clone());
                if let Some(value) = file.get("path") {
                    item.insert("path".into(), value.clone());
                }
                if let Some(value) = file.get("hashes").and_then(|hashes| hashes.get("sha512")) {
                    item.insert("sha512".into(), value.clone());
                }
                metadata.mods.push(Value::Object(item));
            }
        }
    }
    Ok(())
}

fn parse_curseforge(parsed: &Value, metadata: &mut ModpackMetadata) -> Result<(), String> {
    if let Some(value) = parsed.get("name").filter(|value| js_truthy(value)) {
        metadata.pack_name = value.clone();
    }
    let minecraft = parsed.get("minecraft");
    if let Some(value) = minecraft
        .and_then(|value| value.get("version"))
        .filter(|value| js_truthy(value))
    {
        metadata.mc_version = value.clone();
    }
    let loaders = manifest_array(
        minecraft.and_then(|value| value.get("modLoaders")),
        "CurseForge",
        "modLoaders",
        false,
    )?;
    let primary = loaders.and_then(|items| {
        items
            .iter()
            .find(|item| item.get("primary").is_some_and(js_truthy))
    });
    if let Some(id) = primary
        .and_then(|item| item.get("id"))
        .filter(|value| js_truthy(value))
        .and_then(Value::as_str)
    {
        for prefix in ["forge-", "fabric-", "neoforge-", "quilt-"] {
            if let Some(version) = id.strip_prefix(prefix) {
                metadata.loader = prefix.trim_end_matches('-').to_string();
                metadata.loader_version = Value::String(version.to_string());
                break;
            }
        }
    }

    if let Some(files) = manifest_array(parsed.get("files"), "CurseForge", "files", true)? {
        for file in files {
            let mut item = Map::new();
            if let Some(value) = file.get("projectID") {
                item.insert("projectId".into(), value.clone());
            }
            if let Some(value) = file.get("fileID") {
                item.insert("fileId".into(), value.clone());
            }
            item.insert(
                "required".into(),
                Value::Bool(file.get("required") != Some(&Value::Bool(false))),
            );
            metadata.mods.push(Value::Object(item));
        }
    }
    Ok(())
}

pub(super) fn parse(manifest: &[u8], file_name: &str, is_modrinth: bool) -> Result<Value, String> {
    let parsed: Value = serde_json::from_slice(manifest).map_err(|error| error.to_string())?;
    if parsed.is_null() {
        return Err("Invalid modpack manifest: expected a non-null JSON value".into());
    }
    let mut metadata = ModpackMetadata::new(file_name);
    if is_modrinth {
        parse_modrinth(&parsed, &mut metadata)?;
    } else {
        parse_curseforge(&parsed, &mut metadata)?;
    }
    Ok(metadata.into_value())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modrinth_keeps_first_loader_defaults_and_downloaded_file_shape() {
        let manifest = r#"{"name":"Pack 🌍","dependencies":{"minecraft":"1.20.1","fabric-loader":"0.15.0"},"files":[{"path":"mods/a.jar","downloads":["https://example.invalid/a.jar"],"hashes":{"sha512":"abc"}},{"downloads":[]}] }"#.as_bytes();
        let value = parse(manifest, "fallback.mrpack", true).unwrap();
        assert_eq!(value["packName"], "Pack 🌍");
        assert_eq!(value["mcVersion"], "1.20.1");
        assert_eq!(value["loader"], "fabric-loader");
        assert_eq!(value["loaderVersion"], "0.15.0");
        assert_eq!(
            value["mods"],
            json!([{"url":"https://example.invalid/a.jar","path":"mods/a.jar","sha512":"abc"}])
        );
    }

    #[test]
    fn curseforge_unknown_loader_preserves_mod_records_and_defaults() {
        let manifest = r#"{"minecraft":{"modLoaders":[{"id":"other-1.2","primary":true}]},"files":[{"projectID":7,"fileID":9},{"required":false}]}"#.as_bytes();
        let value = parse(manifest, "fallback.zip", false).unwrap();
        assert_eq!(value["packName"], "fallback");
        assert_eq!(value["mcVersion"], "1.21.4");
        assert_eq!(value["loader"], "");
        assert_eq!(value["loaderVersion"], "");
        assert_eq!(
            value["mods"],
            json!([
                {"projectId":7,"fileId":9,"required":true},
                {"required":false}
            ])
        );
    }
}
