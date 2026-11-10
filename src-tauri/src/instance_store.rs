//! Instance folders for the Tauri target.
//!
//! Mirrors the layout the Electron main process uses: every instance is a real
//! folder under `<data root>/instances/<slug>` holding the usual Minecraft
//! profile subdirectories plus an `instance.json` sidecar. The id → folder
//! slug mapping lives in `<data root>/slug-map.json`, so ids stay stable while
//! folders keep human-readable names.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

/// Same subfolders Electron creates for a new instance.
pub const INSTANCE_SUBDIRS: [&str; 7] = [
    "mods",
    "saves",
    "config",
    "resourcepacks",
    "screenshots",
    "shaderpacks",
    "logs",
];

const META_FILE: &str = "instance.json";
const SLUG_MAP_FILE: &str = "slug-map.json";
const LEVEL_DAT: &str = "level.dat";

/// A path segment we are willing to join onto the data root: no separators, no
/// drive letters, no `.`/`..`, and short enough for Windows.
fn is_safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
}

fn validate_id(id: &str) -> Result<(), String> {
    if is_safe_segment(id.trim()) {
        Ok(())
    } else {
        Err(format!("invalid instance id: {id}"))
    }
}

/// "My Cool Pack!" → "My_Cool_Pack", matching Electron's `slugify()`.
pub fn slugify(name: &str) -> String {
    let mut cleaned = String::with_capacity(name.len());
    for character in name.chars() {
        let illegal = matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            || (character as u32) < 0x20;
        if !illegal {
            cleaned.push(character);
        }
    }

    let mut spaced = String::with_capacity(cleaned.len());
    let mut in_space = false;
    for character in cleaned.chars() {
        if character.is_whitespace() {
            if !in_space {
                spaced.push('_');
            }
            in_space = true;
        } else {
            spaced.push(character);
            in_space = false;
        }
    }

    let kept: String = spaced
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
        })
        .collect();

    let limited: String = kept.trim_matches('.').chars().take(64).collect();
    if limited.is_empty() {
        "unnamed".to_string()
    } else {
        limited
    }
}

/// Windows hands back `\\?\C:\...` from `canonicalize`; Electron's paths never
/// carry that prefix, so strip it before the renderer sees a path.
#[cfg(any(windows, test))]
fn normalize_windows_canonical_path(path: &str) -> String {
    if let Some(unc_path) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc_path}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
    }
}

/// Resolves symlinks/junctions so shared-world links report the real folder.
fn canonical_path(path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path).ok()?;
    #[cfg(windows)]
    {
        return Some(PathBuf::from(normalize_windows_canonical_path(
            &canonical.to_string_lossy(),
        )));
    }
    #[cfg(not(windows))]
    Some(canonical)
}

/// Milliseconds since the epoch, like JavaScript's `mtimeMs`.
fn modified_millis(path: &Path) -> Option<f64> {
    let modified = std::fs::metadata(path).and_then(|metadata| metadata.modified()).ok()?;
    Some(match modified.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1000.0,
        Err(error) => -(error.duration().as_secs_f64() * 1000.0),
    })
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn remove_dir_all_retrying(directory: &Path) -> Result<(), String> {
    // Windows keeps handles open briefly after a process exits (same reason
    // Electron retries), so a few short attempts beat a hard failure.
    let mut last_error = String::new();
    for attempt in 0..5 {
        match std::fs::remove_dir_all(directory) {
            Ok(()) => return Ok(()),
            Err(error) => {
                if !directory.exists() {
                    return Ok(());
                }
                last_error = error.to_string();
                if attempt < 4 {
                    std::thread::sleep(Duration::from_millis(150));
                }
            }
        }
    }
    Err(format!("could not delete {}: {last_error}", directory.display()))
}

pub struct InstanceStore {
    root: PathBuf,
}

impl InstanceStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn instances_dir(&self) -> PathBuf {
        self.root.join("instances")
    }

    fn slug_map_file(&self) -> PathBuf {
        self.root.join(SLUG_MAP_FILE)
    }

    fn read_slug_map(&self) -> Map<String, Value> {
        std::fs::read_to_string(self.slug_map_file())
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
    }

    fn write_slug_map(&self, map: &Map<String, Value>) {
        if let Ok(text) = serde_json::to_string_pretty(map) {
            let _ = std::fs::create_dir_all(&self.root);
            let _ = std::fs::write(self.slug_map_file(), text);
        }
    }

    /// Folder for an instance id, honouring the saved slug map.
    pub fn dir_for(&self, id: &str) -> Result<PathBuf, String> {
        validate_id(id)?;
        let slug = self
            .read_slug_map()
            .get(id)
            .and_then(Value::as_str)
            .map(str::to_string);

        match slug {
            Some(slug) if is_safe_segment(&slug) => Ok(self.instances_dir().join(slug)),
            _ => Ok(self.instances_dir().join(id)),
        }
    }

    /// Assign a unique, human-readable folder name to an id (kept on re-save).
    pub fn register_slug(&self, id: &str, name: &str) -> Result<String, String> {
        validate_id(id)?;
        let mut map = self.read_slug_map();

        if let Some(existing) = map.get(id).and_then(Value::as_str) {
            if is_safe_segment(existing) {
                return Ok(existing.to_string());
            }
        }

        let desired = slugify(name);
        let used: HashSet<String> = map
            .values()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        let base = self.instances_dir();

        let mut candidate = desired.clone();
        let mut suffix = 2;
        while used.contains(&candidate) || base.join(&candidate).exists() {
            candidate = format!("{desired}_{suffix}");
            suffix += 1;
        }

        map.insert(id.to_string(), Value::String(candidate.clone()));
        self.write_slug_map(&map);
        Ok(candidate)
    }

    /// Create the instance folder and every profile subfolder.
    pub fn ensure(&self, id: &str) -> Result<PathBuf, String> {
        let directory = self.dir_for(id)?;
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        for subdirectory in INSTANCE_SUBDIRS {
            std::fs::create_dir_all(directory.join(subdirectory))
                .map_err(|error| error.to_string())?;
        }
        Ok(directory)
    }

    pub fn read_meta(&self, id: &str) -> Option<Value> {
        let directory = self.dir_for(id).ok()?;
        let raw = std::fs::read_to_string(directory.join(META_FILE)).ok()?;
        serde_json::from_str::<Value>(&raw).ok()
    }

    fn write_meta(&self, id: &str, meta: &Value) -> Result<(), String> {
        let directory = self.dir_for(id)?;
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let text = serde_json::to_string_pretty(meta).map_err(|error| error.to_string())?;
        std::fs::write(directory.join(META_FILE), text).map_err(|error| error.to_string())
    }

    /// Every instance folder that has a readable sidecar.
    pub fn list(&self) -> Vec<Value> {
        let Ok(entries) = std::fs::read_dir(self.instances_dir()) else {
            return Vec::new();
        };

        let mut instances = Vec::new();
        for entry in entries.flatten() {
            let directory = entry.path();
            if !directory.is_dir() || !directory.join(META_FILE).is_file() {
                continue;
            }
            let parsed = std::fs::read_to_string(directory.join(META_FILE))
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());

            match parsed {
                Some(meta @ Value::Object(_)) => instances.push(meta),
                // A corrupt sidecar still means the folder exists, so keep it
                // visible rather than silently hiding the instance.
                _ => instances.push(json!({
                    "id": entry.file_name().to_string_lossy(),
                })),
            }
        }
        instances
    }

    /// `instance-create`: register the folder name, create folders, write meta.
    pub fn create(&self, meta: Value) -> Result<Value, String> {
        let Value::Object(mut object) = meta else {
            return Err("instance metadata must be an object".to_string());
        };

        let id = match object.get("id").and_then(Value::as_str).map(str::trim) {
            Some(id) if !id.is_empty() => {
                validate_id(id)?;
                id.to_string()
            }
            _ => format!("inst_{}", now_millis()),
        };
        object.insert("id".to_string(), Value::String(id.clone()));
        if object.get("createdAt").map_or(true, Value::is_null) {
            object.insert("createdAt".to_string(), json!(now_millis()));
        }

        let name = object
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string();
        self.register_slug(&id, &name)?;
        let directory = self.ensure(&id)?;
        self.write_meta(&id, &Value::Object(object))?;

        Ok(json!({
            "success": true,
            "id": id,
            "dir": directory.to_string_lossy(),
        }))
    }

    /// `instance-update`: merge the supplied fields over the stored sidecar.
    pub fn update(&self, meta: Value) -> Result<Value, String> {
        let Value::Object(incoming) = meta else {
            return Err("instance metadata must be an object".to_string());
        };
        let id = incoming
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "instance metadata has no id".to_string())?
            .to_string();
        validate_id(&id)?;

        let mut merged = self.read_meta(&id).unwrap_or_else(|| json!({}));
        if !merged.is_object() {
            merged = json!({});
        }
        if let Value::Object(target) = &mut merged {
            for (key, value) in incoming {
                target.insert(key, value);
            }
        }

        self.ensure(&id)?;
        self.write_meta(&id, &merged)?;
        Ok(json!({ "success": true }))
    }

    pub fn delete(&self, id: &str) -> Result<Value, String> {
        let directory = self.dir_for(id)?;
        if directory.exists() {
            remove_dir_all_retrying(&directory)?;
        }
        Ok(json!({ "success": true }))
    }

    /// Copy `options.txt` from one instance to every other instance folder.
    /// Tauri does not launch game processes, so it has no running set to skip.
    pub fn sync_options(&self, source_id: &str) -> Result<Value, String> {
        const MAX_OPTIONS_BYTES: u64 = 1024 * 1024;
        let source_dir = self.dir_for(source_id)?;
        let source_meta = self.read_meta(source_id).unwrap_or_else(|| json!({}));
        let source_path = source_dir.join("options.txt");
        let metadata = std::fs::metadata(&source_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "The source instance has no options.txt yet. Launch it once, then try again."
                    .to_string()
            } else {
                format!("Could not read options.txt: {error}")
            }
        })?;
        if !metadata.is_file() {
            return Err("options.txt is not a file".to_string());
        }
        if metadata.len() > MAX_OPTIONS_BYTES {
            return Err("options.txt is too large to sync".to_string());
        }
        let data = std::fs::read(&source_path)
            .map_err(|error| format!("Could not read options.txt: {error}"))?;
        let source_name = source_meta
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(source_id)
            .to_string();

        let mut copied = Vec::new();
        let mut failed = Vec::new();
        for instance in self.list() {
            let Some(id) = instance.get("id").and_then(Value::as_str) else {
                continue;
            };
            if id == source_id {
                continue;
            }
            let name = instance
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_string();
            let destination = match self.dir_for(id) {
                Ok(directory) => directory.join("options.txt"),
                Err(error) => {
                    failed.push(json!({ "id": id, "name": name, "error": error }));
                    continue;
                }
            };
            let temporary = destination.with_extension("txt.craftdock-sync");
            match std::fs::write(&temporary, &data)
                .and_then(|_| std::fs::rename(&temporary, &destination))
            {
                Ok(()) => copied.push(json!({ "id": id, "name": name })),
                Err(error) => {
                    let _ = std::fs::remove_file(&temporary);
                    failed.push(json!({ "id": id, "name": name, "error": error.to_string() }));
                }
            }
        }

        Ok(json!({
            "success": true,
            "source": { "id": source_id, "name": source_name },
            "copied": copied.len(),
            "copiedInstances": copied,
            "skipped": Vec::<Value>::new(),
            "failed": failed,
        }))
    }

    /// `instance-list-worlds`: folders under `<instance>/saves`, newest first.
    ///
    /// Mirrors Electron's handler, including returning an empty list (rather
    /// than an error) when the folder is missing or unreadable.
    pub fn list_worlds(&self, id: &str) -> Result<Vec<Value>, String> {
        let saves = self.dir_for(id)?.join("saves");
        let Some(real_saves) = canonical_path(&saves) else {
            return Ok(Vec::new());
        };
        let Ok(entries) = std::fs::read_dir(&real_saves) else {
            return Ok(Vec::new());
        };

        let mut worlds = entries
            .flatten()
            .filter_map(|entry| {
                if !entry.file_type().ok()?.is_dir() {
                    return None;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let world = real_saves.join(&name);
                let played = modified_millis(&world.join(LEVEL_DAT));
                let path = canonical_path(&world).unwrap_or(world);
                Some((
                    json!({
                        "name": name,
                        "path": path.to_string_lossy(),
                        "lastPlayed": played,
                    }),
                    played.unwrap_or(0.0),
                ))
            })
            .collect::<Vec<_>>();

        // Stable sort, so worlds that were never played keep folder order.
        worlds.sort_by(|left, right| right.1.total_cmp(&left.1));
        Ok(worlds.into_iter().map(|(world, _)| world).collect())
    }

    /// `instance-list-mods`: jar files in `<instance>/mods`, disabled ones
    /// included with `enabled: false`, exactly as Electron reports them.
    pub fn list_mods(&self, id: &str) -> Result<Vec<Value>, String> {
        let mods_dir = self.dir_for(id)?.join("mods");
        let Ok(entries) = std::fs::read_dir(&mods_dir) else {
            return Ok(Vec::new());
        };

        let mut mods = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let disabled = name.ends_with(".jar.disabled");
            if !disabled && !name.ends_with(".jar") {
                continue;
            }
            mods.push(json!({
                "name": name,
                "enabled": !disabled,
                "path": mods_dir.join(&name).to_string_lossy(),
            }));
        }
        Ok(mods)
    }

    /// Folder to open for `instance-open-folder`, created if missing.
    ///
    /// `sub` must stay inside the instance folder: relative, safe segments only.
    pub fn folder_to_open(&self, id: &str, sub: Option<&str>) -> Result<PathBuf, String> {
        let base = self.ensure(id)?;
        let Some(sub) = sub.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(base);
        };

        let relative = Path::new(sub);
        if relative.is_absolute() {
            return Err(format!("instance subfolder must be relative: {sub}"));
        }

        let mut target = base;
        for component in relative.components() {
            match component {
                Component::Normal(part) => {
                    let part = part.to_string_lossy().to_string();
                    if !is_safe_segment(&part) {
                        return Err(format!("invalid instance subfolder: {sub}"));
                    }
                    target.push(part);
                }
                _ => return Err(format!("invalid instance subfolder: {sub}")),
            }
        }

        std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;
        Ok(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(name: &str) -> (InstanceStore, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "craftdock-instances-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp instance root");
        (InstanceStore::new(root.clone()), root)
    }

    #[test]
    fn slugifies_like_the_electron_main_process() {
        assert_eq!(slugify("My Cool Pack!"), "My_Cool_Pack");
        // Electron collapses whitespace before stripping anything else, so
        // surrounding spaces become underscores rather than being trimmed.
        assert_eq!(slugify("  spaced   name  "), "_spaced_name_");
        assert_eq!(slugify("a<>:\"/\\|?*b"), "ab");
        assert_eq!(slugify("...."), "unnamed");
        assert_eq!(slugify(""), "unnamed");
        assert_eq!(slugify("Cobblemon Official Modpack (Fabric)"), "Cobblemon_Official_Modpack_Fabric");
    }

    #[test]
    fn creates_a_real_folder_with_profile_subdirectories() {
        let (store, root) = temp_store("create");
        let result = store
            .create(json!({
                "id": "inst_1",
                "name": "My Pack",
                "mcVersion": "1.21.4",
                "loader": "fabric",
                "ramMax": 4096
            }))
            .expect("create instance");

        assert_eq!(result["success"], json!(true));
        assert_eq!(result["id"], json!("inst_1"));
        let directory = root.join("instances").join("My_Pack");
        assert!(directory.join("instance.json").is_file());
        for subdirectory in INSTANCE_SUBDIRS {
            assert!(directory.join(subdirectory).is_dir(), "{subdirectory} must exist");
        }

        let meta: Value =
            serde_json::from_str(&std::fs::read_to_string(directory.join("instance.json")).unwrap())
                .unwrap();
        assert_eq!(meta["name"], json!("My Pack"));
        assert_eq!(meta["ramMax"], json!(4096));
        assert!(meta["createdAt"].is_u64());

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn keeps_folder_names_unique_and_stable() {
        let (store, root) = temp_store("slug");
        store.create(json!({ "id": "inst_1", "name": "Same Name" })).unwrap();
        store.create(json!({ "id": "inst_2", "name": "Same Name" })).unwrap();

        assert_eq!(store.register_slug("inst_1", "Renamed Later").unwrap(), "Same_Name");
        assert_eq!(store.register_slug("inst_2", "Same Name").unwrap(), "Same_Name_2");
        assert!(root.join("instances").join("Same_Name").is_dir());
        assert!(root.join("instances").join("Same_Name_2").is_dir());

        // The id keeps its folder even when the display name changes.
        let dir = store.dir_for("inst_2").unwrap();
        assert_eq!(dir, root.join("instances").join("Same_Name_2"));

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn lists_and_updates_instances_from_disk() {
        let (store, root) = temp_store("list");
        store
            .create(json!({ "id": "inst_a", "name": "Alpha", "mcVersion": "1.20.1" }))
            .unwrap();
        store
            .create(json!({ "id": "inst_b", "name": "Beta", "mcVersion": "1.21.4" }))
            .unwrap();

        let listed = store.list();
        assert_eq!(listed.len(), 2);
        let alpha = listed
            .iter()
            .find(|meta| meta["id"] == json!("inst_a"))
            .expect("alpha listed");
        assert_eq!(alpha["mcVersion"], json!("1.20.1"));

        store
            .update(json!({ "id": "inst_a", "notes": "with friends", "ramMax": 8192 }))
            .unwrap();
        let updated = store.read_meta("inst_a").expect("alpha meta");
        assert_eq!(updated["notes"], json!("with friends"));
        assert_eq!(updated["ramMax"], json!(8192));
        // Merging must not drop fields the renderer did not send.
        assert_eq!(updated["name"], json!("Alpha"));
        assert_eq!(updated["mcVersion"], json!("1.20.1"));

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn deletes_the_instance_folder_only() {
        let (store, root) = temp_store("delete");
        store.create(json!({ "id": "inst_keep", "name": "Keep" })).unwrap();
        store.create(json!({ "id": "inst_gone", "name": "Gone" })).unwrap();
        std::fs::write(store.dir_for("inst_gone").unwrap().join("mods/example.jar"), "jar").unwrap();

        store.delete("inst_gone").expect("delete");
        assert!(!root.join("instances").join("Gone").exists());
        assert!(root.join("instances").join("Keep").join("instance.json").is_file());
        assert_eq!(store.list().len(), 1);

        // Deleting a missing instance is a no-op, like Electron's handler.
        assert_eq!(store.delete("inst_missing").unwrap()["success"], json!(true));

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn opens_only_subfolders_inside_the_instance() {
        let (store, root) = temp_store("open");
        store.create(json!({ "id": "inst_1", "name": "Pack" })).unwrap();
        let base = root.join("instances").join("Pack");

        assert_eq!(store.folder_to_open("inst_1", None).unwrap(), base);
        assert_eq!(
            store.folder_to_open("inst_1", Some("saves")).unwrap(),
            base.join("saves")
        );
        // A subfolder that does not exist yet is created, as Electron does.
        assert_eq!(
            store.folder_to_open("inst_1", Some("custom")).unwrap(),
            base.join("custom")
        );
        assert!(base.join("custom").is_dir());

        assert!(store.folder_to_open("inst_1", Some("../escape")).is_err());
        assert!(store.folder_to_open("inst_1", Some("mods/../../escape")).is_err());
        assert!(store.folder_to_open("inst_1", Some("C:\\Windows")).is_err());
        assert!(store.folder_to_open("../outside", None).is_err());

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_ids_that_would_escape_the_data_root() {
        let (store, _root) = temp_store("reject");
        assert!(store.create(json!({ "id": "../escape", "name": "Bad" })).is_err());
        assert!(store.create(json!({ "id": "with space", "name": "Bad" })).is_err());
        assert!(store.update(json!({ "id": "../../etc" })).is_err());
        assert!(store.read_meta("../escape").is_none());
    }

    #[test]
    fn syncs_options_to_every_other_instance() {
        let (store, root) = temp_store("options-sync");
        store.create(json!({ "id": "inst_source", "name": "Source" })).unwrap();
        store.create(json!({ "id": "inst_existing", "name": "Existing" })).unwrap();
        store.create(json!({ "id": "inst_empty", "name": "Empty" })).unwrap();

        let source_dir = store.dir_for("inst_source").unwrap();
        let existing_dir = store.dir_for("inst_existing").unwrap();
        let empty_dir = store.dir_for("inst_empty").unwrap();
        std::fs::write(source_dir.join("options.txt"), b"fov:90\nlang:en_us").unwrap();
        std::fs::write(existing_dir.join("options.txt"), b"fov:30").unwrap();

        let result = store.sync_options("inst_source").unwrap();
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["source"]["name"], json!("Source"));
        assert_eq!(result["copied"], json!(2));
        assert_eq!(result["skipped"], json!([]));
        assert_eq!(result["failed"], json!([]));
        assert_eq!(std::fs::read(source_dir.join("options.txt")).unwrap(), b"fov:90\nlang:en_us");
        assert_eq!(std::fs::read(existing_dir.join("options.txt")).unwrap(), b"fov:90\nlang:en_us");
        assert_eq!(std::fs::read(empty_dir.join("options.txt")).unwrap(), b"fov:90\nlang:en_us");

        assert!(store.sync_options("inst_missing").is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn lists_worlds_newest_first_with_null_for_missing_level_dat() {
        let (store, root) = temp_store("worlds");
        store.create(json!({ "id": "inst_1", "name": "Pack" })).unwrap();
        let saves = root.join("instances").join("Pack").join("saves");

        for (name, played) in [("older", 1_700_000_000_123u64), ("newer", 1_700_000_000_987), ("never-played", 0)] {
            let world = saves.join(name);
            std::fs::create_dir_all(&world).unwrap();
            if played > 0 {
                let level = std::fs::File::create(world.join(LEVEL_DAT)).unwrap();
                level
                    .set_modified(UNIX_EPOCH + Duration::from_millis(played))
                    .unwrap();
            }
        }
        std::fs::write(saves.join("notes.txt"), b"not a world").unwrap();

        let worlds = store.list_worlds("inst_1").unwrap();
        assert_eq!(
            worlds.iter().map(|world| world["name"].as_str().unwrap()).collect::<Vec<_>>(),
            vec!["newer", "older", "never-played"]
        );
        assert_eq!(worlds[0]["lastPlayed"], json!(1_700_000_000_987.0));
        assert_eq!(worlds[2]["lastPlayed"], Value::Null);
        assert_eq!(
            worlds[0]["path"],
            json!(canonical_path(&saves.join("newer")).unwrap().to_string_lossy())
        );

        // A missing instance or saves folder is an empty list, not an error.
        assert!(store.list_worlds("inst_missing").unwrap().is_empty());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn lists_enabled_and_disabled_jars_like_electron() {
        let (store, root) = temp_store("mods");
        store.create(json!({ "id": "inst_1", "name": "Pack" })).unwrap();
        let mods = root.join("instances").join("Pack").join("mods");
        for file in ["sodium.jar", "old.jar.disabled", "readme.txt", "pack.mcmeta"] {
            std::fs::write(mods.join(file), b"x").unwrap();
        }

        let mut listed = store.list_mods("inst_1").unwrap();
        listed.sort_by_key(|entry| entry["name"].as_str().unwrap().to_string());
        assert_eq!(listed.len(), 2, "only jars are reported");
        assert_eq!(listed[0]["name"], json!("old.jar.disabled"));
        assert_eq!(listed[0]["enabled"], json!(false));
        assert_eq!(listed[1]["name"], json!("sodium.jar"));
        assert_eq!(listed[1]["enabled"], json!(true));
        assert_eq!(
            listed[1]["path"],
            json!(mods.join("sodium.jar").to_string_lossy())
        );

        assert!(store.list_mods("inst_missing").unwrap().is_empty());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn generates_a_stable_id_when_none_is_supplied() {
        let (store, root) = temp_store("generated");
        let created = store.create(json!({ "name": "No Id Pack" })).unwrap();
        let id = created["id"].as_str().expect("generated id").to_string();
        assert!(id.starts_with("inst_"));
        assert!(root.join("instances").join("No_Id_Pack").join("instance.json").is_file());
        std::fs::remove_dir_all(root).ok();
    }
}
