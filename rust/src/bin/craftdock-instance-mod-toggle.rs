use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

fn valid_filename(filename: &OsString) -> bool {
    let name = filename.to_string_lossy();
    if name.contains(['/', '\\', ':', '\0']) {
        return false;
    }
    let stem = name
        .strip_suffix(".jar.disabled")
        .or_else(|| name.strip_suffix(".jar"));
    matches!(stem, Some(value) if !value.is_empty() && value != "." && value != "..")
        && Path::new(filename).components().count() == 1
        && matches!(
            Path::new(filename).components().next(),
            Some(Component::Normal(_))
        )
}

fn toggle(mods_directory: &Path, filename: &OsString, enable: bool) -> io::Result<()> {
    if !valid_filename(filename) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid mod filename",
        ));
    }
    let name = filename.to_string_lossy();
    let already_desired = if enable {
        name.ends_with(".jar")
    } else {
        name.ends_with(".jar.disabled")
    };
    if already_desired {
        return Ok(());
    }

    let source = mods_directory.join(filename);
    let target_name = if enable {
        name.strip_suffix(".disabled")
            .expect("disabled filename validated")
            .to_owned()
    } else {
        format!("{name}.disabled")
    };
    fs::rename(source, mods_directory.join(target_name))
}

fn run(mut args: impl Iterator<Item = OsString>) -> io::Result<()> {
    let command = args.next().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Usage: craftdock-instance-mod-toggle <enable|disable> <mods-directory> <filename>",
        )
    })?;
    let mods_directory = args
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Missing mods directory"))?;
    let filename = args
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Missing mod filename"))?;
    if args.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Too many arguments",
        ));
    }
    match command.to_string_lossy().as_ref() {
        "enable" => toggle(Path::new(&mods_directory), &filename, true),
        "disable" => toggle(Path::new(&mods_directory), &filename, false),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Unknown command",
        )),
    }
}

fn main() {
    if let Err(error) = run(env::args_os().skip(1)) {
        eprintln!("Could not toggle instance mod: {error}");
        std::process::exit(1);
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
        let path = std::env::temp_dir().join(format!("craftdock-instance-mod-toggle-{stamp}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn enable_and_disable_rename_without_changing_contents() {
        let directory = temp_directory();
        let enabled = directory.join("example.jar");
        fs::write(&enabled, b"jar bytes").unwrap();
        toggle(&directory, &OsString::from("example.jar"), false).unwrap();
        let disabled = directory.join("example.jar.disabled");
        assert_eq!(fs::read(&disabled).unwrap(), b"jar bytes");
        toggle(&directory, &OsString::from("example.jar.disabled"), true).unwrap();
        assert_eq!(fs::read(&enabled).unwrap(), b"jar bytes");
        assert!(!disabled.exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn already_desired_state_is_a_noop_even_if_missing() {
        let directory = temp_directory();
        toggle(&directory, &OsString::from("missing.jar"), true).unwrap();
        toggle(&directory, &OsString::from("missing.jar.disabled"), false).unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn missing_source_and_escaping_names_are_rejected() {
        let directory = temp_directory();
        assert!(toggle(&directory, &OsString::from("missing.jar.disabled"), true).is_err());
        for filename in [
            "../outside.jar",
            "folder/mod.jar",
            "..\\outside.jar",
            "notes.txt",
            ".jar",
        ] {
            assert!(toggle(&directory, &OsString::from(filename), false).is_err());
        }
        fs::remove_dir_all(directory).unwrap();
    }
}
