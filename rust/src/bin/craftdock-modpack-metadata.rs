mod modpack_metadata;
mod zip_archive;

use std::env;
use std::fs;
use std::path::Path;

fn inspect(path: &Path, format: &str) -> Result<serde_json::Value, String> {
    // Reject on metadata before reading. Reading first pulled an oversized or
    // sparse archive into memory in full just to discover it was too large; the
    // size check inside the ZIP reader only runs after that allocation.
    let size = fs::metadata(path)
        .map_err(|error| error.to_string())?
        .len();
    if size > zip_archive::MAX_ARCHIVE_SIZE as u64 {
        return Err("Invalid ZIP: archive exceeds size limit".into());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let is_modrinth = format == "mr";
    let manifest_name = if is_modrinth {
        "modrinth.index.json"
    } else {
        "manifest.json"
    };
    let manifest = zip_archive::entry(&bytes, manifest_name)?.ok_or_else(|| {
        if is_modrinth {
            "Invalid .mrpack: missing modrinth.index.json"
        } else {
            "Invalid CurseForge zip: missing manifest.json"
        }
        .to_string()
    })?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    modpack_metadata::parse(&manifest, file_name, is_modrinth)
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
            // Structural rejections get their own exit code so the JavaScript
            // wrapper re-raises them instead of re-parsing the same archive
            // with the slower fallback.
            let code = if error.starts_with("Rejected: ") { 3 } else { 1 };
            std::process::exit(code);
        }
    }
}
