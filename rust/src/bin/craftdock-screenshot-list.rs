use serde_json::json;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

fn modified_ms(path: &Path) -> f64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map(|modified| match modified.duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_secs_f64() * 1000.0,
            Err(error) => -error.duration().as_secs_f64() * 1000.0,
        })
        .unwrap_or(0.0)
}

fn is_screenshot(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg"]
        .iter()
        .any(|extension| lower.ends_with(extension))
}

fn list_screenshots(directory: &Path) -> Result<serde_json::Value, String> {
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_screenshot(&name) {
            continue;
        }
        let path: PathBuf = entry.path();
        let path = if path.is_absolute() {
            path
        } else {
            env::current_dir()
                .map_err(|error| error.to_string())?
                .join(path)
        };
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        let mtime = modified_ms(&path);
        files.push((
            json!({
                "name": name,
                "path": path.to_string_lossy(),
                "size": metadata.len(),
                "mtime": mtime,
            }),
            mtime,
        ));
    }
    files.sort_by(|left, right| right.1.total_cmp(&left.1));
    Ok(json!(
        files.into_iter().map(|(file, _)| file).collect::<Vec<_>>()
    ))
}

fn main() {
    let Some(directory) = env::args_os().nth(1) else {
        eprintln!("Usage: craftdock-screenshot-list <directory>");
        std::process::exit(2);
    };
    match list_screenshots(Path::new(&directory)) {
        Ok(files) => println!("{files}"),
        Err(error) => {
            eprintln!("Could not list screenshots: {error}");
            std::process::exit(1);
        }
    }
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
        let directory = std::env::temp_dir().join(format!("craftdock-screenshots-{stamp}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn filters_image_extensions_and_returns_listing_fields() {
        let directory = temp_dir();
        for name in ["capture.PNG", "capture.JpEg", "capture.jpg", "ignore.txt"] {
            fs::write(directory.join(name), name.as_bytes()).unwrap();
        }

        let result = list_screenshots(&directory).unwrap();
        let mut names: Vec<_> = result
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["name"].as_str().unwrap())
            .collect();
        names.sort_unstable();
        assert_eq!(names, ["capture.JpEg", "capture.PNG", "capture.jpg"]);
        for file in result.as_array().unwrap() {
            assert_eq!(
                Path::new(file["path"].as_str().unwrap()),
                directory.join(file["name"].as_str().unwrap())
            );
            assert!(file["size"].as_u64().is_some());
            assert!(file["mtime"].as_f64().is_some());
        }
        fs::remove_dir_all(directory).unwrap();
    }
}
