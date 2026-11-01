use serde_json::json;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const CONFIG_EXTENSIONS: [&str; 9] = [
    ".toml",
    ".json",
    ".yaml",
    ".yml",
    ".cfg",
    ".conf",
    ".ini",
    ".properties",
    ".txt",
];

struct ConfigEntry {
    name: String,
    path: PathBuf,
    is_directory: bool,
}

fn read_entries(directory: &Path) -> Option<Vec<ConfigEntry>> {
    let entries = fs::read_dir(directory).ok()?;
    Some(
        entries
            .flatten()
            .filter_map(|entry| {
                let is_directory = entry.file_type().ok()?.is_dir();
                Some(ConfigEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path: entry.path(),
                    is_directory,
                })
            })
            .collect(),
    )
}

fn is_config_file(name: &str) -> bool {
    let Some(dot) = name.rfind('.') else {
        return false;
    };
    if dot == 0 || dot + 1 == name.len() {
        return false;
    }
    let extension = format!(".{}", name[dot + 1..].to_lowercase());
    CONFIG_EXTENSIONS.contains(&extension.as_str())
}

fn walk_config_files_with(
    directory: &Path,
    subdir: &str,
    results: &mut Vec<serde_json::Value>,
    read_directory: &impl Fn(&Path) -> Option<Vec<ConfigEntry>>,
) {
    let Some(entries) = read_directory(directory) else {
        return;
    };

    for entry in entries {
        if entry.is_directory {
            let child_subdir = if subdir.is_empty() {
                entry.name
            } else {
                format!("{subdir}/{}", entry.name)
            };
            walk_config_files_with(&entry.path, &child_subdir, results, read_directory);
        } else if is_config_file(&entry.name) {
            results.push(json!({
                "name": entry.name,
                "path": entry.path.to_string_lossy(),
                "subdir": subdir,
            }));
        }
    }
}

fn list_config_files(directory: &Path) -> serde_json::Value {
    let mut results = Vec::new();
    walk_config_files_with(directory, "", &mut results, &read_entries);
    json!(results)
}

fn main() {
    let Some(directory) = env::args_os().nth(1) else {
        eprintln!("Usage: craftdock-config-file-list <directory>");
        std::process::exit(2);
    };
    println!("{}", list_config_files(Path::new(&directory)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("craftdock-config-files-{stamp}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn scans_nested_config_files_and_filters_extensions_case_insensitively() {
        let directory = temp_dir();
        fs::create_dir_all(directory.join("nested/deeper")).unwrap();
        for name in [
            "options.TOML",
            "nested/mod.JSON",
            "nested/deeper/server.YmL",
            "ignored.png",
            ".toml",
        ] {
            fs::write(directory.join(name), b"fixture").unwrap();
        }

        let files = list_config_files(&directory);
        let files = files.as_array().unwrap();
        assert_eq!(files.len(), 3);
        assert!(
            files
                .iter()
                .any(|file| { file["name"] == "server.YmL" && file["subdir"] == "nested/deeper" })
        );
        assert!(files.iter().all(|file| {
            file["path"]
                .as_str()
                .is_some_and(|path| Path::new(path).is_absolute())
        }));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn unreadable_nested_directory_does_not_hide_readable_sibling_files() {
        let directory = temp_dir();
        let denied = directory.join("locked");
        fs::create_dir_all(&denied).unwrap();
        fs::create_dir_all(directory.join("readable")).unwrap();
        fs::write(denied.join("hidden.toml"), b"hidden").unwrap();
        fs::write(directory.join("readable/visible.json"), b"visible").unwrap();

        let mut results = Vec::new();
        let mocked_reader = |current: &Path| {
            if current == denied {
                None
            } else {
                read_entries(current)
            }
        };
        walk_config_files_with(&directory, "", &mut results, &mocked_reader);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["name"], "visible.json");
        assert_eq!(results[0]["subdir"], "readable");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn missing_root_returns_empty_list() {
        let directory = temp_dir();
        let missing = directory.join("missing");
        assert_eq!(list_config_files(&missing), json!([]));
        fs::remove_dir_all(directory).unwrap();
    }
}
