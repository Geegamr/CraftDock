use flate2::read::DeflateDecoder;
use std::io::Read;

const MAX_ARCHIVE_SIZE: usize = 512 * 1024 * 1024;
const MAX_MANIFEST_SIZE: usize = 16 * 1024 * 1024;

fn u16_at(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let value = bytes
        .get(offset..offset + 2)
        .ok_or("Invalid ZIP: truncated header")?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or("Invalid ZIP: truncated header")?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

pub(super) fn entry(bytes: &[u8], wanted: &str) -> Result<Option<Vec<u8>>, String> {
    if bytes.len() > MAX_ARCHIVE_SIZE {
        return Err("Invalid ZIP: archive exceeds size limit".into());
    }
    let search_start = bytes.len().saturating_sub(22 + u16::MAX as usize);
    let eocd = (search_start..=bytes.len().saturating_sub(22))
        .rev()
        .find(|&offset| bytes.get(offset..offset + 4) == Some(&[0x50, 0x4b, 0x05, 0x06]));
    let Some(eocd) = eocd else {
        return Err("Invalid ZIP: EOCD not found".into());
    };
    let count = u16_at(bytes, eocd + 10)? as usize;
    let directory_size = u32_at(bytes, eocd + 12)? as usize;
    let directory_offset = u32_at(bytes, eocd + 16)? as usize;
    let directory_end = directory_offset
        .checked_add(directory_size)
        .ok_or("Invalid ZIP: directory overflow")?;
    if directory_end > bytes.len() {
        return Err("Invalid ZIP: central directory is out of bounds".into());
    }

    let mut position = directory_offset;
    for _ in 0..count {
        if u32_at(bytes, position)? != 0x0201_4b50 {
            return Err("Invalid ZIP: bad central directory entry".into());
        }
        let compression = u16_at(bytes, position + 10)?;
        let compressed_size = u32_at(bytes, position + 20)? as usize;
        let name_len = u16_at(bytes, position + 28)? as usize;
        let extra_len = u16_at(bytes, position + 30)? as usize;
        let comment_len = u16_at(bytes, position + 32)? as usize;
        let local_offset = u32_at(bytes, position + 42)? as usize;
        let name_start = position + 46;
        let name_end = name_start
            .checked_add(name_len)
            .ok_or("Invalid ZIP: filename overflow")?;
        let name = std::str::from_utf8(
            bytes
                .get(name_start..name_end)
                .ok_or("Invalid ZIP: truncated filename")?,
        )
        .map_err(|_| "Invalid ZIP: non-UTF-8 filename")?;
        let next = name_end
            .checked_add(extra_len)
            .and_then(|value| value.checked_add(comment_len))
            .ok_or("Invalid ZIP: central directory overflow")?;
        if next > directory_end {
            return Err("Invalid ZIP: central directory entry is out of bounds".into());
        }
        position = next;

        if name != wanted {
            continue;
        }
        if compressed_size > MAX_MANIFEST_SIZE {
            return Err("Invalid modpack manifest: exceeds size limit".into());
        }
        if u32_at(bytes, local_offset)? != 0x0403_4b50 {
            return Err("Invalid ZIP: bad local file header".into());
        }
        let local_name_len = u16_at(bytes, local_offset + 26)? as usize;
        let local_extra_len = u16_at(bytes, local_offset + 28)? as usize;
        let data_start = local_offset
            .checked_add(30)
            .and_then(|value| value.checked_add(local_name_len))
            .and_then(|value| value.checked_add(local_extra_len))
            .ok_or("Invalid ZIP: data offset overflow")?;
        let data_end = data_start
            .checked_add(compressed_size)
            .ok_or("Invalid ZIP: data length overflow")?;
        let compressed = bytes
            .get(data_start..data_end)
            .ok_or("Invalid ZIP: entry data is out of bounds")?;
        let data = match compression {
            0 => compressed.to_vec(),
            8 => {
                let mut output = Vec::new();
                DeflateDecoder::new(compressed)
                    .take((MAX_MANIFEST_SIZE + 1) as u64)
                    .read_to_end(&mut output)
                    .map_err(|error| format!("Invalid ZIP: could not inflate manifest: {error}"))?;
                if output.len() > MAX_MANIFEST_SIZE {
                    return Err("Invalid modpack manifest: exceeds size limit".into());
                }
                output
            }
            _ => return Err("Invalid ZIP: unsupported manifest compression".into()),
        };
        return Ok(Some(data));
    }
    Ok(None)
}
