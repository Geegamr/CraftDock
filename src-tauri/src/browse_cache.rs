//! Shared browse-result cache for the Tauri target.
//!
//! Mirrors `<data root>/browse-cache.json` from the Electron build: one small,
//! bounded file backs the Browse tab and the per-instance mod / resource pack /
//! shader browsers, so a panel paints the previous results instantly and then
//! refreshes them. Only result rows are stored — never installs or downloads.
//!
//! The limits, key normalization, TTL and eviction order match `browse-cache.js`
//! exactly, so either front end can read the other's file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

pub const MAX_ENTRIES: usize = 60;
pub const MAX_ITEMS_PER_ENTRY: usize = 40;
pub const MAX_BYTES: usize = 256 * 1024;
pub const MAX_ENTRY_BYTES: usize = 128 * 1024;
pub const TTL_MS: u64 = 24 * 60 * 60 * 1000;

const FILE_NAME: &str = "browse-cache.json";
const VERSION: u64 = 1;

/// Keys come from the renderer, so keep them short, ASCII and
/// case-insensitive — both mod browsers build the same key for the same
/// filters.
pub fn normalize_key(key: &str) -> String {
    let mut normalized = String::new();
    for character in key.trim().chars() {
        let code = character as u32;
        if !character.is_ascii() || code < 0x20 || code > 0x7e {
            continue;
        }
        normalized.push(character.to_ascii_lowercase());
        if normalized.len() >= 240 {
            break;
        }
    }
    normalized
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Debug, PartialEq)]
struct Entry {
    items: Vec<Value>,
    total: u64,
    saved_at: u64,
    last_used: u64,
}

impl Entry {
    fn to_json(&self) -> Value {
        json!({
            "items": self.items,
            "total": self.total,
            "savedAt": self.saved_at,
            "lastUsed": self.last_used,
        })
    }

    fn from_json(value: &Value) -> Option<Entry> {
        let object = value.as_object()?;
        let items = sanitize_items(object.get("items")?.as_array()?);
        Some(Entry {
            items,
            total: object.get("total").and_then(Value::as_u64).unwrap_or(0),
            saved_at: object.get("savedAt").and_then(Value::as_u64).unwrap_or(0),
            last_used: object.get("lastUsed").and_then(Value::as_u64).unwrap_or(0),
        })
    }
}

/// Only plain JSON object rows survive, capped to one small page.
fn sanitize_items(items: &[Value]) -> Vec<Value> {
    items
        .iter()
        .filter(|item| item.is_object())
        .take(MAX_ITEMS_PER_ENTRY)
        .cloned()
        .collect()
}

fn items_bytes(items: &[Value]) -> usize {
    serde_json::to_vec(&Value::Array(items.to_vec()))
        .map(|bytes| bytes.len())
        .unwrap_or(0)
}

fn entries_bytes(entries: &BTreeMap<String, Entry>) -> usize {
    let map: Map<String, Value> = entries
        .iter()
        .map(|(key, entry)| (key.clone(), entry.to_json()))
        .collect();
    serde_json::to_vec(&json!({ "version": VERSION, "entries": map }))
        .map(|bytes| bytes.len())
        .unwrap_or(0)
}

fn oldest_key(entries: &BTreeMap<String, Entry>, keep: &str) -> Option<String> {
    entries
        .iter()
        .filter(|(key, _)| key.as_str() != keep)
        .min_by_key(|(_, entry)| {
            if entry.last_used != 0 {
                entry.last_used
            } else {
                entry.saved_at
            }
        })
        .map(|(key, _)| key.clone())
}

pub struct BrowseCache {
    file: PathBuf,
}

impl BrowseCache {
    pub fn new(data_root: &Path) -> Self {
        Self {
            file: data_root.join(FILE_NAME),
        }
    }

    fn load(&self) -> BTreeMap<String, Entry> {
        let mut entries = BTreeMap::new();
        let Ok(raw) = std::fs::read_to_string(&self.file) else {
            return entries;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            return entries;
        };
        if parsed.get("version").and_then(Value::as_u64) != Some(VERSION) {
            return entries;
        }
        let Some(object) = parsed.get("entries").and_then(Value::as_object) else {
            return entries;
        };
        for (key, value) in object {
            let normalized = normalize_key(key);
            if normalized.is_empty() {
                continue;
            }
            if let Some(entry) = Entry::from_json(value) {
                entries.insert(normalized, entry);
            }
        }
        entries
    }

    fn save(&self, entries: &BTreeMap<String, Entry>) -> bool {
        let map: Map<String, Value> = entries
            .iter()
            .map(|(key, entry)| (key.clone(), entry.to_json()))
            .collect();
        let payload = json!({ "version": VERSION, "entries": map });

        if let Some(parent) = self.file.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                return false;
            }
        }
        // Write-then-rename so a crash never leaves a half-written cache.
        let temporary = PathBuf::from(format!("{}.tmp", self.file.display()));
        if std::fs::write(&temporary, payload.to_string()).is_err() {
            return false;
        }
        std::fs::rename(&temporary, &self.file).is_ok()
    }

    fn drop_expired(entries: &mut BTreeMap<String, Entry>, now: u64) {
        entries.retain(|_, entry| entry.saved_at == 0 || now.saturating_sub(entry.saved_at) <= TTL_MS);
    }

    fn evict_to_fit(entries: &mut BTreeMap<String, Entry>, keep: &str) {
        while entries.len() > MAX_ENTRIES {
            let Some(victim) = oldest_key(entries, keep) else { break };
            entries.remove(&victim);
        }
        while entries_bytes(entries) > MAX_BYTES {
            let Some(victim) = oldest_key(entries, keep) else { break };
            entries.remove(&victim);
        }
        // A single oversized query never gets to blow the budget: shrink it.
        loop {
            if entries_bytes(entries) <= MAX_BYTES {
                break;
            }
            let Some(entry) = entries.get_mut(keep) else { break };
            if entry.items.len() <= 1 {
                break;
            }
            entry.items.pop();
        }
    }

    fn read_at(&self, key: &str, now: u64) -> Option<Value> {
        let normalized = normalize_key(key);
        if normalized.is_empty() {
            return None;
        }
        let entries = self.load();
        let entry = entries.get(&normalized)?;
        if entry.saved_at != 0 && now.saturating_sub(entry.saved_at) > TTL_MS {
            return None;
        }
        Some(json!({
            "items": entry.items,
            "total": entry.total,
            "savedAt": entry.saved_at,
            "cached": true,
        }))
    }

    fn write_at(&self, key: &str, payload: &Value, now: u64) -> Value {
        let normalized = normalize_key(key);
        if normalized.is_empty() {
            return json!({ "success": false, "error": "Invalid cache key" });
        }
        let mut items = payload
            .get("items")
            .and_then(Value::as_array)
            .map(|rows| sanitize_items(rows))
            .unwrap_or_default();
        if items.is_empty() {
            return json!({ "success": false, "error": "Nothing to cache" });
        }
        while items.len() > 1 && items_bytes(&items) > MAX_ENTRY_BYTES {
            items.pop();
        }

        let declared_total = payload.get("total").and_then(Value::as_u64).unwrap_or(0);
        let mut entries = self.load();
        entries.insert(
            normalized.clone(),
            Entry {
                total: declared_total.max(items.len() as u64),
                items,
                saved_at: now,
                last_used: now,
            },
        );
        Self::drop_expired(&mut entries, now);
        Self::evict_to_fit(&mut entries, &normalized);

        let persisted = self.save(&entries);
        json!({
            "success": persisted,
            "entries": entries.len(),
            "bytes": entries_bytes(&entries),
        })
    }

    pub fn read(&self, key: &str) -> Option<Value> {
        self.read_at(key, now_ms())
    }

    pub fn write(&self, key: &str, payload: &Value) -> Value {
        self.write_at(key, payload, now_ms())
    }

    pub fn clear(&self) -> Value {
        let entries: BTreeMap<String, Entry> = BTreeMap::new();
        let persisted = self.save(&entries);
        json!({ "success": persisted, "entries": 0, "bytes": entries_bytes(&entries) })
    }

    pub fn stats(&self) -> Value {
        let entries = self.load();
        let items: usize = entries.values().map(|entry| entry.items.len()).sum();
        json!({
            "entries": entries.len(),
            "items": items,
            "bytes": entries_bytes(&entries),
            "maxEntries": MAX_ENTRIES,
            "maxItemsPerEntry": MAX_ITEMS_PER_ENTRY,
            "maxBytes": MAX_BYTES,
            "ttlMs": TTL_MS,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "craftdock-browse-cache-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp cache root");
        root
    }

    const KEY: &str = "modrinth|mod||1.20.1|fabric||downloads|0";

    #[test]
    fn round_trips_rows_and_totals_for_the_same_filters() {
        let root = temp_root("round-trip");
        let cache = BrowseCache::new(&root);

        let written = cache.write_at(
            KEY,
            &json!({ "items": [{ "id": "jei", "name": "JEI" }], "total": 1284 }),
            1_000,
        );
        assert_eq!(written["success"], json!(true));

        let read = cache.read_at(KEY, 1_000).expect("cached entry");
        assert_eq!(read["items"][0]["name"], json!("JEI"));
        assert_eq!(read["total"], json!(1284));
        assert_eq!(read["cached"], json!(true));
        assert!(cache.read_at(&KEY.to_uppercase(), 1_000).is_some(), "keys are case-insensitive");
        assert!(cache.read_at("curseforge|modpack|||", 1_000).is_none());

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn keeps_only_one_small_page_of_rows_and_refuses_bad_payloads() {
        let root = temp_root("cap");
        let cache = BrowseCache::new(&root);

        assert_eq!(cache.write_at("", &json!({ "items": [{ "id": "a" }] }), 1)["success"], json!(false));
        assert_eq!(cache.write_at(KEY, &json!({ "items": [] }), 1)["success"], json!(false));
        assert_eq!(cache.write_at(KEY, &json!({ "items": "nope" }), 1)["success"], json!(false));

        let rows: Vec<Value> = (0..80)
            .map(|index| json!({ "id": format!("mod-{index}"), "name": format!("Mod {index}") }))
            .collect();
        cache.write_at(KEY, &json!({ "items": rows, "total": 9000 }), 1);

        let read = cache.read_at(KEY, 1).expect("cached entry");
        assert_eq!(read["items"].as_array().unwrap().len(), MAX_ITEMS_PER_ENTRY);
        assert_eq!(read["total"], json!(9000));

        // Non-object rows are dropped, like the Electron cache does.
        cache.write_at("other", &json!({ "items": [{ "id": "keep" }, null, [1, 2], "row"] }), 1);
        let filtered = cache.read_at("other", 1).expect("cached entry");
        assert_eq!(filtered["items"], json!([{ "id": "keep" }]));

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn entries_expire_after_the_ttl() {
        let root = temp_root("ttl");
        let cache = BrowseCache::new(&root);
        cache.write_at(KEY, &json!({ "items": [{ "id": "jei" }] }), 1_000);

        assert!(cache.read_at(KEY, 1_000 + TTL_MS).is_some(), "fresh just before the TTL");
        assert!(cache.read_at(KEY, 1_000 + TTL_MS + 1).is_none(), "stale after the TTL");

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn evicts_the_oldest_queries_and_stays_inside_the_byte_budget() {
        let root = temp_root("evict");
        let cache = BrowseCache::new(&root);

        let mut clock = 1;
        for index in 0..(MAX_ENTRIES + 6) {
            cache.write_at(
                &format!("query-{index}"),
                &json!({ "items": [{
                    "id": format!("mod-{index}"),
                    "description": "z".repeat(600),
                }] }),
                clock,
            );
            clock += 10;
        }

        let stats = cache.stats();
        assert!(stats["entries"].as_u64().unwrap() <= MAX_ENTRIES as u64);
        assert!(
            stats["bytes"].as_u64().unwrap() <= MAX_BYTES as u64,
            "cache stayed inside the byte budget ({})",
            stats["bytes"]
        );
        assert!(cache.read_at(&format!("query-{}", MAX_ENTRIES + 5), clock).is_some(),
            "the newest query is always kept");
        assert!(cache.read_at("query-0", clock).is_none(), "the oldest query was evicted");

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn survives_a_restart_and_can_be_cleared() {
        let root = temp_root("restart");
        let cache = BrowseCache::new(&root);
        cache.write_at(KEY, &json!({ "items": [{ "id": "jei" }], "total": 3 }), 5_000);

        let reloaded = BrowseCache::new(&root);
        assert_eq!(reloaded.read_at(KEY, 5_000).unwrap()["total"], json!(3));

        let cleared = reloaded.clear();
        assert_eq!(cleared["entries"], json!(0));
        assert!(reloaded.read_at(KEY, 5_000).is_none());
        assert_eq!(BrowseCache::new(&root).stats()["entries"], json!(0), "the clear was persisted");

        std::fs::remove_dir_all(root).ok();
    }
}
