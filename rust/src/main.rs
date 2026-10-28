use flate2::read::GzDecoder;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::Read;
use std::path::Path;

const MAX_FILE_SIZE: usize = 64 * 1024 * 1024;
const MAX_DEPTH: usize = 64;
const MAX_COLLECTION_ITEMS: usize = 1_000_000;

#[derive(Debug)]
enum Tag {
    Byte(i8),
    Short(i16),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    ByteArray(Vec<u8>),
    String(String),
    List(u8, Vec<Tag>),
    Compound(HashMap<String, Tag>),
    IntArray,
    LongArray,
}

struct NbtReader<'a> {
    bytes: &'a [u8],
    pos: usize,
    items_read: usize,
}

impl<'a> NbtReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0, items_read: 0 }
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

    fn string(&mut self) -> Result<String, String> {
        let length = self.short()? as u16 as usize;
        Ok(String::from_utf8_lossy(self.take(length)?).into_owned())
    }

    fn count(&mut self) -> Result<usize, String> {
        let count = self.int()?;
        if count < 0 || count as usize > MAX_COLLECTION_ITEMS {
            return Err("Invalid NBT collection length".into());
        }
        self.items_read = self.items_read.checked_add(count as usize).ok_or("NBT item count overflow")?;
        if self.items_read > MAX_COLLECTION_ITEMS {
            return Err("NBT contains too many collection items".into());
        }
        Ok(count as usize)
    }

    fn payload(&mut self, kind: u8, depth: usize) -> Result<Tag, String> {
        if depth > MAX_DEPTH {
            return Err("NBT nesting limit exceeded".into());
        }
        match kind {
            1 => Ok(Tag::Byte(self.byte()? as i8)),
            2 => Ok(Tag::Short(self.short()?)),
            3 => Ok(Tag::Int(self.int()?)),
            4 => Ok(Tag::Long(self.long()?)),
            5 => Ok(Tag::Float(f32::from_bits(u32::from_be_bytes(self.take(4)?.try_into().unwrap())))),
            6 => Ok(Tag::Double(f64::from_bits(u64::from_be_bytes(self.take(8)?.try_into().unwrap())))),
            7 => {
                let length = self.count()?;
                Ok(Tag::ByteArray(self.take(length)?.to_vec()))
            }
            8 => Ok(Tag::String(self.string()?)),
            9 => {
                let element_kind = self.byte()?;
                let length = self.count()?;
                if element_kind == 0 && length != 0 {
                    return Err("Non-empty NBT list has End element type".into());
                }
                let mut values = Vec::with_capacity(length.min(4096));
                for _ in 0..length {
                    values.push(self.payload(element_kind, depth + 1)?);
                }
                Ok(Tag::List(element_kind, values))
            }
            10 => {
                let mut values = HashMap::new();
                loop {
                    let child_kind = self.byte()?;
                    if child_kind == 0 {
                        break;
                    }
                    if !(1..=12).contains(&child_kind) {
                        return Err(format!("Unknown NBT tag type: {child_kind}"));
                    }
                    self.items_read += 1;
                    if self.items_read > MAX_COLLECTION_ITEMS {
                        return Err("NBT contains too many tags".into());
                    }
                    let name = self.string()?;
                    let value = self.payload(child_kind, depth + 1)?;
                    values.insert(name, value);
                }
                Ok(Tag::Compound(values))
            }
            11 => {
                let length = self.count()?;
                let byte_length = length.checked_mul(4).ok_or("NBT int array length overflow")?;
                self.take(byte_length)?;
                Ok(Tag::IntArray)
            }
            12 => {
                let length = self.count()?;
                let byte_length = length.checked_mul(8).ok_or("NBT long array length overflow")?;
                self.take(byte_length)?;
                Ok(Tag::LongArray)
            }
            _ => Err(format!("Unknown NBT tag type: {kind}")),
        }
    }

    fn root(&mut self) -> Result<Tag, String> {
        let kind = self.byte()?;
        if kind != 10 {
            return Err("NBT root is not a compound".into());
        }
        let _root_name = self.string()?;
        self.payload(kind, 0)
    }
}

fn numeric_is_one(tag: Option<&Tag>) -> bool {
    match tag {
        Some(Tag::Byte(v)) => *v == 1,
        Some(Tag::Short(v)) => *v == 1,
        Some(Tag::Int(v)) => *v == 1,
        Some(Tag::Long(v)) => *v == 1,
        Some(Tag::Float(v)) => *v == 1.0,
        Some(Tag::Double(v)) => *v == 1.0,
        _ => false,
    }
}

fn js_truthy(tag: &Tag) -> bool {
    match tag {
        Tag::String(v) => !v.is_empty(),
        Tag::Byte(v) => *v != 0,
        Tag::Short(v) => *v != 0,
        Tag::Int(v) => *v != 0,
        Tag::Long(v) => *v != 0,
        Tag::Float(v) => *v != 0.0 && !v.is_nan(),
        Tag::Double(v) => *v != 0.0 && !v.is_nan(),
        Tag::ByteArray(_) | Tag::List(_, _) | Tag::Compound(_) | Tag::IntArray | Tag::LongArray => true,
    }
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

fn js_string(tag: &Tag) -> String {
    match tag {
        Tag::String(value) => value.clone(),
        Tag::Byte(value) => value.to_string(),
        Tag::Short(value) => value.to_string(),
        Tag::Int(value) => value.to_string(),
        Tag::Long(value) => value.to_string(),
        Tag::Float(value) => value.to_string(),
        Tag::Double(value) => value.to_string(),
        Tag::ByteArray(bytes) => base64(bytes),
        Tag::List(_, _) => String::new(),
        Tag::Compound(_) => "[object Object]".into(),
        Tag::IntArray | Tag::LongArray => String::new(),
    }
}

fn parse_server_list(bytes: &[u8]) -> Result<Value, String> {
    let root = NbtReader::new(bytes).root()?;
    let Tag::Compound(root) = root else {
        return Err("NBT root is not a compound".into());
    };
    let Some(servers) = root.get("servers") else {
        return Ok(json!([]));
    };
    let Tag::List(element_kind, servers) = servers else {
        return Ok(json!([]));
    };
    if *element_kind != 10 {
        return Ok(json!([]));
    }

    let mut result = Vec::with_capacity(servers.len());
    for server in servers {
        let Tag::Compound(fields) = server else {
            continue;
        };
        let name = match fields.get("name") {
            Some(Tag::String(value)) if !value.is_empty() => value.clone(),
            _ => "Minecraft Server".into(),
        };
        let ip = match fields.get("ip") {
            Some(Tag::String(value)) => value.clone(),
            _ => String::new(),
        };
        let icon = fields.get("icon").filter(|tag| js_truthy(tag)).map(|tag| {
            let value = match tag {
                Tag::ByteArray(bytes) => base64(bytes),
                _ => js_string(tag),
            };
            format!("data:image/png;base64,{value}")
        });
        result.push(json!({
            "name": name,
            "ip": ip,
            "icon": icon,
            "hidden": numeric_is_one(fields.get("hiddenAddress")),
        }));
    }
    Ok(Value::Array(result))
}

fn read_input(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("Could not read servers.dat: {error}"))?;
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

fn run(path: &Path) -> Result<Value, String> {
    let data = read_input(path)?;
    parse_server_list(&data)
}

fn main() {
    let Some(path) = env::args_os().nth(1) else {
        eprintln!("Usage: craftdock-servers-dat <servers.dat>");
        std::process::exit(2);
    };
    match run(Path::new(&path)) {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn push_string(out: &mut Vec<u8>, value: &str) {
        out.extend_from_slice(&(value.len() as u16).to_be_bytes());
        out.extend_from_slice(value.as_bytes());
    }

    fn server_compound(out: &mut Vec<u8>) {
        out.push(8); push_string(out, "name"); push_string(out, "Example Server");
        out.push(8); push_string(out, "ip"); push_string(out, "play.example.test:25565");
        out.push(1); push_string(out, "hiddenAddress"); out.push(1);
        out.push(7); push_string(out, "icon"); out.extend_from_slice(&3_i32.to_be_bytes()); out.extend_from_slice(&[0, 1, 255]);
        out.push(0);
    }

    fn fixture() -> Vec<u8> {
        let mut out = vec![10];
        push_string(&mut out, "");
        out.push(9); push_string(&mut out, "servers");
        out.push(10); out.extend_from_slice(&1_i32.to_be_bytes());
        server_compound(&mut out);
        out.push(0);
        out
    }

    fn temp_file(bytes: &[u8], suffix: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("craftdock-servers-{stamp}-{suffix}.dat"));
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn parses_raw_servers_dat_with_renderer_shape() {
        let result = parse_server_list(&fixture()).unwrap();
        assert_eq!(result, json!([{
            "name": "Example Server",
            "ip": "play.example.test:25565",
            "icon": "data:image/png;base64,AAH/",
            "hidden": true
        }]));
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
