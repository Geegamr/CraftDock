#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use rand::RngCore;
use serde_json::{json, Value};
use tauri::Manager;

mod instance_store;

use instance_store::InstanceStore;

const CF_BASE_URL: &str = "https://api.curseforge.com/v1";
const CF_GAME_ID: u32 = 432; // Minecraft
const ACCOUNTS_KEY: &str = "craftdock:accounts";
const TOKEN_FIELDS: [&str; 4] = ["minecraftToken", "mcToken", "msAccessToken", "msRefreshToken"];

#[tauri::command]
fn window_minimize(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_toggle_maximize(window: tauri::WebviewWindow) -> Result<(), String> {
    let is_maximized = window.is_maximized().map_err(|error| error.to_string())?;
    let result = if is_maximized {
        window.unmaximize()
    } else {
        window.maximize()
    };
    result.map_err(|error| error.to_string())
}

#[tauri::command]
fn window_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn report_issue(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    app.opener()
        .open_url("https://github.com/Geegamr/CraftDock/issues", None::<&str>)
        .map_err(|error| error.to_string())
}

// ── Persistent key-value store ─────────────────────────────
// Mirrors the Electron store: one JSON file per key, keys sanitized the same
// way, and account tokens encrypted with the same portable AES-256-GCM key
// file so either front end can read the other's data.

fn data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = match std::env::var("CRAFTDOCK_DATA_ROOT") {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("data"),
    };
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn store_file_name(key: &str) -> String {
    let sanitized: String = key
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!("{sanitized}.json")
}

fn token_key(root: &Path) -> Result<[u8; 32], String> {
    let file = root.join(".craftdock_key");
    if let Ok(stored) = std::fs::read_to_string(&file) {
        if let Ok(bytes) = hex::decode(stored.trim()) {
            if bytes.len() == 32 {
                let mut key = [0u8; 32];
                key.copy_from_slice(&bytes);
                return Ok(key);
            }
        }
    }

    let mut key = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    std::fs::write(&file, hex::encode(key)).map_err(|error| error.to_string())?;
    Ok(key)
}

fn encrypt_token(key: &[u8; 32], token: &str) -> String {
    if token.is_empty() {
        return String::new();
    }
    let Ok(cipher) = Aes256Gcm::new_from_slice(key) else {
        return String::new();
    };
    let mut iv = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut iv);
    match cipher.encrypt(Nonce::from_slice(&iv), token.as_bytes()) {
        Ok(payload) if payload.len() > 16 => {
            let (ciphertext, tag) = payload.split_at(payload.len() - 16);
            format!(
                "aes:{}:{}:{}",
                hex::encode(iv),
                hex::encode(tag),
                hex::encode(ciphertext)
            )
        }
        _ => format!(
            "b64:{}",
            base64::engine::general_purpose::STANDARD.encode(token)
        ),
    }
}

fn decrypt_token(key: &[u8; 32], stored: &str) -> String {
    if let Some(rest) = stored.strip_prefix("aes:") {
        let parts: Vec<&str> = rest.split(':').collect();
        if parts.len() != 3 {
            return String::new();
        }
        let (Ok(iv), Ok(tag), Ok(ciphertext)) = (
            hex::decode(parts[0]),
            hex::decode(parts[1]),
            hex::decode(parts[2]),
        ) else {
            return String::new();
        };
        if iv.len() != 12 || tag.len() != 16 {
            return String::new();
        }
        let Ok(cipher) = Aes256Gcm::new_from_slice(key) else {
            return String::new();
        };
        let mut payload = ciphertext;
        payload.extend_from_slice(&tag);
        return match cipher.decrypt(Nonce::from_slice(&iv), payload.as_slice()) {
            Ok(plaintext) => String::from_utf8_lossy(&plaintext).into_owned(),
            Err(_) => String::new(),
        };
    }

    if let Some(encoded) = stored.strip_prefix("b64:") {
        return base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
    }

    // Legacy safeStorage tokens cannot be decrypted outside Electron, so the
    // account is reported as needing a fresh login instead of silently failing.
    if stored.starts_with("safe:") {
        return String::new();
    }

    stored.to_string()
}

fn decrypt_accounts(root: &Path, value: Value) -> Value {
    let Value::Array(accounts) = value else {
        return value;
    };
    let Ok(key) = token_key(root) else {
        return Value::Array(accounts);
    };

    let mut decrypted = Vec::with_capacity(accounts.len());
    for account in accounts {
        let mut entry = account;
        if let Value::Object(object) = &mut entry {
            let mut broken = false;
            for field in TOKEN_FIELDS {
                let encrypted_name = format!("_{field}");
                let Some(stored) = object
                    .get(&encrypted_name)
                    .and_then(Value::as_str)
                    .map(str::to_string)
                else {
                    continue;
                };
                let plaintext = decrypt_token(&key, &stored);
                if plaintext.is_empty() {
                    broken = true;
                }
                object.insert(field.to_string(), Value::String(plaintext));
                object.remove(&encrypted_name);
            }
            if broken {
                object.insert("_tokensBroken".to_string(), Value::Bool(true));
            }
        }
        decrypted.push(entry);
    }
    Value::Array(decrypted)
}

fn encrypt_accounts(root: &Path, value: Value) -> Result<Value, String> {
    let Value::Array(accounts) = value else {
        return Ok(value);
    };
    let key = token_key(root)?;

    let mut encrypted = Vec::with_capacity(accounts.len());
    for account in accounts {
        let mut entry = account;
        if let Value::Object(object) = &mut entry {
            for field in TOKEN_FIELDS {
                if let Some(Value::String(token)) = object.get(field).cloned() {
                    if !token.is_empty() {
                        object.insert(format!("_{field}"), Value::String(encrypt_token(&key, &token)));
                    }
                    object.remove(field);
                }
            }
        }
        encrypted.push(entry);
    }
    Ok(Value::Array(encrypted))
}

fn store_read(root: &Path, key: &str) -> Value {
    let Ok(raw) = std::fs::read_to_string(root.join(store_file_name(key))) else {
        return Value::Null;
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Value::Null;
    };

    if key == ACCOUNTS_KEY {
        decrypt_accounts(root, value)
    } else {
        value
    }
}

fn store_write(root: &Path, key: &str, value: Value) -> Result<(), String> {
    let payload = if key == ACCOUNTS_KEY {
        encrypt_accounts(root, value)?
    } else {
        value
    };
    let text = serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    std::fs::write(root.join(store_file_name(key)), text).map_err(|error| error.to_string())
}

fn store_remove(root: &Path, key: &str) -> Result<(), String> {
    let file = root.join(store_file_name(key));
    if file.exists() {
        std::fs::remove_file(file).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn store_get(app: tauri::AppHandle, key: String) -> Value {
    match data_root(&app) {
        Ok(root) => store_read(&root, &key),
        Err(_) => Value::Null,
    }
}

#[tauri::command]
fn store_set(app: tauri::AppHandle, key: String, value: Value) -> Result<(), String> {
    let root = data_root(&app)?;
    store_write(&root, &key, value)
}

#[tauri::command]
fn store_delete(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let root = data_root(&app)?;
    store_remove(&root, &key)
}

// ── Instance folders ───────────────────────────────────────
// `instance.json` sidecars under `<data root>/instances/<slug>` are the source
// of truth, exactly like the Electron main process. Only the renderer-visible
// fields are accepted; paths are derived from ids, never passed in.

fn instance_store(app: &tauri::AppHandle) -> Result<InstanceStore, String> {
    Ok(InstanceStore::new(data_root(app)?))
}

fn open_path_result(app: &tauri::AppHandle, path: &Path) -> Value {
    use tauri_plugin_opener::OpenerExt;

    match app.opener().open_path(path.to_string_lossy().to_string(), None::<&str>) {
        Ok(()) => json!({ "success": true }),
        Err(error) => json!({ "success": false, "error": error.to_string() }),
    }
}

#[tauri::command]
fn get_data_root(app: tauri::AppHandle) -> Option<String> {
    data_root(&app)
        .ok()
        .map(|root| root.to_string_lossy().into_owned())
}

#[tauri::command]
fn instance_create(app: tauri::AppHandle, meta: Value) -> Value {
    match instance_store(&app).and_then(|store| store.create(meta)) {
        Ok(created) => created,
        Err(error) => json!({ "success": false, "error": error }),
    }
}

#[tauri::command]
fn instance_list(app: tauri::AppHandle) -> Value {
    match instance_store(&app) {
        Ok(store) => Value::Array(store.list()),
        Err(_) => Value::Array(Vec::new()),
    }
}

#[tauri::command]
fn instance_get(app: tauri::AppHandle, id: String) -> Value {
    instance_store(&app)
        .ok()
        .and_then(|store| store.read_meta(&id))
        .unwrap_or(Value::Null)
}

#[tauri::command]
fn instance_update(app: tauri::AppHandle, meta: Value) -> Value {
    match instance_store(&app).and_then(|store| store.update(meta)) {
        Ok(updated) => updated,
        Err(error) => json!({ "success": false, "error": error }),
    }
}

#[tauri::command]
fn instance_delete(app: tauri::AppHandle, id: String) -> Value {
    match instance_store(&app).and_then(|store| store.delete(&id)) {
        Ok(deleted) => deleted,
        Err(error) => json!({ "success": false, "error": error }),
    }
}

#[tauri::command]
fn instance_open_folder(app: tauri::AppHandle, id: String, sub: Option<String>) -> Value {
    let target = match instance_store(&app)
        .and_then(|store| store.folder_to_open(&id, sub.as_deref()))
    {
        Ok(target) => target,
        Err(error) => return json!({ "success": false, "error": error }),
    };
    open_path_result(&app, &target)
}

/// Resolves `path` and refuses anything outside the data root. Paths the app
/// already owns (instance folders, screenshots, exports) stay inside it.
fn resolve_inside_root(root: &Path, path: &str) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("{}: {error}", root.display()))?;
    let resolved = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("{path}: {error}"))?;

    if !resolved.starts_with(&canonical_root) {
        return Err("Only paths inside CraftDock's data folder can be opened from the app".to_string());
    }
    Ok(resolved)
}

/// Opens a folder or file the app already owns. Anything outside the CraftDock
/// data folder is refused so the webview cannot launch arbitrary paths.
#[tauri::command]
fn open_folder(app: tauri::AppHandle, path: String) -> Value {
    let root = match data_root(&app) {
        Ok(root) => root,
        Err(error) => return json!({ "success": false, "error": error }),
    };

    match resolve_inside_root(&root, &path) {
        Ok(resolved) => open_path_result(&app, &resolved),
        Err(error) => json!({ "success": false, "error": error }),
    }
}

fn read_env_key(file: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(file).ok()?;
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        let name = name.trim().trim_start_matches("export ").trim();
        if name != "CF_API_KEY" {
            continue;
        }
        let value = value
            .trim()
            .trim_matches(|character| character == '"' || character == '\'');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

// The developer key never enters the webview: it is read from the environment
// or a .env file beside the working directory / executable, then sent only to
// api.curseforge.com.
fn curseforge_api_key() -> Option<String> {
    if let Ok(value) = std::env::var("CF_API_KEY") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    let mut candidates = vec![PathBuf::from(".env")];
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join(".env"));
            candidates.push(directory.join("craftdock.env"));
        }
    }
    candidates.into_iter().find_map(|file| read_env_key(&file))
}

async fn curseforge_get(path: &str, params: &[(&str, String)]) -> Value {
    let Some(api_key) = curseforge_api_key() else {
        return json!({
            "success": false,
            "error": "CurseForge API key is not configured. Put CF_API_KEY in a .env file next to craftdock.exe or set the environment variable."
        });
    };

    let response = reqwest::Client::new()
        .get(format!("{CF_BASE_URL}{path}"))
        .query(params)
        .header("Accept", "application/json")
        .header("x-api-key", api_key)
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return json!({ "success": false, "error": format!("CurseForge request failed: {error}") });
        }
    };

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let detail: String = body.chars().take(300).collect();
        return json!({
            "success": false,
            "error": format!("CurseForge API {}: {detail}", status.as_u16())
        });
    }

    let parsed: Value = match serde_json::from_str(&body) {
        Ok(parsed) => parsed,
        Err(error) => {
            return json!({ "success": false, "error": format!("CurseForge returned invalid JSON: {error}") });
        }
    };

    json!({
        "success": true,
        "data": parsed.get("data").cloned().unwrap_or_else(|| json!([])),
        "pagination": parsed.get("pagination").cloned().unwrap_or(Value::Null),
    })
}

#[tauri::command]
async fn curseforge_search(
    query: Option<String>,
    game_version: Option<String>,
    mod_loader_type: Option<String>,
    class_id: Option<u32>,
    sort_field: Option<u32>,
    index: Option<u32>,
    page_size: Option<u32>,
) -> Value {
    let mut params: Vec<(&str, String)> = vec![
        ("gameId", CF_GAME_ID.to_string()),
        ("classId", class_id.unwrap_or(4471).to_string()),
        ("searchFilter", query.unwrap_or_default()),
        ("pageSize", page_size.unwrap_or(40).clamp(1, 50).to_string()),
        ("sortField", sort_field.unwrap_or(2).to_string()),
        ("sortOrder", "desc".to_string()),
    ];

    if let Some(index) = index.filter(|value| *value > 0) {
        params.push(("index", index.to_string()));
    }
    if let Some(version) = game_version.filter(|value| !value.is_empty()) {
        params.push(("gameVersion", version));
    }
    if let Some(loader) = mod_loader_type.filter(|value| !value.is_empty()) {
        params.push(("modLoaderType", loader));
    }

    curseforge_get("/mods/search", &params).await
}

#[tauri::command]
async fn cf_get_mc_versions() -> Value {
    curseforge_get("/minecraft/version", &[]).await
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            window_minimize,
            window_toggle_maximize,
            window_close,
            report_issue,
            store_get,
            store_set,
            store_delete,
            get_data_root,
            instance_create,
            instance_list,
            instance_get,
            instance_update,
            instance_delete,
            instance_open_folder,
            open_folder,
            curseforge_search,
            cf_get_mc_versions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CraftDock Tauri");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("craftdock-tauri-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp store root");
        root
    }

    #[test]
    fn sanitizes_keys_like_the_electron_store() {
        assert_eq!(store_file_name("craftdock:appSettings"), "craftdock_appSettings.json");
        assert_eq!(store_file_name("craftdock:inst-metadata"), "craftdock_inst-metadata.json");
        assert_eq!(store_file_name("../escape"), "___escape.json");
    }

    #[test]
    fn round_trips_settings_and_instances() {
        let root = temp_root("store");
        let settings = json!({ "defaultMaxRam": 4096, "showConsoleOnLaunch": false });
        store_write(&root, "craftdock:appSettings", settings.clone()).unwrap();
        assert_eq!(store_read(&root, "craftdock:appSettings"), settings);

        let instances = json!([{ "id": "abc", "name": "Cobblemon", "mcVersion": "1.21.1" }]);
        store_write(&root, "craftdock:instances", instances.clone()).unwrap();
        assert_eq!(store_read(&root, "craftdock:instances"), instances);
        assert_eq!(store_read(&root, "craftdock:missing"), Value::Null);

        store_remove(&root, "craftdock:instances").unwrap();
        assert_eq!(store_read(&root, "craftdock:instances"), Value::Null);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn encrypts_account_tokens_on_disk_and_decrypts_them_back() {
        let root = temp_root("accounts");
        let accounts = json!([{
            "id": "account-1",
            "name": "Player",
            "minecraftToken": "mc-secret-token",
            "msAccessToken": "ms-secret-token"
        }]);

        store_write(&root, ACCOUNTS_KEY, accounts).unwrap();
        let raw = std::fs::read_to_string(root.join(store_file_name(ACCOUNTS_KEY))).unwrap();
        assert!(!raw.contains("mc-secret-token"), "plaintext Minecraft token must not touch disk");
        assert!(!raw.contains("ms-secret-token"), "plaintext Microsoft token must not touch disk");
        assert!(raw.contains("_minecraftToken"));

        let restored = store_read(&root, ACCOUNTS_KEY);
        assert_eq!(restored[0]["minecraftToken"], json!("mc-secret-token"));
        assert_eq!(restored[0]["msAccessToken"], json!("ms-secret-token"));
        assert!(restored[0].get("_minecraftToken").is_none());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn reuses_the_same_token_key_file() {
        let root = temp_root("key");
        let first = token_key(&root).unwrap();
        let second = token_key(&root).unwrap();
        assert_eq!(first, second);
        let stored = std::fs::read_to_string(root.join(".craftdock_key")).unwrap();
        assert_eq!(stored.trim().len(), 64);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn reads_the_curseforge_key_from_a_env_file_only() {
        let root = temp_root("env");
        let env_file = root.join(".env");
        std::fs::write(&env_file, "# comment\nOTHER=1\nCF_API_KEY=\"$2a$10$test-key\"\n").unwrap();
        assert_eq!(read_env_key(&env_file), Some("$2a$10$test-key".to_string()));
        std::fs::write(&env_file, "OTHER=1\n").unwrap();
        assert_eq!(read_env_key(&env_file), None);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn opens_only_paths_inside_the_data_root() {
        let root = temp_root("open-guard");
        let inside = root.join("instances").join("Pack");
        std::fs::create_dir_all(&inside).unwrap();
        let outside = root.with_extension("outside");
        std::fs::create_dir_all(&outside).unwrap();

        assert_eq!(resolve_inside_root(&root, &inside.to_string_lossy()).unwrap(), inside.canonicalize().unwrap());
        assert!(resolve_inside_root(&root, &outside.to_string_lossy()).is_err());
        // A sibling whose name merely starts with the root name must not pass.
        let prefixed = PathBuf::from(format!("{}-other", root.display()));
        std::fs::create_dir_all(&prefixed).unwrap();
        assert!(resolve_inside_root(&root, &prefixed.to_string_lossy()).is_err());
        assert!(resolve_inside_root(&root, "does-not-exist").is_err());

        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(outside).ok();
        std::fs::remove_dir_all(prefixed).ok();
    }
}
