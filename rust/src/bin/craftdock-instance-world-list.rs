use serde_json::json;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, PartialEq)]
struct World {
    name: String,
    path: PathBuf,
    last_played: Option<f64>,
}

#[cfg(any(windows, test))]
fn normalize_windows_canonical_path(path: &str) -> String {
    if let Some(unc_path) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc_path}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
    }
}

fn canonical_path(path: &Path) -> Option<PathBuf> {
    let canonical = fs::canonicalize(path).ok()?;
    #[cfg(windows)]
    {
        return Some(PathBuf::from(normalize_windows_canonical_path(&canonical.to_string_lossy())));
    }
    #[cfg(not(windows))]
    Some(canonical)
}

fn list_worlds(saves_path: &Path) -> Vec<World> {
    let Some(real_saves_path) = canonical_path(saves_path) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&real_saves_path) else {
        return Vec::new();
    };

    let mut worlds = entries
        .flatten()
        .filter_map(|entry| {
            if !entry.file_type().ok()?.is_dir() {
                return None;
            }
            let world_path = real_saves_path.join(entry.file_name());
            let last_played = fs::metadata(world_path.join("level.dat"))
                .and_then(|metadata| metadata.modified())
                .ok()
                .map(|modified| match modified.duration_since(UNIX_EPOCH) {
                    Ok(duration) => duration.as_secs_f64() * 1000.0,
                    Err(error) => -(error.duration().as_secs_f64() * 1000.0),
                });
            Some(World {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: world_path,
                last_played,
            })
        })
        .collect::<Vec<_>>();
    worlds.sort_by(|left, right| {
        right
            .last_played
            .unwrap_or(0.0)
            .total_cmp(&left.last_played.unwrap_or(0.0))
    });
    worlds
}

fn worlds_json(saves_path: &Path) -> serde_json::Value {
    json!(list_worlds(saves_path).into_iter().map(|world| {
        json!({
            "name": world.name,
            "path": world.path.to_string_lossy(),
            "lastPlayed": world.last_played,
        })
    }).collect::<Vec<_>>())
}

fn main() {
    let Some(saves_path) = env::args_os().nth(1) else {
        eprintln!("Usage: craftdock-instance-world-list <saves-directory>");
        std::process::exit(2);
    };
    println!("{}", worlds_json(Path::new(&saves_path)));
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
        let directory = std::env::temp_dir().join(format!("craftdock-world-list-{stamp}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn set_modified(path: &Path, millis: u64) {
        let modified = UNIX_EPOCH + std::time::Duration::from_millis(millis);
        let file = fs::File::create(path).unwrap();
        file.set_modified(modified).unwrap();
    }

    #[test]
    fn normalizes_extended_unc_paths_and_preserves_extended_drive_paths() {
        assert_eq!(
            normalize_windows_canonical_path(r"\\?\UNC\server\share\world"),
            r"\\server\share\world",
        );
        assert_eq!(
            normalize_windows_canonical_path(r"\\?\C:\Users\player\saves\world"),
            r"C:\Users\player\saves\world",
        );
        assert_eq!(
            normalize_windows_canonical_path(r"D:\Users\player\saves\world"),
            r"D:\Users\player\saves\world",
        );
    }

    #[test]
    fn lists_shared_fixture_directories_with_millisecond_timestamps_and_newest_first() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/instance-world-list/worlds.json")).unwrap();
        let root = temp_dir();
        let saves = root.join("saves");
        for world in fixture["worlds"].as_array().unwrap() {
            let name = world["name"].as_str().unwrap();
            let world_path = saves.join(name);
            fs::create_dir_all(&world_path).unwrap();
            if let Some(millis) = world["levelDatMtimeMs"].as_u64() {
                set_modified(&world_path.join("level.dat"), millis);
            }
        }
        fs::write(saves.join(fixture["nonDirectory"].as_str().unwrap()), b"not a world directory").unwrap();

        let worlds = list_worlds(&saves);
        let expected = [
            ("newer", Some(1_700_000_000_987.0)),
            ("older", Some(1_700_000_000_123.0)),
            ("never-played", None),
        ];
        assert_eq!(worlds.iter().map(|world| world.name.as_str()).collect::<Vec<_>>(),
            expected.iter().map(|(name, _)| *name).collect::<Vec<_>>());
        for (world, (name, last_played)) in worlds.iter().zip(expected) {
            assert_eq!(world.path, canonical_path(&saves.join(name)).unwrap());
            assert_eq!(world.last_played, last_played);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_saves_directory_returns_empty_list() {
        let root = temp_dir();
        assert!(list_worlds(&root.join("missing")).is_empty());
        assert_eq!(worlds_json(&root.join("missing")), json!([]));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn follows_shared_world_symlink_and_returns_canonical_world_paths() {
        let root = temp_dir();
        let shared = root.join("shared-worlds");
        fs::create_dir_all(shared.join("shared-world")).unwrap();
        set_modified(&shared.join("shared-world/level.dat"), 1_700_000_000_555);
        let link = root.join("instance-saves");
        std::os::unix::fs::symlink(&shared, &link).unwrap();

        let worlds = list_worlds(&link);
        assert_eq!(worlds, vec![World {
            name: "shared-world".into(),
            path: canonical_path(&shared.join("shared-world")).unwrap(),
            last_played: Some(1_700_000_000_555.0),
        }]);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn follows_shared_world_junction_and_returns_canonical_world_paths() {
        use std::process::Command;
        let root = temp_dir();
        let shared = root.join("shared-worlds");
        fs::create_dir_all(shared.join("shared-world")).unwrap();
        set_modified(&shared.join("shared-world/level.dat"), 1_700_000_000_555);
        let link = root.join("instance-saves");
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&shared)
            .status()
            .unwrap();
        assert!(status.success(), "could not create test saves junction");

        let worlds = list_worlds(&link);
        assert_eq!(worlds, vec![World {
            name: "shared-world".into(),
            path: canonical_path(&shared.join("shared-world")).unwrap(),
            last_played: Some(1_700_000_000_555.0),
        }]);
        fs::remove_dir_all(root).unwrap();
    }
}
