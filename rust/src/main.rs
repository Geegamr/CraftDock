use flate2::read::GzDecoder;
use std::env;
use std::fs;
use std::io::Read;
use std::path::Path;

const MAX_FILE_SIZE: usize = 64 * 1024 * 1024;
const MAX_DEPTH: usize = 64;
const MAX_COLLECTION_ITEMS: usize = 1_000_000;

// The smallest compound that can carry anything: a tag byte, a two-byte name
// length, a one-byte payload and the end marker is already nine bytes. Empty
// compounds are the only NBT element that costs a single input byte, so without
// a floor a 1 MiB file can declare ~900k "entries" and force ~900k allocations
// plus an ~80 MiB rendering. Every real server entry carries a name and an
// address (17 bytes on the wire at minimum), so one entry per ten input bytes
// still leaves real lists a comfortable margin.
const MIN_COMPOUND_ELEMENT_BYTES: usize = 10;

// Exit code for input that is structurally impossible rather than merely
// unreadable. The JavaScript wrapper must surface this instead of retrying the
// same bytes in its slower fallback parser, which would allocate hundreds of
// times the file size.
const REJECTED_EXIT_CODE: i32 = 3;
const REJECTED_PREFIX: &str = "Rejected: ";

/// Reads NBT values straight out of the input buffer.
///
/// Only the four fields a server record renders are captured; every other value
/// is skipped in place. An entry therefore never becomes a generic tag tree, and
/// nothing becomes a `serde_json::Value`: the JSON is written as the fields are
/// read. That keeps a dense list of ten-byte compounds proportional to the file
/// instead of paying a per-entry tree plus a per-entry value.
struct NbtReader<'a> {
    bytes: &'a [u8],
    pos: usize,
    items_read: usize,
}

impl<'a> NbtReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            pos: 0,
            items_read: 0,
        }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self.pos.checked_add(count).ok_or("NBT offset overflow")?;
        let chunk = self.bytes.get(self.pos..end).ok_or("Truncated NBT data")?;
        self.pos = end;
        Ok(chunk)
    }

    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn short(&mut self) -> Result<i16, String> {
        Ok(i16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn int(&mut self) -> Result<i32, String> {
        Ok(i32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn long(&mut self) -> Result<i64, String> {
        Ok(i64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn float(&mut self) -> Result<f32, String> {
        Ok(f32::from_bits(u32::from_be_bytes(
            self.take(4)?.try_into().unwrap(),
        )))
    }

    fn double(&mut self) -> Result<f64, String> {
        Ok(f64::from_bits(u64::from_be_bytes(
            self.take(8)?.try_into().unwrap(),
        )))
    }

    fn string(&mut self) -> Result<String, String> {
        let length = self.short()? as u16 as usize;
        Ok(String::from_utf8_lossy(self.take(length)?).into_owned())
    }

    /// A name, borrowed from the input: names are compared, never retained, so
    /// nothing is allocated for the common case of an uninteresting field.
    fn name_bytes(&mut self) -> Result<&'a [u8], String> {
        let length = self.short()? as u16 as usize;
        self.take(length)
    }

    fn count(&mut self) -> Result<usize, String> {
        let count = self.int()?;
        if count < 0 || count as usize > MAX_COLLECTION_ITEMS {
            return Err("Invalid NBT collection length".into());
        }
        self.items_read = self
            .items_read
            .checked_add(count as usize)
            .ok_or("NBT item count overflow")?;
        if self.items_read > MAX_COLLECTION_ITEMS {
            // Structural, not corrupt: the file asks for more structure than the
            // renderer will ever build, so the JavaScript fallback must not
            // retry it on the same bytes.
            return Err(format!("{REJECTED_PREFIX}NBT contains too many collection items"));
        }
        Ok(count as usize)
    }

    fn charge_item(&mut self) -> Result<(), String> {
        self.items_read = self
            .items_read
            .checked_add(1)
            .ok_or("NBT item count overflow")?;
        if self.items_read > MAX_COLLECTION_ITEMS {
            return Err(format!("{REJECTED_PREFIX}NBT contains too many tags"));
        }
        Ok(())
    }

    /// A list's declared element count has to be supportable by the bytes
    /// actually present. Compound elements are the only kind that can cost a
    /// single input byte, so they get the floor; every other kind consumes at
    /// least one byte of its own, so truncation rejects it on the first element.
    fn check_list_capacity(&self, element_kind: u8, length: usize) -> Result<(), String> {
        if element_kind != 10 {
            return Ok(());
        }
        let affordable = self.bytes.len() / MIN_COMPOUND_ELEMENT_BYTES;
        if length > affordable {
            return Err(format!(
                "{REJECTED_PREFIX}NBT list declares {length} compound entries but {} bytes can hold {affordable}",
                self.bytes.len()
            ));
        }
        Ok(())
    }

    /// Consumes one payload of `kind` without building anything.
    fn skip(&mut self, kind: u8, depth: usize) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err("NBT nesting limit exceeded".into());
        }
        match kind {
            1 => {
                self.take(1)?;
            }
            2 => {
                self.take(2)?;
            }
            3 | 5 => {
                self.take(4)?;
            }
            4 | 6 => {
                self.take(8)?;
            }
            7 => {
                let length = self.count()?;
                self.take(length)?;
            }
            8 => {
                let length = self.short()? as u16 as usize;
                self.take(length)?;
            }
            9 => {
                let element_kind = self.byte()?;
                let length = self.count()?;
                if element_kind == 0 && length != 0 {
                    return Err("Non-empty NBT list has End element type".into());
                }
                self.check_list_capacity(element_kind, length)?;
                for _ in 0..length {
                    self.skip(element_kind, depth + 1)?;
                }
            }
            10 => loop {
                let child_kind = self.byte()?;
                if child_kind == 0 {
                    break;
                }
                if !(1..=12).contains(&child_kind) {
                    return Err(format!("Unknown NBT tag type: {child_kind}"));
                }
                self.charge_item()?;
                self.name_bytes()?;
                self.skip(child_kind, depth + 1)?;
            },
            11 => {
                let length = self.count()?;
                let byte_length = length
                    .checked_mul(4)
                    .ok_or("NBT int array length overflow")?;
                self.take(byte_length)?;
            }
            12 => {
                let length = self.count()?;
                let byte_length = length
                    .checked_mul(8)
                    .ok_or("NBT long array length overflow")?;
                self.take(byte_length)?;
            }
            _ => return Err(format!("Unknown NBT tag type: {kind}")),
        }
        Ok(())
    }

    /// Reads a numeric payload and reports whether it is exactly one, which is
    /// what the renderer treats as "hidden". Non-numeric payloads are skipped.
    fn numeric_is_one(&mut self, kind: u8, depth: usize) -> Result<bool, String> {
        Ok(match kind {
            1 => self.byte()? as i8 == 1,
            2 => self.short()? == 1,
            3 => self.int()? == 1,
            4 => self.long()? == 1,
            5 => self.float()? == 1.0,
            6 => self.double()? == 1.0,
            _ => {
                self.skip(kind, depth)?;
                false
            }
        })
    }
}

fn write_json_string(out: &mut Vec<u8>, value: &str) {
    serde_json::to_writer(&mut *out, value).expect("serializing a string cannot fail");
}

/// The icon field as the renderer expects it: a data URL, or nothing when the
/// value is absent or falsey. Values keep the same coercion the JSON tree path
/// used (numbers stringify, lists and object-like tags stringify to "" and
/// "[object Object]", byte arrays are base64).
fn read_icon(reader: &mut NbtReader, kind: u8) -> Result<Option<String>, String> {
    Ok(match kind {
        8 => {
            let value = reader.string()?;
            if value.is_empty() { None } else { Some(value) }
        }
        7 => {
            let length = reader.count()?;
            Some(base64(reader.take(length)?))
        }
        1 => {
            let value = reader.byte()? as i8;
            if value == 0 { None } else { Some(value.to_string()) }
        }
        2 => {
            let value = reader.short()?;
            if value == 0 { None } else { Some(value.to_string()) }
        }
        3 => {
            let value = reader.int()?;
            if value == 0 { None } else { Some(value.to_string()) }
        }
        4 => {
            let value = reader.long()?;
            if value == 0 { None } else { Some(value.to_string()) }
        }
        5 => {
            let value = reader.float()?;
            if value == 0.0 || value.is_nan() { None } else { Some(value.to_string()) }
        }
        6 => {
            let value = reader.double()?;
            if value == 0.0 || value.is_nan() { None } else { Some(value.to_string()) }
        }
        9 => {
            reader.skip(kind, 3)?;
            Some(String::new())
        }
        10 => {
            reader.skip(kind, 3)?;
            Some("[object Object]".into())
        }
        11 | 12 => {
            reader.skip(kind, 3)?;
            Some(String::new())
        }
        _ => {
            reader.skip(kind, 3)?;
            None
        }
    })
}

/// One list element, written as it is read. The field order and the coercions
/// are exactly those the previous JSON-tree implementation produced.
fn read_server_entry(reader: &mut NbtReader, out: &mut Vec<u8>) -> Result<(), String> {
    let mut name: Option<String> = None;
    let mut ip: Option<String> = None;
    let mut icon: Option<String> = None;
    let mut hidden = false;

    loop {
        let child_kind = reader.byte()?;
        if child_kind == 0 {
            break;
        }
        if !(1..=12).contains(&child_kind) {
            return Err(format!("Unknown NBT tag type: {child_kind}"));
        }
        reader.charge_item()?;
        let field = reader.name_bytes()?;
        match field {
            b"name" => {
                name = if child_kind == 8 {
                    Some(reader.string()?)
                } else {
                    reader.skip(child_kind, 3)?;
                    None
                };
            }
            b"ip" => {
                ip = if child_kind == 8 {
                    Some(reader.string()?)
                } else {
                    reader.skip(child_kind, 3)?;
                    None
                };
            }
            b"icon" => {
                icon = read_icon(reader, child_kind)?;
            }
            b"hiddenAddress" => {
                hidden = reader.numeric_is_one(child_kind, 3)?;
            }
            _ => reader.skip(child_kind, 3)?,
        }
    }

    let name = name
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Minecraft Server".into());
    let ip = ip.unwrap_or_default();

    out.extend_from_slice(b"{\"name\":");
    write_json_string(out, &name);
    out.extend_from_slice(b",\"ip\":");
    write_json_string(out, &ip);
    out.extend_from_slice(b",\"icon\":");
    match icon {
        Some(value) => write_json_string(out, &format!("data:image/png;base64,{value}")),
        None => out.extend_from_slice(b"null"),
    }
    out.extend_from_slice(b",\"hidden\":");
    out.extend_from_slice(if hidden { b"true" } else { b"false" });
    out.push(b'}');
    Ok(())
}

/// Reads the `servers` list into `out`. Returns whether the list was one the
/// renderer can use; a list of some other element type renders as an empty
/// array, exactly as before.
fn read_servers(reader: &mut NbtReader, out: &mut Vec<u8>) -> Result<bool, String> {
    let element_kind = reader.byte()?;
    let length = reader.count()?;
    if element_kind == 0 && length != 0 {
        return Err("Non-empty NBT list has End element type".into());
    }
    if element_kind != 10 {
        for _ in 0..length {
            reader.skip(element_kind, 2)?;
        }
        return Ok(false);
    }
    reader.check_list_capacity(element_kind, length)?;

    out.push(b'[');
    for index in 0..length {
        if index > 0 {
            out.push(b',');
        }
        read_server_entry(reader, out)?;
    }
    out.push(b']');
    Ok(true)
}

/// Parses a servers.dat into the JSON text the renderer consumes.
fn parse_server_list_json(bytes: &[u8]) -> Result<String, String> {
    let mut reader = NbtReader::new(bytes);
    let kind = reader.byte()?;
    if kind != 10 {
        return Err("NBT root is not a compound".into());
    }
    reader.name_bytes()?;

    let mut out = Vec::new();
    let mut emitted = false;
    loop {
        let child_kind = reader.byte()?;
        if child_kind == 0 {
            break;
        }
        if !(1..=12).contains(&child_kind) {
            return Err(format!("Unknown NBT tag type: {child_kind}"));
        }
        reader.charge_item()?;
        let name = reader.name_bytes()?;
        if child_kind == 9 && name == b"servers" {
            let mut candidate = Vec::new();
            if read_servers(&mut reader, &mut candidate)? {
                out = candidate;
                emitted = true;
            } else {
                out.clear();
                emitted = false;
            }
        } else {
            let is_servers = name == b"servers";
            reader.skip(child_kind, 1)?;
            // A later "servers" key wins, even when it is not a usable list.
            if is_servers {
                out.clear();
                emitted = false;
            }
        }
    }

    if !emitted {
        out = b"[]".to_vec();
    }
    String::from_utf8(out).map_err(|error| error.to_string())
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as usize;
        let b = chunk.get(1).copied().unwrap_or(0) as usize;
        let c = chunk.get(2).copied().unwrap_or(0) as usize;
        out.push(TABLE[a >> 2] as char);
        out.push(TABLE[((a & 3) << 4) | (b >> 4)] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((b & 15) << 2) | (c >> 6)] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[c & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn read_input(path: &Path) -> Result<Vec<u8>, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("Could not read servers.dat: {error}"))?;
    if metadata.len() > MAX_FILE_SIZE as u64 {
        return Err("servers.dat exceeds size limit".into());
    }
    let raw = fs::read(path).map_err(|error| format!("Could not read servers.dat: {error}"))?;
    if raw.len() >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
        let mut decoder = GzDecoder::new(raw.as_slice());
        let mut output = Vec::new();
        decoder
            .by_ref()
            .take((MAX_FILE_SIZE + 1) as u64)
            .read_to_end(&mut output)
            .map_err(|error| format!("Could not decompress servers.dat: {error}"))?;
        if output.len() > MAX_FILE_SIZE {
            return Err("Decompressed servers.dat exceeds size limit".into());
        }
        Ok(output)
    } else {
        Ok(raw)
    }
}

fn run_json(path: &Path) -> Result<String, String> {
    let data = read_input(path)?;
    parse_server_list_json(&data)
}

#[cfg(test)]
fn parse_server_list(bytes: &[u8]) -> Result<serde_json::Value, String> {
    let json = parse_server_list_json(bytes)?;
    serde_json::from_str(&json).map_err(|error| error.to_string())
}

#[cfg(test)]
fn run(path: &Path) -> Result<serde_json::Value, String> {
    let json = run_json(path)?;
    serde_json::from_str(&json).map_err(|error| error.to_string())
}

fn main() {
    let Some(path) = env::args_os().nth(1) else {
        eprintln!("Usage: craftdock-servers-dat <servers.dat>");
        std::process::exit(2);
    };
    match run_json(Path::new(&path)) {
        Ok(servers) => println!("{servers}"),
        Err(error) => {
            eprintln!("{error}");
            let code = if error.starts_with(REJECTED_PREFIX) {
                REJECTED_EXIT_CODE
            } else {
                1
            };
            std::process::exit(code);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use serde_json::json;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn push_string(out: &mut Vec<u8>, value: &str) {
        out.extend_from_slice(&(value.len() as u16).to_be_bytes());
        out.extend_from_slice(value.as_bytes());
    }

    fn server_compound(out: &mut Vec<u8>) {
        out.push(8);
        push_string(out, "name");
        push_string(out, "Example Server");
        out.push(8);
        push_string(out, "ip");
        push_string(out, "play.example.test:25565");
        out.push(1);
        push_string(out, "hiddenAddress");
        out.push(1);
        out.push(7);
        push_string(out, "icon");
        out.extend_from_slice(&3_i32.to_be_bytes());
        out.extend_from_slice(&[0, 1, 255]);
        out.push(0);
    }

    fn fixture() -> Vec<u8> {
        let mut out = vec![10];
        push_string(&mut out, "");
        out.push(9);
        push_string(&mut out, "servers");
        out.push(10);
        out.extend_from_slice(&1_i32.to_be_bytes());
        server_compound(&mut out);
        out.push(0);
        out
    }

    fn temp_file(bytes: &[u8], suffix: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("craftdock-servers-{stamp}-{suffix}.dat"));
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn parses_raw_servers_dat_with_renderer_shape() {
        let result = parse_server_list(&fixture()).unwrap();
        assert_eq!(
            result,
            json!([{
                "name": "Example Server",
                "ip": "play.example.test:25565",
                "icon": "data:image/png;base64,AAH/",
                "hidden": true
            }])
        );
    }

    #[test]
    fn parses_gzip_servers_dat_file() {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&fixture()).unwrap();
        let path = temp_file(&encoder.finish().unwrap(), "gzip");
        let result = run(&path).unwrap();
        fs::remove_file(path).unwrap();
        assert_eq!(result[0]["ip"], "play.example.test:25565");
    }

    #[test]
    fn malformed_and_truncated_nbt_is_rejected() {
        assert!(parse_server_list(&[]).is_err());
        assert!(parse_server_list(&[10, 0, 0, 9]).is_err());
        let mut truncated = fixture();
        truncated.pop();
        assert!(parse_server_list(&truncated).is_err());

        let corrupt_gzip = temp_file(&[0x1f, 0x8b, 0, 0], "bad-gzip");
        assert!(read_input(&corrupt_gzip).is_err());
        fs::remove_file(corrupt_gzip).unwrap();
    }

    #[test]
    fn missing_server_list_returns_empty_array() {
        let mut bytes = vec![10];
        push_string(&mut bytes, "");
        bytes.push(0);
        assert_eq!(parse_server_list(&bytes).unwrap(), json!([]));
    }
}
