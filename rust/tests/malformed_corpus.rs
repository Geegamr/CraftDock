// Adversarial corpus for the native parsers the Electron main process shells out
// to. Every case drives the real executable with malformed input and requires a
// clean result: exit 0 for input it accepts, exit 1 with a diagnostic for input
// it rejects. A panic (exit 101), a stack overflow, an abort, a hang, or a
// runaway allocation is a bug in the parser boundary, not a test failure to
// tolerate.
//
// The corpus is deliberately generated as well as handcrafted: truncated
// prefixes of valid files, declared lengths far past the end of the data,
// offsets pointing outside the file, and nesting deep enough to exhaust the
// stack if a depth guard were missing.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SERVERS_DAT: &str = env!("CARGO_BIN_EXE_craftdock-servers-dat");
const MODPACK: &str = env!("CARGO_BIN_EXE_craftdock-modpack-metadata");
const PROPERTIES: &str = env!("CARGO_BIN_EXE_craftdock-server-properties");
const SKINS: &str = env!("CARGO_BIN_EXE_craftdock-skin-library");
const WORLDS: &str = env!("CARGO_BIN_EXE_craftdock-instance-world-list");
const CONFIGS: &str = env!("CARGO_BIN_EXE_craftdock-config-file-list");
const SCREENSHOTS: &str = env!("CARGO_BIN_EXE_craftdock-screenshot-list");
const JARS: &str = env!("CARGO_BIN_EXE_craftdock-server-jar-list");

const TIMEOUT: Duration = Duration::from_secs(15);

// Markers the Rust runtime prints when a process cannot return a value: a
// panic, a stack overflow, an allocation failure, or a bounds violation.
const CRASH_MARKERS: [&str; 9] = [
    "panicked at",
    "stack overflow",
    "memory allocation of",
    "capacity overflow",
    "attempt to add with overflow",
    "attempt to subtract with overflow",
    "attempt to multiply with overflow",
    "index out of bounds",
    "slice index starts at",
];

struct Outcome {
    code: Option<i32>,
    stderr: String,
    timed_out: bool,
}

fn run(binary: &str, args: &[&str], stdin: &[u8], timeout: Duration) -> Outcome {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_empty() {
            Stdio::null()
        } else {
            Stdio::piped()
        });
    let mut child = command.spawn().expect("failed to start native parser");
    if let Some(mut handle) = child.stdin.take() {
        let payload = stdin.to_vec();
        // Feed stdin off-thread so a chatty child can never deadlock the test.
        thread::spawn(move || {
            let _ = handle.write_all(&payload);
        });
    }
    let pipe = child.stderr.take().expect("stderr pipe");
    let reader = thread::spawn(move || {
        let mut buffer = Vec::new();
        let mut pipe = pipe;
        let _ = pipe.read_to_end(&mut buffer);
        String::from_utf8_lossy(&buffer).into_owned()
    });

    let deadline = Instant::now() + timeout;
    let (code, timed_out) = loop {
        match child.try_wait().expect("failed to wait for native parser") {
            Some(status) => break (status.code(), false),
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break (None, true);
            }
            None => thread::sleep(Duration::from_millis(5)),
        }
    };
    let stderr = reader.join().unwrap_or_default();
    Outcome {
        code,
        stderr,
        timed_out,
    }
}

fn assert_clean(label: &str, outcome: &Outcome) {
    assert!(
        !outcome.timed_out,
        "{label}: native parser hung past {TIMEOUT:?}"
    );
    let Some(code) = outcome.code else {
        panic!(
            "{label}: terminated without an exit code (abort/crash); stderr: {}",
            outcome.stderr
        );
    };
    assert!(
        code == 0 || code == 1 || code == 3,
        "{label}: unexpected exit code {code}; stderr: {}",
        outcome.stderr
    );
    let lowered = outcome.stderr.to_ascii_lowercase();
    for marker in CRASH_MARKERS {
        assert!(
            !lowered.contains(marker),
            "{label}: crash marker {marker:?}; stderr: {}",
            outcome.stderr
        );
    }
}

fn assert_rejected(label: &str, outcome: &Outcome) {
    assert_clean(label, outcome);
    assert_eq!(
        outcome.code,
        Some(1),
        "{label}: malformed input must fail cleanly; stderr: {}",
        outcome.stderr
    );
    assert!(
        !outcome.stderr.trim().is_empty(),
        "{label}: a rejection must explain itself on stderr"
    );
}

fn assert_accepted(label: &str, outcome: &Outcome) {
    assert_clean(label, outcome);
    assert_eq!(
        outcome.code,
        Some(0),
        "{label}: valid input must still parse; stderr: {}",
        outcome.stderr
    );
}

/// Input that is structurally impossible: the parser must say so with the
/// dedicated exit code the JavaScript wrapper keys off, not the generic one it
/// treats as "try the slow fallback".
fn assert_structurally_rejected(label: &str, outcome: &Outcome) {
    assert_clean(label, outcome);
    assert_eq!(
        outcome.code,
        Some(3),
        "{label}: expected the structural-rejection exit code; stderr: {}",
        outcome.stderr
    );
    assert!(
        outcome.stderr.contains("Rejected:"),
        "{label}: missing a rejection diagnostic; stderr: {}",
        outcome.stderr
    );
}

fn temp_dir(tag: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "craftdock-corpus-{tag}-{stamp}-{}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn write_case(directory: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = directory.join(name);
    fs::write(&path, bytes).unwrap();
    path
}

fn path_str(path: &Path) -> &str {
    path.to_str().expect("temporary path is not valid UTF-8")
}

// ── NBT (servers.dat) builders ───────────────────────────────────────────────

fn nbt_string(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(&(value.len() as u16).to_be_bytes());
    out.extend_from_slice(value.as_bytes());
}

fn servers_dat_fixture() -> Vec<u8> {
    let mut out = vec![0x0A];
    nbt_string(&mut out, "");
    out.push(0x09);
    nbt_string(&mut out, "servers");
    out.push(0x0A);
    out.extend_from_slice(&1_i32.to_be_bytes());
    out.push(0x08);
    nbt_string(&mut out, "name");
    nbt_string(&mut out, "Example Server");
    out.push(0x08);
    nbt_string(&mut out, "ip");
    nbt_string(&mut out, "play.example.test:25565");
    out.push(0x01);
    nbt_string(&mut out, "hiddenAddress");
    out.push(1);
    out.push(0x07);
    nbt_string(&mut out, "icon");
    out.extend_from_slice(&3_i32.to_be_bytes());
    out.extend_from_slice(&[0, 1, 255]);
    out.push(0x00);
    out.push(0x00);
    out
}

/// A root compound holding one list of lists, nested `depth` levels deep.
fn nested_lists(depth: usize) -> Vec<u8> {
    let mut out = vec![0x0A, 0x00, 0x00];
    for _ in 0..depth {
        out.push(0x09);
        nbt_string(&mut out, "x");
        out.push(0x09);
        out.extend_from_slice(&1_i32.to_be_bytes());
    }
    out.push(0x00); // innermost element: End
    out.extend_from_slice(&0_i32.to_be_bytes());
    out.push(0x00); // end of the root compound
    out
}

/// A root compound holding one compound, nested `depth` levels deep.
fn nested_compounds(depth: usize) -> Vec<u8> {
    let mut out = vec![0x0A, 0x00, 0x00];
    for _ in 0..depth {
        out.push(0x0A);
        nbt_string(&mut out, "c");
    }
    for _ in 0..=depth {
        out.push(0x00);
    }
    out
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn servers_dat_corpus() -> Vec<(&'static str, Vec<u8>)> {
    let mut cases: Vec<(&'static str, Vec<u8>)> = vec![
        ("empty file", Vec::new()),
        ("one byte", vec![0x0A]),
        ("two bytes", vec![0x0A, 0x00]),
        ("root compound only", vec![0x0A, 0x00, 0x00]),
        ("all zero, one byte", vec![0x00]),
        ("all zero, twelve bytes", vec![0x00; 12]),
        ("all zero, 1 MiB", vec![0x00; 1024 * 1024]),
        ("all 0xFF, twelve bytes", vec![0xFF; 12]),
        ("all 0xFF, 1 MiB", vec![0xFF; 1024 * 1024]),
        ("gzip magic only", vec![0x1F, 0x8B]),
        ("gzip magic and garbage", vec![0x1F, 0x8B, 0xFF, 0xFF, 0xFF, 0xFF]),
    ];

    // Twelve bytes that claim a list of two billion compounds.
    let mut huge_list = vec![0x0A, 0x00, 0x00, 0x09];
    nbt_string(&mut huge_list, "servers");
    huge_list.push(0x0A);
    huge_list.extend_from_slice(&i32::MAX.to_be_bytes());
    cases.push(("list claiming i32::MAX elements", huge_list));

    // A byte array claiming two gigabytes of payload.
    let mut huge_array = vec![0x0A, 0x00, 0x00, 0x07];
    nbt_string(&mut huge_array, "icon");
    huge_array.extend_from_slice(&i32::MAX.to_be_bytes());
    cases.push(("byte array claiming i32::MAX bytes", huge_array));

    // A string claiming the maximum 16-bit length with no bytes behind it.
    let mut huge_string = vec![0x0A, 0x00, 0x00, 0x08];
    nbt_string(&mut huge_string, "name");
    huge_string.extend_from_slice(&u16::MAX.to_be_bytes());
    cases.push(("string claiming u16::MAX bytes", huge_string));

    // Nesting deep enough that an unguarded recursive walker would exhaust the
    // stack; the parser must reject on depth, not recurse to the bottom.
    cases.push(("200k nested lists", nested_lists(200_000)));
    cases.push(("200k nested compounds", nested_compounds(200_000)));

    // A compound that never terminates.
    let mut unterminated = vec![0x0A, 0x00, 0x00, 0x08];
    nbt_string(&mut unterminated, "name");
    nbt_string(&mut unterminated, "value");
    cases.push(("unterminated compound", unterminated));

    cases
}

/// A list of `count` ten-byte compounds: the densest entry the size bound
/// allows, and the shape that used to cost a tag tree plus a JSON value each.
fn dense_ten_byte_entries(count: usize) -> Vec<u8> {
    let mut out = vec![0x0A, 0x00, 0x00, 0x09];
    nbt_string(&mut out, "servers");
    out.push(0x0A);
    out.extend_from_slice(&(count as i32).to_be_bytes());
    for _ in 0..count {
        out.push(0x08); // string field
        nbt_string(&mut out, "a");
        out.extend_from_slice(&3_u16.to_be_bytes());
        out.extend_from_slice(b"xxx");
        out.push(0x00);
    }
    out.push(0x00);
    out
}

/// Input the parser rejects because the file's own declared structure is
/// impossible, not because its bytes are corrupt. These use the structural exit
/// code so the JavaScript wrapper re-raises them instead of re-parsing the same
/// bytes with a fallback that has no item budget and would build every
/// declared record.
fn servers_dat_structural_corpus() -> Vec<(&'static str, Vec<u8>)> {
    let mut cases = Vec::new();

    // Array lengths at the declaration limit, with no payload at all: the root
    // field plus the declared count is already past the item budget.
    for (label, kind) in [
        ("int array declaring 1M entries", 0x0Bu8),
        ("long array declaring 1M entries", 0x0Cu8),
    ] {
        let mut bytes = vec![0x0A, 0x00, 0x00, kind];
        nbt_string(&mut bytes, "values");
        bytes.extend_from_slice(&1_000_000_i32.to_be_bytes());
        cases.push((label, bytes));
    }

    // A dense list past the item budget: 500k ten-byte compounds spend 500k list
    // items plus 500k field items. The size bound alone would admit it, so the
    // budget is what rejects it.
    cases.push((
        "500k ten-byte compounds past the item budget",
        dense_ten_byte_entries(500_000),
    ));

    cases
}

#[test]
fn servers_dat_accepts_a_dense_ten_byte_list_in_bounded_time() {
    // The dense shape that used to cost a tag tree plus a JSON value per entry:
    // 100k ten-byte compounds in ~1 MB. It is inside the bound and the item
    // budget, so it must parse, and it must stay proportional to its own bytes.
    let directory = temp_dir("nbt-dense");
    let bytes = dense_ten_byte_entries(100_000);
    assert!(
        bytes.len() < 2 * 1024 * 1024,
        "the dense fixture should be about a megabyte"
    );
    let path = write_case(&directory, "dense.dat", &bytes);

    let started = Instant::now();
    let outcome = run(SERVERS_DAT, &[path_str(&path)], &[], TIMEOUT);
    let elapsed = started.elapsed();

    assert_accepted("100k ten-byte compounds", &outcome);
    assert!(
        elapsed < Duration::from_secs(10),
        "the dense list took {elapsed:?} to parse"
    );

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn servers_dat_rejects_the_structural_corpus_with_the_retry_free_exit_code() {
    let directory = temp_dir("nbt-structural");
    for (label, bytes) in servers_dat_structural_corpus() {
        let case_path = write_case(&directory, "case.dat", &bytes);
        let started = Instant::now();
        let outcome = run(SERVERS_DAT, &[path_str(&case_path)], &[], TIMEOUT);
        let elapsed = started.elapsed();
        assert_structurally_rejected(label, &outcome);
        assert!(
            elapsed < Duration::from_secs(10),
            "{label}: took {elapsed:?} to reject"
        );
    }
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn servers_dat_survives_handcrafted_corpus() {
    let directory = temp_dir("nbt");
    let path = write_case(&directory, "servers.dat", b"");
    let _ = path;

    let mut rejected = 0;
    for (label, bytes) in servers_dat_corpus() {
        let case_path = write_case(&directory, "case.dat", &bytes);
        let outcome = run(SERVERS_DAT, &[path_str(&case_path)], &[], TIMEOUT);
        assert_rejected(label, &outcome);
        rejected += 1;
    }
    // The structurally-rejected cases live in their own corpus but still count,
    // so the guard notices if either set shrinks.
    rejected += servers_dat_structural_corpus().len();
    assert!(rejected >= 19, "corpus shrank unexpectedly");

#[test]
fn servers_dat_rejects_a_flood_of_content_free_entries_immediately() {
    // The known break: ~900k one-byte empty compounds in a ~1 MiB file. Before
    // the bound this cost ~3.4 s release / ~16 s debug and hundreds of MB; now
    // the declared count is compared against the file's own byte count before
    // any element is allocated, so it must reject in well under a second.
    let directory = temp_dir("nbt-entry-flood");
    let mut bytes = vec![0x0A, 0x00, 0x00, 0x09];
    nbt_string(&mut bytes, "servers");
    bytes.push(0x0A);
    bytes.extend_from_slice(&900_000_i32.to_be_bytes());
    bytes.extend(std::iter::repeat_n(0x00u8, 900_000));
    bytes.push(0x00);
    let path = write_case(&directory, "servers.dat", &bytes);
    assert!(
        bytes.len() < 1024 * 1024,
        "the fixture must stay the size of the reported break"
    );

    let started = Instant::now();
    let outcome = run(SERVERS_DAT, &[path_str(&path)], &[], Duration::from_secs(60));
    let elapsed = started.elapsed();

    assert_structurally_rejected("900k empty compounds", &outcome);
    assert!(
        elapsed < Duration::from_secs(1),
        "the padding flood took {elapsed:?} to reject"
    );

    fs::remove_dir_all(directory).unwrap();
}

/// One compound list element of exactly `size` bytes: a string field with a
/// one-character name and a payload sized to make the total exact.
fn sized_element(out: &mut Vec<u8>, size: usize) {
    let payload = size - 7; // tag(1) + name-len(2) + name(1) + len(2) + payload + end(1)
    out.push(0x08);
    nbt_string(out, "a");
    out.extend_from_slice(&(payload as u16).to_be_bytes());
    out.extend(std::iter::repeat_n(b'x', payload));
    out.push(0x00);
}

fn servers_dat_with_sized_entries(count: usize, entry_size: usize) -> Vec<u8> {
    let mut out = vec![0x0A, 0x00, 0x00, 0x09];
    nbt_string(&mut out, "servers");
    out.push(0x0A);
    out.extend_from_slice(&(count as i32).to_be_bytes());
    for _ in 0..count {
        sized_element(&mut out, entry_size);
    }
    out.push(0x00);
    out
}

#[test]
fn the_entry_bound_is_a_clean_edge_not_a_cliff() {
    let directory = temp_dir("nbt-bound-edge");

    // Entries carrying ten or more bytes each are supportable at any count the
    // item budget allows: the declared list is accepted and parses normally.
    for (label, entry_size, count) in [
        ("ten-byte entries", 10usize, 1_000usize),
        ("eleven-byte entries", 11, 1_000),
        ("realistic large list", 200, 3_000),
        ("single entry", 11, 1),
    ] {
        let bytes = servers_dat_with_sized_entries(count, entry_size);
        let path = write_case(&directory, "edge.dat", &bytes);
        assert_accepted(
            label,
            &run(SERVERS_DAT, &[path_str(&path)], &[], TIMEOUT),
        );
    }

    // The same entry count carried in fewer bytes per entry is impossible: the
    // declared list cannot fit in the file, so it is rejected cleanly.
    for (label, entry_size, count) in [
        ("nine-byte entries", 9usize, 1_000usize),
        ("nine-byte entries, more of them", 9, 20_000),
    ] {
        let bytes = servers_dat_with_sized_entries(count, entry_size);
        let path = write_case(&directory, "edge.dat", &bytes);
        assert_structurally_rejected(
            label,
            &run(SERVERS_DAT, &[path_str(&path)], &[], TIMEOUT),
        );
    }

    fs::remove_dir_all(directory).unwrap();
}

    // The parser still accepts a valid file after all of that.
    let valid_path = write_case(&directory, "valid.dat", &servers_dat_fixture());
    assert_accepted(
        "valid servers.dat",
        &run(SERVERS_DAT, &[path_str(&valid_path)], &[], TIMEOUT),
    );

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn servers_dat_survives_truncation_at_every_offset() {
    let directory = temp_dir("nbt-truncated");
    let valid = servers_dat_fixture();
    let path = write_case(&directory, "servers.dat", b"");

    for length in 0..valid.len() {
        fs::write(&path, &valid[..length]).unwrap();
        let outcome = run(SERVERS_DAT, &[path_str(&path)], &[], TIMEOUT);
        assert_clean(&format!("raw prefix {length}/{}", valid.len()), &outcome);
    }
    fs::write(&path, &valid).unwrap();
    assert_accepted(
        "complete file",
        &run(SERVERS_DAT, &[path_str(&path)], &[], TIMEOUT),
    );

    let compressed = gzip(&valid);
    for length in 0..compressed.len() {
        fs::write(&path, &compressed[..length]).unwrap();
        let outcome = run(SERVERS_DAT, &[path_str(&path)], &[], TIMEOUT);
        assert_clean(&format!("gzip prefix {length}/{}", compressed.len()), &outcome);
    }
    fs::write(&path, &compressed).unwrap();
    assert_accepted(
        "complete gzip file",
        &run(SERVERS_DAT, &[path_str(&path)], &[], TIMEOUT),
    );

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn servers_dat_rejects_a_gzip_bomb_without_running_out_of_memory() {
    let directory = temp_dir("gzip-bomb");
    // 96 MiB of zeroes compresses to a few kilobytes; the decompressed size
    // limit (64 MiB) must stop it before it becomes an allocation problem.
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let chunk = vec![0u8; 1024 * 1024];
    for _ in 0..96 {
        encoder.write_all(&chunk).unwrap();
    }
    let bomb = encoder.finish().unwrap();
    assert!(bomb.len() < 1024 * 1024, "bomb fixture should be tiny on disk");
    let path = write_case(&directory, "bomb.dat", &bomb);

    let outcome = run(SERVERS_DAT, &[path_str(&path)], &[], Duration::from_secs(30));
    assert_rejected("gzip bomb", &outcome);

    fs::remove_dir_all(directory).unwrap();
}

// ── ZIP archive (modpack metadata) builders ─────────────────────────────────

struct BuiltZip {
    bytes: Vec<u8>,
    /// Absolute offsets of the local file headers, in entry order.
    local: Vec<usize>,
    /// Absolute offsets of the central directory records, in entry order.
    central: Vec<usize>,
    eocd: usize,
}

fn build_zip(entries: &[(&str, &[u8])]) -> BuiltZip {
    let mut bytes = Vec::new();
    let mut local_offsets = Vec::new();
    let mut central_records = Vec::new();
    let mut central = Vec::new();

    for (name, data) in entries {
        let name_bytes = name.as_bytes();
        let local_offset = bytes.len();
        local_offsets.push(local_offset);
        bytes.extend_from_slice(&0x0403_4b50_u32.to_le_bytes());
        bytes.extend_from_slice(&20_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(name_bytes);
        bytes.extend_from_slice(data);

        central_records.push(central.len());
        central.extend_from_slice(&0x0201_4b50_u32.to_le_bytes());
        central.extend_from_slice(&20_u16.to_le_bytes());
        central.extend_from_slice(&20_u16.to_le_bytes());
        central.extend_from_slice(&0_u16.to_le_bytes());
        central.extend_from_slice(&0_u16.to_le_bytes());
        central.extend_from_slice(&0_u16.to_le_bytes());
        central.extend_from_slice(&0_u16.to_le_bytes());
        central.extend_from_slice(&0_u32.to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central.extend_from_slice(&0_u16.to_le_bytes());
        central.extend_from_slice(&0_u16.to_le_bytes());
        central.extend_from_slice(&0_u16.to_le_bytes());
        central.extend_from_slice(&0_u16.to_le_bytes());
        central.extend_from_slice(&0_u16.to_le_bytes());
        central.extend_from_slice(&0_u16.to_le_bytes());
        central.extend_from_slice(&(local_offset as u32).to_le_bytes());
        central.extend_from_slice(name_bytes);
    }

    let directory_offset = bytes.len();
    bytes.extend_from_slice(&central);
    let eocd = bytes.len();
    bytes.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&(central.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(directory_offset as u32).to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());

    BuiltZip {
        bytes,
        local: local_offsets,
        central: central_records
            .iter()
            .map(|offset| offset + directory_offset)
            .collect(),
        eocd,
    }
}

fn manifest_bytes() -> Vec<u8> {
    br#"{"formatVersion":1,"game":"minecraft","name":"Probe","dependencies":{"minecraft":"1.21.4"},"files":[]}"#.to_vec()
}

fn modpack_zip() -> BuiltZip {
    let manifest = manifest_bytes();
    build_zip(&[
        ("modrinth.index.json", &manifest),
        ("overrides/config/mod.toml", b"value = 1\n"),
    ])
}

/// A ZIP whose single entry is deflated, so the archive's own bytes are far
/// smaller than the payload it declares.
fn deflated_zip(name: &str, payload: &[u8]) -> Vec<u8> {
    let mut encoder =
        flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(payload).unwrap();
    let compressed = encoder.finish().unwrap();
    let name_bytes = name.as_bytes();

    let mut bytes = Vec::new();
    bytes.extend_from_slice(&0x0403_4b50_u32.to_le_bytes());
    bytes.extend_from_slice(&20_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&8_u16.to_le_bytes()); // method: deflate
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    bytes.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(name_bytes);
    bytes.extend_from_slice(&compressed);

    let directory_offset = bytes.len();
    bytes.extend_from_slice(&0x0201_4b50_u32.to_le_bytes());
    bytes.extend_from_slice(&20_u16.to_le_bytes());
    bytes.extend_from_slice(&20_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&8_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    bytes.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes()); // extra length
    bytes.extend_from_slice(&0_u16.to_le_bytes()); // comment length
    bytes.extend_from_slice(&0_u16.to_le_bytes()); // disk number
    bytes.extend_from_slice(&0_u16.to_le_bytes()); // internal attributes
    bytes.extend_from_slice(&0_u32.to_le_bytes()); // external attributes
    bytes.extend_from_slice(&0_u32.to_le_bytes()); // local header offset
    bytes.extend_from_slice(name_bytes);

    bytes.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&((bytes.len() - directory_offset) as u32).to_le_bytes());
    bytes.extend_from_slice(&(directory_offset as u32).to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes
}

/// A valid JSON array of empty objects, sized to exactly `exact_bytes`. Empty
/// objects are the cheapest way to spend JSON-tree memory per input byte.
fn dense_json_array(exact_bytes: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(exact_bytes + 2);
    out.push(b'[');
    let objects = exact_bytes.saturating_sub(1) / 3;
    for index in 0..objects {
        if index > 0 {
            out.push(b',');
        }
        out.extend_from_slice(b"{}");
    }
    out.push(b']');
    while out.len() < exact_bytes {
        out.push(b' '); // trailing whitespace is legal JSON
    }
    out
}

#[test]
fn modpack_manifest_inflation_is_bounded_by_the_archive_size() {
    let directory = temp_dir("zip-manifest-inflation");
    let floor = 2 * 1024 * 1024;
    let inspect = |archive: &[u8]| {
        let path = write_case(&directory, "manifest.zip", archive);
        run(
            MODPACK,
            &["inspect", path_str(&path), "cf"],
            &[],
            Duration::from_secs(30),
        )
    };

    // Just under and exactly at the bound: a legitimate-but-huge manifest is
    // still accepted, so the bound is an edge and not a cliff.
    for (label, size) in [
        ("just under the inflation bound", floor - 1),
        ("exactly at the inflation bound", floor),
    ] {
        let archive = deflated_zip("manifest.json", &dense_json_array(size));
        assert!(
            archive.len() < 64 * 1024,
            "{label}: the fixture must stay tiny on disk ({} bytes)",
            archive.len()
        );
        assert_accepted(label, &inspect(&archive));
    }

    // One byte past what the compressed entry can justify: rejected, not parsed.
    let over = deflated_zip("manifest.json", &dense_json_array(floor + 1));
    assert_structurally_rejected("one byte over the inflation bound", &inspect(&over));

    // The reported break: a tiny archive declaring 16 MiB of manifest. Before
    // the bound this cost ~0.9 s and ~590 MB of JSON tree.
    let bomb = deflated_zip("manifest.json", &dense_json_array(16 * 1024 * 1024));
    assert!(bomb.len() < 64 * 1024, "the bomb fixture must be tiny on disk");
    let started = Instant::now();
    let outcome = inspect(&bomb);
    let elapsed = started.elapsed();
    assert_structurally_rejected("16 MiB manifest behind a tiny archive", &outcome);
    assert!(
        elapsed < Duration::from_secs(5),
        "the inflation bomb took {elapsed:?} to reject"
    );

    fs::remove_dir_all(directory).unwrap();
}

fn zip_corpus() -> Vec<(&'static str, Vec<u8>)> {
    let mut cases: Vec<(&'static str, Vec<u8>)> = vec![
        ("empty file", Vec::new()),
        ("one byte", vec![0x50]),
        ("PK signature only", vec![0x50, 0x4B, 0x05, 0x06]),
        ("all zero, 64 KiB", vec![0x00; 64 * 1024]),
        ("all 0xFF, 64 KiB", vec![0xFF; 64 * 1024]),
    ];

    // EOCD claiming the maximum number of entries in a 22-byte file.
    let mut many_entries = vec![0u8; 22];
    many_entries[0..4].copy_from_slice(&0x0605_4b50_u32.to_le_bytes());
    many_entries[8..10].copy_from_slice(&u16::MAX.to_le_bytes());
    many_entries[10..12].copy_from_slice(&u16::MAX.to_le_bytes());
    cases.push(("EOCD claiming 65535 entries", many_entries));

    // Central directory offset far past the end of the file.
    let mut past_eof = vec![0u8; 22];
    past_eof[0..4].copy_from_slice(&0x0605_4b50_u32.to_le_bytes());
    past_eof[8..10].copy_from_slice(&1_u16.to_le_bytes());
    past_eof[10..12].copy_from_slice(&1_u16.to_le_bytes());
    past_eof[12..16].copy_from_slice(&0xFFFF_FFF0_u32.to_le_bytes());
    past_eof[16..20].copy_from_slice(&0xFFFF_FF00_u32.to_le_bytes());
    cases.push(("central directory past EOF", past_eof));

    // Directory size that overflows when added to its offset.
    let mut overflow = vec![0u8; 22];
    overflow[0..4].copy_from_slice(&0x0605_4b50_u32.to_le_bytes());
    overflow[8..10].copy_from_slice(&1_u16.to_le_bytes());
    overflow[10..12].copy_from_slice(&1_u16.to_le_bytes());
    overflow[12..16].copy_from_slice(&0xFFFF_FFFF_u32.to_le_bytes());
    overflow[16..20].copy_from_slice(&0xFFFF_FFFF_u32.to_le_bytes());
    cases.push(("directory size plus offset overflows", overflow));

    // A real archive with each structural field pushed past the end of file.
    let valid = modpack_zip();
    let mut huge_compressed = valid.bytes.clone();
    let central = valid.central[0];
    huge_compressed[central + 20..central + 24].copy_from_slice(&0xFFFF_FFFF_u32.to_le_bytes());
    cases.push(("entry compressed size past EOF", huge_compressed));

    let mut huge_local = valid.bytes.clone();
    huge_local[central + 42..central + 46].copy_from_slice(&0xFFFF_FFFF_u32.to_le_bytes());
    cases.push(("local header offset past EOF", huge_local));

    let mut huge_name = valid.bytes.clone();
    huge_name[central + 28..central + 30].copy_from_slice(&u16::MAX.to_le_bytes());
    cases.push(("entry name length past EOF", huge_name));

    let mut overlapping = valid.bytes.clone();
    overlapping[valid.eocd + 16..valid.eocd + 20]
        .copy_from_slice(&(valid.eocd as u32).to_le_bytes());
    cases.push(("central directory overlaps EOCD", overlapping));

    let mut bad_signature = valid.bytes.clone();
    bad_signature[central..central + 4].copy_from_slice(&0_u32.to_le_bytes());
    cases.push(("bad central directory signature", bad_signature));

    // Entry that claims to be deflated but holds random bytes.
    let garbage = build_zip(&[("modrinth.index.json", &[0xFF_u8; 64])]);
    let garbage_central = garbage.central[0];
    let mut deflate_garbage = garbage.bytes.clone();
    deflate_garbage[garbage_central + 10..garbage_central + 12]
        .copy_from_slice(&8_u16.to_le_bytes());
    let local = garbage_central;
    deflate_garbage[local + 8..local + 10].copy_from_slice(&8_u16.to_le_bytes());
    cases.push(("corrupt deflate stream", deflate_garbage));

    let built = modpack_zip();
    let mut unsupported = built.bytes.clone();
    unsupported[built.central[0] + 10..built.central[0] + 12]
        .copy_from_slice(&14_u16.to_le_bytes());
    cases.push(("unsupported compression method", unsupported));

    cases
}

#[test]
fn modpack_metadata_survives_handcrafted_zip_corpus() {
    let directory = temp_dir("zip");
    let path = write_case(&directory, "pack.mrpack", b"");

    for (label, bytes) in zip_corpus() {
        fs::write(&path, &bytes).unwrap();
        for format in ["mr", "cf"] {
            let outcome = run(MODPACK, &["inspect", path_str(&path), format], &[], TIMEOUT);
            assert_clean(&format!("{label} ({format})"), &outcome);
            assert_eq!(
                outcome.code,
                Some(1),
                "{label} ({format}): malformed archive must be rejected; stderr: {}",
                outcome.stderr
            );
        }
    }

    // The valid archive still parses in both formats.
    let valid = modpack_zip();
    fs::write(&path, &valid.bytes).unwrap();
    assert_accepted(
        "valid mrpack (mr)",
        &run(MODPACK, &["inspect", path_str(&path), "mr"], &[], TIMEOUT),
    );

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn modpack_metadata_survives_truncation_at_every_offset() {
    let directory = temp_dir("zip-truncated");
    let valid = modpack_zip();
    let path = write_case(&directory, "pack.mrpack", b"");

    for length in 0..valid.bytes.len() {
        fs::write(&path, &valid.bytes[..length]).unwrap();
        let outcome = run(MODPACK, &["inspect", path_str(&path), "mr"], &[], TIMEOUT);
        assert_clean(&format!("prefix {length}/{}", valid.bytes.len()), &outcome);
    }

    fs::write(&path, &valid.bytes).unwrap();
    assert_accepted(
        "complete archive",
        &run(MODPACK, &["inspect", path_str(&path), "mr"], &[], TIMEOUT),
    );

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn modpack_metadata_rejects_a_huge_archive_without_reading_it_all() {
    let directory = temp_dir("zip-huge");
    let path = directory.join("huge.zip");
    // Sparse file: the size guard must reject on metadata alone, before any
    // attempt to read half a gigabyte into memory.
    let file = fs::File::create(&path).unwrap();
    file.set_len(640 * 1024 * 1024).unwrap();
    drop(file);

    let outcome = run(MODPACK, &["inspect", path_str(&path), "mr"], &[], Duration::from_secs(30));
    assert_rejected("640 MiB archive past the size limit", &outcome);

    fs::remove_file(&path).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

// ── server.properties ───────────────────────────────────────────────────────

#[test]
fn server_properties_survives_adversarial_text() {
    let directory = temp_dir("properties");
    let path = write_case(&directory, "server.properties", b"");

    let corpus: Vec<(&str, Vec<u8>)> = vec![
        ("empty file", Vec::new()),
        ("one byte", vec![b'=']),
        ("all zero", vec![0u8; 4096]),
        ("all 0xFF (invalid UTF-8)", vec![0xFF_u8; 4096]),
        ("lone continuation bytes", vec![0x80, 0x81, 0x82, 0x83]),
        ("CRLF lines", b"a=b\r\nc=d\r\n".to_vec()),
        ("BOM", b"\xEF\xBB\xBFmotd=hi\n".to_vec()),
        ("NUL bytes", vec![0u8, b'a', b'=', b'b', 0u8]),
        ("one 1 MiB line", {
            let mut bytes = b"motd=".to_vec();
            bytes.extend(std::iter::repeat_n(b'x', 1024 * 1024));
            bytes
        }),
        ("200k lines", {
            let mut bytes = Vec::new();
            for index in 0..200_000 {
                bytes.extend_from_slice(format!("key{index}=value\n").as_bytes());
            }
            bytes
        }),
    ];

    for (label, bytes) in corpus {
        fs::write(&path, &bytes).unwrap();
        let outcome = run(PROPERTIES, &["read", path_str(&path)], &[], TIMEOUT);
        assert_clean(label, &outcome);
    }

    // Writing rejects payloads that are not an array of pairs, cleanly.
    for (label, payload) in [
        ("not JSON", "definitely not json"),
        ("JSON object", r#"{"motd":"hi"}"#),
        ("JSON null", "null"),
        ("nested arrays", "[[[[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]]]"),
    ] {
        let outcome = run(
            PROPERTIES,
            &["write", path_str(&path)],
            payload.as_bytes(),
            TIMEOUT,
        );
        assert_rejected(label, &outcome);
    }

    // A directory is not a properties file.
    let outcome = run(PROPERTIES, &["read", path_str(&directory)], &[], TIMEOUT);
    assert_rejected("directory as properties file", &outcome);

    fs::remove_dir_all(directory).unwrap();
}

// ── skins.json ──────────────────────────────────────────────────────────────

#[test]
fn skin_library_hydration_is_bounded_by_the_metadata_it_was_given() {
    // One 4 MiB image named by 100 entries: 10 KiB of metadata asking for 533 MB
    // of base64. Before the budget this took ~16 s and ~1 GB of RSS.
    let directory = temp_dir("skins-hydration");
    let hostile = directory.join("hostile");
    fs::create_dir_all(&hostile).unwrap();
    let image = hostile.join("big.png");
    fs::write(&image, vec![7u8; 4 * 1024 * 1024]).unwrap();
    let image_json = image.to_string_lossy().replace('\\', "\\\\");
    let entries: Vec<String> = (0..100)
        .map(|index| {
            format!(r#"{{"id":"s{index}","name":"Skin {index}","filePath":"{image_json}"}}"#)
        })
        .collect();
    fs::write(
        hostile.join("skins.json"),
        format!("[{}]", entries.join(",")),
    )
    .unwrap();

    let started = Instant::now();
    let outcome = run(
        SKINS,
        &["get", path_str(&hostile)],
        &[],
        Duration::from_secs(30),
    );
    let elapsed = started.elapsed();
    assert_rejected("100 references to one 4 MiB image", &outcome);
    assert!(
        outcome.stderr.contains("render budget"),
        "the rejection must explain the budget; stderr: {}",
        outcome.stderr
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "hydration took {elapsed:?} to reject"
    );

    // The bound is not a cliff: an ordinary library and one large-but-legitimate
    // skin (40 MiB of image, ~53 MiB encoded) both still hydrate.
    let legit = directory.join("legit");
    fs::create_dir_all(&legit).unwrap();
    let mut legit_entries = Vec::new();
    for index in 0..3 {
        let path = legit.join(format!("s{index}.png"));
        fs::write(&path, vec![index as u8; 20 * 1024]).unwrap();
        legit_entries.push(format!(
            r#"{{"id":"s{index}","filePath":"{}"}}"#,
            path.to_string_lossy().replace('\\', "\\\\")
        ));
    }
    fs::write(
        legit.join("skins.json"),
        format!("[{}]", legit_entries.join(",")),
    )
    .unwrap();
    assert_accepted(
        "three ordinary skins",
        &run(SKINS, &["get", path_str(&legit)], &[], TIMEOUT),
    );

    let large = directory.join("large");
    fs::create_dir_all(&large).unwrap();
    let large_image = large.join("large.png");
    fs::write(&large_image, vec![3u8; 40 * 1024 * 1024]).unwrap();
    fs::write(
        large.join("skins.json"),
        format!(
            r#"[{{"id":"large","filePath":"{}"}}]"#,
            large_image.to_string_lossy().replace('\\', "\\\\")
        ),
    )
    .unwrap();
    assert_accepted(
        "one 40 MiB skin past the old amplification",
        &run(SKINS, &["get", path_str(&large)], &[], Duration::from_secs(60)),
    );

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn skin_library_survives_adversarial_metadata() {
    let directory = temp_dir("skins");
    let metadata = directory.join("skins.json");

    // Missing metadata is an empty library, not an error.
    assert_accepted(
        "missing skins.json",
        &run(SKINS, &["get", path_str(&directory)], &[], TIMEOUT),
    );

    let deeply_nested = {
        let mut json = String::new();
        for _ in 0..20_000 {
            json.push('[');
        }
        for _ in 0..20_000 {
            json.push(']');
        }
        json
    };

    let corpus: Vec<(&str, String)> = vec![
        ("empty file", String::new()),
        ("JSON null", "null".into()),
        ("JSON object", "{}".into()),
        ("JSON string", "\"nope\"".into()),
        ("truncated array", "[{\"id\":\"one\"".into()),
        ("invalid UTF-8 bytes", String::new()),
        ("20k nested arrays", deeply_nested),
        ("non-object entries", "[1,2,3,null,\"x\"]".into()),
        ("filePath to a directory", format!("[{{\"id\":\"a\",\"filePath\":\"{}\"}}]", path_str(&directory))),
        ("filePath escaping the folder", "[{\"id\":\"a\",\"filePath\":\"../../../etc/passwd\"}]".into()),
        ("huge array", format!("[{}]", (0..50_000).map(|index| format!("{{\"id\":\"{index}\"}}")).collect::<Vec<_>>().join(","))),
    ];

    for (label, contents) in corpus {
        if label == "invalid UTF-8 bytes" {
            fs::write(&metadata, [0xFF_u8, 0xFE, 0x7B]).unwrap();
        } else {
            fs::write(&metadata, contents.as_bytes()).unwrap();
        }
        let outcome = run(SKINS, &["get", path_str(&directory)], &[], TIMEOUT);
        assert_clean(label, &outcome);
    }

    // A valid library still loads.
    fs::write(&metadata, r#"[{"id":"one"}]"#).unwrap();
    assert_accepted(
        "valid skins.json",
        &run(SKINS, &["get", path_str(&directory)], &[], TIMEOUT),
    );

    // Saving with a hostile id must be refused, not crash and not escape.
    fs::write(&metadata, "[]").unwrap();
    for id in ["../outside", "C:/outside", "..\\\\outside"] {
        let payload = format!(
            r#"{{"id":"{id}","dataUrl":"data:image/png;base64,AQID"}}"#
        );
        let outcome = run(SKINS, &["save", path_str(&directory)], payload.as_bytes(), TIMEOUT);
        assert_rejected(&format!("save with id {id:?}"), &outcome);
    }

    fs::remove_dir_all(directory).unwrap();
}

// ── filesystem listers ──────────────────────────────────────────────────────

#[test]
fn directory_listers_survive_adversarial_paths() {
    let directory = temp_dir("listers");
    let file = write_case(&directory, "plain.txt", b"data");
    let missing = directory.join("missing");
    let odd_names = directory.join("odd");
    fs::create_dir_all(&odd_names).unwrap();
    for name in [
        "space name.toml",
        "unicode-🌍-name.JSON",
        "extremely-long-file-name-that-goes-on-and-on-and-on-and-on-and-on-and-on-for-a-while.toml",
        ".hidden",
        "double..dot.toml",
        "trailing-dot.",
    ] {
        fs::write(odd_names.join(name), b"fixture").unwrap();
    }

    for binary in [WORLDS, CONFIGS, SCREENSHOTS, JARS] {
        for path in [&file, &missing] {
            let outcome = run(binary, &[path_str(path)], &[], TIMEOUT);
            assert_clean(&format!("{binary} on {}", path.display()), &outcome);
        }
    }

    // The config lister still finds real files among the odd names.
    let outcome = run(CONFIGS, &[path_str(&odd_names)], &[], TIMEOUT);
    assert_accepted("config listing with odd names", &outcome);

    fs::remove_dir_all(directory).unwrap();
}

#[cfg(windows)]
fn make_directory_link(link: &Path, target: &Path) -> bool {
    Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn make_directory_link(link: &Path, target: &Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

#[test]
fn config_file_list_does_not_follow_a_directory_cycle() {
    let root = temp_dir("cycle");
    let config = root.join("config");
    fs::create_dir_all(&config).unwrap();
    fs::write(config.join("mod.toml"), b"value = 1\n").unwrap();

    // A link inside the folder that points back at the folder: an unguarded
    // recursive walk would descend forever and overflow the stack.
    let cycle = config.join("cycle");
    if !make_directory_link(&cycle, &config) {
        // Junction creation needs no privileges on Windows; if it is refused,
        // skip rather than fail on a locked-down machine.
        eprintln!("skipping cycle test: could not create a directory link");
        fs::remove_dir_all(&root).unwrap();
        return;
    }

    let outcome = run(CONFIGS, &[path_str(&config)], &[], TIMEOUT);
    assert_accepted("config folder containing a directory cycle", &outcome);

    // Remove the link itself first: recursive deletion must never walk into it.
    let _ = fs::remove_dir(&cycle);
    fs::remove_dir_all(&root).unwrap();
}
