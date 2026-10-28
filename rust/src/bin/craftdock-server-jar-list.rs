use serde_json::json;
use std::env;
use std::fs;
use std::path::Path;
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

fn list_jars(directory: &Path) -> Result<serde_json::Value, String> {
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let filename = entry.file_name().to_string_lossy().into_owned();
        let disabled = filename.ends_with(".jar.disabled");
        if !disabled && !filename.ends_with(".jar") {
            continue;
        }
        let metadata = fs::metadata(entry.path()).map_err(|error| error.to_string())?;
        let name = if disabled {
            filename.strip_suffix(".disabled").unwrap_or(&filename)
        } else {
            &filename
        };
        files.push(json!({
            "name": name,
            "size": metadata.len(),
            "mtime": modified_ms(&entry.path()),
            "enabled": !disabled,
        }));
    }
    Ok(json!(files))
}

fn main() {
    let Some(directory) = env::args_os().nth(1) else {
        eprintln!("Usage: craftdock-server-jar-list <directory>");
        std::process::exit(2);
    };
    match list_jars(Path::new(&directory)) {
        Ok(files) => println!("{files}"),
        Err(error) => {
            eprintln!("Could not list server JAR files: {error}");
            std::process::exit(1);
        }
    }
}
