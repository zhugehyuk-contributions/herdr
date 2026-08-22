//! Multi-platform "fat" herdr bundle (issue #28).
//!
//! A normal herdr build produces a binary for one os/arch. An opt-in `just bundle`
//! step cross-compiles the other supported platforms and appends them to the native
//! binary as a compressed, indexed payload. Trailing bytes after a normal executable
//! image are ignored by the OS, so the file still runs natively while carrying the
//! sibling binaries as data — letting `herdr --remote <host>` seed a different-OS host
//! offline at exact version parity. Cross-platform seeding installs a bundle re-targeted
//! for the remote ([`repack_for_entry`]), not a bare binary, so the seeded remote can in
//! turn seed every platform the original carrier could — including the carrier's own.
//!
//! On-disk layout of a fat binary:
//! ```text
//! [ executable image (native binary, unchanged) ]
//! [ deflate-compressed binary for platform 0 ]
//! [ deflate-compressed binary for platform 1 ]
//! ...
//! [ index JSON (UTF-8, uncompressed) ]
//! [ footer: 28 bytes, magic last ]
//! ```
//!
//! Footer (little-endian, magic at the very end so it can be found from EOF):
//! ```text
//! index_offset  u64     absolute offset of the index JSON
//! index_len     u64     length of the index JSON in bytes
//! format        u32     bundle format version (currently 1)
//! magic         [u8;8]  b"HERDRBND"
//! ```

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Trailing 8-byte marker identifying a herdr fat bundle.
const MAGIC: &[u8; 8] = b"HERDRBND";
/// Current bundle format version. Bumped on incompatible layout changes; readers
/// that see a newer version fall back cleanly (treat the file as un-bundled).
const FORMAT_VERSION: u32 = 1;
/// Fixed footer size: index_offset(8) + index_len(8) + format(4) + magic(8).
const FOOTER_LEN: u64 = 28;
/// deflate compression level for appended binaries. Higher than the wire render path (level 1,
/// chosen for latency) because packing is a one-shot offline step where a smaller bundle wins.
const COMPRESSION_LEVEL: u8 = 6;
/// Hard ceiling on a decompressed bundle entry. A herdr binary is tens of MB; this bounds the
/// inflate so a corrupt/oversized `uncompressed_len` in the index can't drive an unbounded
/// allocation (the entry's length + CRC are still verified against this output afterwards).
const MAX_BUNDLE_PAYLOAD: usize = 1024 * 1024 * 1024;

/// A single platform's binary carried inside a fat bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct BundleEntry {
    pub os: String,
    pub arch: String,
    /// Absolute byte offset of this entry's deflate-compressed bytes.
    pub offset: u64,
    pub compressed_len: u64,
    pub uncompressed_len: u64,
    /// IEEE CRC-32 of the uncompressed bytes (integrity check on extract).
    pub crc32: u32,
}

impl BundleEntry {
    pub(crate) fn asset_key(&self) -> String {
        format!("{}-{}", self.os, self.arch)
    }
}

/// The index describing every platform carried by a fat bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct BundleIndex {
    pub format: u32,
    /// herdr package version every carried binary was built at (e.g. "0.6.4").
    pub herdr_version: String,
    /// Build commit the bundle was packed at, when known (for exact parity).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_commit: Option<String>,
    /// Length of the native executable image (where the appended payload starts).
    pub image_len: u64,
    pub entries: Vec<BundleEntry>,
}

impl BundleIndex {
    /// Find the carried binary for `os`/`arch`, if present.
    pub(crate) fn entry_for(&self, os: &str, arch: &str) -> Option<&BundleEntry> {
        self.entries
            .iter()
            .find(|entry| entry.os == os && entry.arch == arch)
    }
}

/// One platform's binary to pack into a fat bundle.
#[derive(Debug, Clone)]
pub(crate) struct PackInput {
    pub os: String,
    pub arch: String,
    pub binary: PathBuf,
}

/// The os/arch of the currently-running binary, in bundle asset-key terms
/// (e.g. `("macos", "aarch64")`). `None` on a platform herdr does not bundle.
pub(crate) fn local_os_arch() -> Option<(&'static str, &'static str)> {
    let os = if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        return None;
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        return None;
    };
    Some((os, arch))
}

/// IEEE CRC-32 (reflected, polynomial 0xEDB88320) of `data`.
pub(crate) fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// Read `len` bytes at `offset`, first validating the region against the file length
/// so a corrupt offset/length from an (untrusted) index can't drive an unbounded
/// allocation before `read_exact` could fail.
fn read_file_region(
    file: &mut File,
    file_len: u64,
    offset: u64,
    len: u64,
    what: &str,
) -> io::Result<Vec<u8>> {
    let in_bounds = offset.checked_add(len).is_some_and(|end| end <= file_len);
    if !in_bounds {
        return Err(io::Error::other(format!(
            "{what} is out of bounds (offset {offset} + len {len} exceeds file {file_len})"
        )));
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![0u8; len as usize];
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

/// Read the bundle index from `path`, or `Ok(None)` if the file carries no
/// (recognizable, current-format) bundle. Returns `Err` only when the file is
/// marked as a herdr bundle but its index cannot be read or parsed.
pub(crate) fn read_index(path: &Path) -> io::Result<Option<BundleIndex>> {
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    if file_len < FOOTER_LEN {
        return Ok(None);
    }

    let mut footer = [0u8; FOOTER_LEN as usize];
    file.seek(SeekFrom::Start(file_len - FOOTER_LEN))?;
    file.read_exact(&mut footer)?;
    if &footer[20..28] != MAGIC {
        return Ok(None);
    }
    let format = u32::from_le_bytes(footer[16..20].try_into().unwrap());
    if format != FORMAT_VERSION {
        // Forward-compatible: a newer bundle format reads as "no usable bundle"
        // so callers fall back cleanly instead of misparsing.
        return Ok(None);
    }
    let index_offset = u64::from_le_bytes(footer[0..8].try_into().unwrap());
    let index_len = u64::from_le_bytes(footer[8..16].try_into().unwrap());
    if index_offset > file_len - FOOTER_LEN || index_len > file_len - FOOTER_LEN - index_offset {
        return Ok(None);
    }

    let mut index_bytes = vec![0u8; index_len as usize];
    file.seek(SeekFrom::Start(index_offset))?;
    file.read_exact(&mut index_bytes)?;
    let index: BundleIndex = serde_json::from_slice(&index_bytes)
        .map_err(|err| io::Error::other(format!("herdr bundle index is corrupt: {err}")))?;
    Ok(Some(index))
}

/// Read the bundle index carried by the currently-running executable.
pub(crate) fn read_self_index() -> io::Result<Option<BundleIndex>> {
    read_index(&std::env::current_exe()?)
}

/// Extract and decompress one carried binary, verifying its length and CRC-32.
pub(crate) fn extract_entry(path: &Path, entry: &BundleEntry) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    // `read_index` bounds only the index itself; the entry's own region is validated
    // here before allocating.
    let file_len = file.metadata()?.len();
    let compressed = read_file_region(
        &mut file,
        file_len,
        entry.offset,
        entry.compressed_len,
        &format!("{} entry", entry.asset_key()),
    )?;

    // Bound the inflate too: cap at the claimed (but untrusted) uncompressed length, clamped to a
    // sane ceiling, so a bogus `uncompressed_len` can't drive an unbounded allocation either.
    let limit = (entry.uncompressed_len as usize).min(MAX_BUNDLE_PAYLOAD);
    let bytes =
        miniz_oxide::inflate::decompress_to_vec_with_limit(&compressed, limit).map_err(|err| {
            io::Error::other(format!(
                "failed to decompress {} payload: {err:?}",
                entry.asset_key()
            ))
        })?;
    if bytes.len() as u64 != entry.uncompressed_len {
        return Err(io::Error::other(format!(
            "{} payload length mismatch: expected {}, got {}",
            entry.asset_key(),
            entry.uncompressed_len,
            bytes.len()
        )));
    }
    if crc32(&bytes) != entry.crc32 {
        return Err(io::Error::other(format!(
            "{} payload failed CRC-32 check",
            entry.asset_key()
        )));
    }
    Ok(bytes)
}

/// Bytes of the native executable image at the front of a (possibly already-fat)
/// carrier: if it already carries a bundle, the existing payload is dropped.
fn carrier_image_bytes(carrier_path: &Path) -> io::Result<Vec<u8>> {
    let mut bytes = fs::read(carrier_path)?;
    if let Some(index) = read_index(carrier_path)? {
        bytes.truncate(index.image_len as usize);
    }
    Ok(bytes)
}

/// One platform's payload in already-compressed form, ready to append to an image.
struct RawPart {
    os: String,
    arch: String,
    compressed: Vec<u8>,
    uncompressed_len: u64,
    crc32: u32,
}

impl RawPart {
    fn compress(os: &str, arch: &str, raw: &[u8]) -> Self {
        Self {
            os: os.to_string(),
            arch: arch.to_string(),
            compressed: miniz_oxide::deflate::compress_to_vec(raw, COMPRESSION_LEVEL),
            uncompressed_len: raw.len() as u64,
            crc32: crc32(raw),
        }
    }
}

/// Append `parts` (in stable os/arch order, so identical inputs yield an identical
/// layout), the index JSON, and the footer to the executable `image`.
fn assemble(
    image: Vec<u8>,
    mut parts: Vec<RawPart>,
    herdr_version: &str,
    build_commit: Option<&str>,
) -> (Vec<u8>, BundleIndex) {
    let mut output = image;
    let image_len = output.len() as u64;
    parts.sort_by(|a, b| (&a.os, &a.arch).cmp(&(&b.os, &b.arch)));

    let mut entries = Vec::with_capacity(parts.len());
    for part in &parts {
        entries.push(BundleEntry {
            os: part.os.clone(),
            arch: part.arch.clone(),
            offset: output.len() as u64,
            compressed_len: part.compressed.len() as u64,
            uncompressed_len: part.uncompressed_len,
            crc32: part.crc32,
        });
        output.extend_from_slice(&part.compressed);
    }

    let index = BundleIndex {
        format: FORMAT_VERSION,
        herdr_version: herdr_version.to_string(),
        build_commit: build_commit.map(str::to_string),
        image_len,
        entries,
    };

    let index_json = serde_json::to_vec(&index).expect("bundle index serializes");
    let index_offset = output.len() as u64;
    output.extend_from_slice(&index_json);

    output.extend_from_slice(&index_offset.to_le_bytes());
    output.extend_from_slice(&(index_json.len() as u64).to_le_bytes());
    output.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    output.extend_from_slice(MAGIC);

    (output, index)
}

/// Build a fat binary at `out_path` from `carrier_path` plus `inputs`. If `carrier_path`
/// already carries a bundle, its existing payload is stripped first (idempotent re-pack).
pub(crate) fn pack(
    carrier_path: &Path,
    inputs: &[PackInput],
    herdr_version: &str,
    build_commit: Option<&str>,
    out_path: &Path,
) -> io::Result<BundleIndex> {
    let image = carrier_image_bytes(carrier_path)?;

    let mut parts = Vec::with_capacity(inputs.len());
    for input in inputs {
        let raw = fs::read(&input.binary)?;
        parts.push(RawPart::compress(&input.os, &input.arch, &raw));
    }

    let (output, index) = assemble(image, parts, herdr_version, build_commit);
    write_executable(out_path, &output)?;
    Ok(index)
}

/// Re-target the fat bundle at `path`: build fat-binary bytes whose native image is the
/// carried `target` entry. The other carried platforms are copied verbatim (still
/// compressed), and the carrier's own native image — present in the source bundle only
/// as the uncompressed executable at the front — is compressed in under the `host`
/// os/arch. Version and commit are inherited from the source index, so the result seeds
/// at the same exact parity. This keeps cross-platform seeding transitive: a remote
/// installed from the repacked bundle can itself seed every platform the original
/// carrier could, including the original carrier's own.
pub(crate) fn repack_for_entry(
    path: &Path,
    index: &BundleIndex,
    target: &BundleEntry,
    host: Option<(&str, &str)>,
) -> io::Result<Vec<u8>> {
    let image = extract_entry(path, target)?;

    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();

    let mut parts = Vec::with_capacity(index.entries.len());
    for entry in &index.entries {
        if entry.os == target.os && entry.arch == target.arch {
            continue;
        }
        let compressed = read_file_region(
            &mut file,
            file_len,
            entry.offset,
            entry.compressed_len,
            &format!("{} entry", entry.asset_key()),
        )?;
        parts.push(RawPart {
            os: entry.os.clone(),
            arch: entry.arch.clone(),
            compressed,
            uncompressed_len: entry.uncompressed_len,
            crc32: entry.crc32,
        });
    }

    // Carry the host's own binary too, unless the source bundle already does (or the
    // target IS the host platform, which would duplicate the new image).
    if let Some((host_os, host_arch)) = host {
        let already_carried = (host_os == target.os && host_arch == target.arch)
            || index
                .entries
                .iter()
                .any(|entry| entry.os == host_os && entry.arch == host_arch);
        if !already_carried {
            let host_image =
                read_file_region(&mut file, file_len, 0, index.image_len, "carrier image")?;
            parts.push(RawPart::compress(host_os, host_arch, &host_image));
        }
    }

    let (output, _) = assemble(
        image,
        parts,
        &index.herdr_version,
        index.build_commit.as_deref(),
    );
    Ok(output)
}

/// Write `bytes` to `path` and mark it executable on unix.
fn write_executable(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = File::create(path)?;
    file.write_all(bytes)?;
    file.flush()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = file.metadata()?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Unique temp directory per test invocation; cleaned up by the OS / left for
    /// inspection on failure. Created fresh so parallel tests never collide.
    fn temp_dir() -> PathBuf {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("herdr-bundle-test-{}-{unique}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn sample_inputs(dir: &Path) -> (Vec<PackInput>, Vec<u8>, Vec<u8>) {
        let linux_bytes = b"this-is-the-linux-x86_64-herdr-binary-contents".repeat(50);
        let mac_bytes = b"different-bytes-for-the-macos-aarch64-build!!".repeat(40);
        let linux = write_file(dir, "herdr-linux", &linux_bytes);
        let mac = write_file(dir, "herdr-mac", &mac_bytes);
        let inputs = vec![
            PackInput {
                os: "linux".into(),
                arch: "x86_64".into(),
                binary: linux,
            },
            PackInput {
                os: "macos".into(),
                arch: "aarch64".into(),
                binary: mac,
            },
        ];
        (inputs, linux_bytes, mac_bytes)
    }

    #[test]
    fn crc32_matches_known_vector() {
        // Canonical IEEE CRC-32 check value for "123456789".
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn pack_then_read_index_round_trips() {
        let dir = temp_dir();
        let carrier_bytes = b"NATIVE-CARRIER-EXECUTABLE-IMAGE".repeat(20);
        let carrier = write_file(&dir, "herdr", &carrier_bytes);
        let (inputs, linux_bytes, mac_bytes) = sample_inputs(&dir);
        let out = dir.join("herdr-bundle");

        let returned = pack(&carrier, &inputs, "9.9.9", Some("deadbee"), &out).unwrap();

        let index = read_index(&out).unwrap().expect("bundle present");
        assert_eq!(index, returned);
        assert_eq!(index.format, FORMAT_VERSION);
        assert_eq!(index.herdr_version, "9.9.9");
        assert_eq!(index.build_commit.as_deref(), Some("deadbee"));
        assert_eq!(index.image_len, carrier_bytes.len() as u64);

        let linux = index.entry_for("linux", "x86_64").expect("linux entry");
        assert_eq!(linux.uncompressed_len, linux_bytes.len() as u64);
        assert_eq!(linux.crc32, crc32(&linux_bytes));
        let mac = index.entry_for("macos", "aarch64").expect("mac entry");
        assert_eq!(mac.uncompressed_len, mac_bytes.len() as u64);
        assert_eq!(mac.crc32, crc32(&mac_bytes));
    }

    #[test]
    fn extract_entry_returns_original_bytes() {
        let dir = temp_dir();
        let carrier = write_file(&dir, "herdr", b"CARRIER");
        let (inputs, linux_bytes, mac_bytes) = sample_inputs(&dir);
        let out = dir.join("herdr-bundle");
        let index = pack(&carrier, &inputs, "1.0.0", None, &out).unwrap();

        let linux = extract_entry(&out, index.entry_for("linux", "x86_64").unwrap()).unwrap();
        assert_eq!(linux, linux_bytes);
        let mac = extract_entry(&out, index.entry_for("macos", "aarch64").unwrap()).unwrap();
        assert_eq!(mac, mac_bytes);
    }

    #[test]
    fn carrier_image_prefix_is_unchanged() {
        // The "still runs natively" property: the executable image at the front of
        // the fat file is byte-for-byte the original carrier.
        let dir = temp_dir();
        let carrier_bytes = b"NATIVE-CARRIER-EXECUTABLE-IMAGE".repeat(20);
        let carrier = write_file(&dir, "herdr", &carrier_bytes);
        let (inputs, _, _) = sample_inputs(&dir);
        let out = dir.join("herdr-bundle");
        pack(&carrier, &inputs, "1.0.0", None, &out).unwrap();

        let fat = fs::read(&out).unwrap();
        assert_eq!(&fat[..carrier_bytes.len()], &carrier_bytes[..]);
        assert!(fat.len() > carrier_bytes.len());
    }

    #[test]
    fn read_index_returns_none_for_plain_file() {
        let dir = temp_dir();
        let plain = write_file(
            &dir,
            "plain",
            &b"just an ordinary binary with no bundle".repeat(10),
        );
        assert!(read_index(&plain).unwrap().is_none());

        let tiny = write_file(&dir, "tiny", b"abc");
        assert!(read_index(&tiny).unwrap().is_none());
    }

    #[test]
    fn repack_is_idempotent() {
        let dir = temp_dir();
        let carrier_bytes = b"NATIVE-CARRIER".repeat(30);
        let carrier = write_file(&dir, "herdr", &carrier_bytes);
        let (inputs, _, _) = sample_inputs(&dir);
        let fat1 = dir.join("fat1");
        let index1 = pack(&carrier, &inputs, "2.0.0", Some("abc"), &fat1).unwrap();

        // Re-pack the already-fat binary: the existing payload must be stripped, so
        // image_len and the leading image stay equal to the original carrier.
        let fat2 = dir.join("fat2");
        let index2 = pack(&fat1, &inputs, "2.0.0", Some("abc"), &fat2).unwrap();

        assert_eq!(index2.image_len, carrier_bytes.len() as u64);
        assert_eq!(index1.entries, index2.entries);
        let fat2_bytes = fs::read(&fat2).unwrap();
        assert_eq!(&fat2_bytes[..carrier_bytes.len()], &carrier_bytes[..]);
    }

    #[test]
    fn repack_for_entry_retargets_image_and_carries_host() {
        let dir = temp_dir();
        let carrier_bytes = b"NATIVE-MACOS-X86_64-CARRIER".repeat(30);
        let carrier = write_file(&dir, "herdr", &carrier_bytes);
        let (inputs, linux_bytes, mac_bytes) = sample_inputs(&dir);
        let fat = dir.join("fat");
        let index = pack(&carrier, &inputs, "3.0.0", Some("cafe"), &fat).unwrap();

        // Re-target for the carried linux-x86_64 binary; the carrier itself runs
        // on macos-x86_64 (not among the entries), so it must be compressed in.
        let target = index.entry_for("linux", "x86_64").unwrap();
        let repacked = repack_for_entry(&fat, &index, target, Some(("macos", "x86_64"))).unwrap();
        let out = write_file(&dir, "repacked", &repacked);

        // The new native image is exactly the extracted target binary.
        assert_eq!(&repacked[..linux_bytes.len()], &linux_bytes[..]);
        let new_index = read_index(&out).unwrap().expect("repacked bundle present");
        assert_eq!(new_index.image_len, linux_bytes.len() as u64);
        assert_eq!(new_index.herdr_version, "3.0.0");
        assert_eq!(new_index.build_commit.as_deref(), Some("cafe"));

        // Carried: the untouched sibling plus the original host image.
        assert_eq!(new_index.entries.len(), 2);
        let sibling = new_index.entry_for("macos", "aarch64").expect("sibling");
        let extracted = extract_entry(&out, sibling).unwrap();
        assert_eq!(extracted, mac_bytes);
        let host = new_index.entry_for("macos", "x86_64").expect("host entry");
        let extracted = extract_entry(&out, host).unwrap();
        assert_eq!(extracted, carrier_bytes);
    }

    #[test]
    fn repack_for_entry_round_trips_back_to_original_host() {
        // The transitive-seeding property: mac packs {linux, mac-arm}; the linux
        // remote seeded from a repack can itself repack for the original mac.
        let dir = temp_dir();
        let carrier_bytes = b"ORIGINAL-HOST-IMAGE".repeat(40);
        let carrier = write_file(&dir, "herdr", &carrier_bytes);
        let (inputs, linux_bytes, _) = sample_inputs(&dir);
        let fat = dir.join("fat");
        let index = pack(&carrier, &inputs, "3.0.0", None, &fat).unwrap();

        let target = index.entry_for("linux", "x86_64").unwrap();
        let on_linux = repack_for_entry(&fat, &index, target, Some(("macos", "x86_64"))).unwrap();
        let linux_fat = write_file(&dir, "linux-fat", &on_linux);

        let linux_index = read_index(&linux_fat).unwrap().expect("bundle present");
        let back = linux_index.entry_for("macos", "x86_64").unwrap();
        let on_mac =
            repack_for_entry(&linux_fat, &linux_index, back, Some(("linux", "x86_64"))).unwrap();
        let mac_fat = write_file(&dir, "mac-fat", &on_mac);

        // Back on the original host platform: image is the original carrier and
        // every platform of the original bundle is still carried.
        assert_eq!(&on_mac[..carrier_bytes.len()], &carrier_bytes[..]);
        let mac_index = read_index(&mac_fat).unwrap().expect("bundle present");
        let linux = mac_index.entry_for("linux", "x86_64").expect("linux entry");
        assert_eq!(extract_entry(&mac_fat, linux).unwrap(), linux_bytes);
        assert!(mac_index.entry_for("macos", "aarch64").is_some());
    }

    #[test]
    fn repack_for_entry_does_not_duplicate_carried_or_target_host() {
        let dir = temp_dir();
        let carrier = write_file(&dir, "herdr", &b"CARRIER".repeat(20));
        let (inputs, _, _) = sample_inputs(&dir);
        let fat = dir.join("fat");
        let index = pack(&carrier, &inputs, "1.0.0", None, &fat).unwrap();
        let target = index.entry_for("linux", "x86_64").unwrap();

        // Host already carried as an entry: nothing new is compressed in.
        let repacked = repack_for_entry(&fat, &index, target, Some(("macos", "aarch64"))).unwrap();
        let out = write_file(&dir, "repacked-carried", &repacked);
        let new_index = read_index(&out).unwrap().expect("bundle present");
        assert_eq!(new_index.entries.len(), 1);
        assert!(new_index.entry_for("macos", "aarch64").is_some());

        // Host == target platform: the new image must not also be an entry.
        let repacked = repack_for_entry(&fat, &index, target, Some(("linux", "x86_64"))).unwrap();
        let out = write_file(&dir, "repacked-self", &repacked);
        let new_index = read_index(&out).unwrap().expect("bundle present");
        assert_eq!(new_index.entries.len(), 1);
        assert!(new_index.entry_for("linux", "x86_64").is_none());

        // Unknown host platform: only the sibling is carried.
        let repacked = repack_for_entry(&fat, &index, target, None).unwrap();
        let out = write_file(&dir, "repacked-none", &repacked);
        let new_index = read_index(&out).unwrap().expect("bundle present");
        assert_eq!(new_index.entries.len(), 1);
    }

    #[test]
    fn corrupted_payload_fails_extract() {
        let dir = temp_dir();
        let carrier = write_file(&dir, "herdr", b"CARRIER");
        let (inputs, _, _) = sample_inputs(&dir);
        let out = dir.join("herdr-bundle");
        let index = pack(&carrier, &inputs, "1.0.0", None, &out).unwrap();
        let entry = index.entry_for("linux", "x86_64").unwrap().clone();

        // Flip a byte in the middle of the compressed payload.
        let mut bytes = fs::read(&out).unwrap();
        let mid = (entry.offset + entry.compressed_len / 2) as usize;
        bytes[mid] ^= 0xFF;
        fs::write(&out, &bytes).unwrap();

        assert!(extract_entry(&out, &entry).is_err());
    }

    #[test]
    fn entry_for_finds_present_and_misses_absent() {
        let dir = temp_dir();
        let carrier = write_file(&dir, "herdr", b"CARRIER");
        let (inputs, _, _) = sample_inputs(&dir);
        let out = dir.join("herdr-bundle");
        let index = pack(&carrier, &inputs, "1.0.0", None, &out).unwrap();

        assert!(index.entry_for("linux", "x86_64").is_some());
        assert!(index.entry_for("linux", "aarch64").is_none());
        assert!(index.entry_for("windows", "x86_64").is_none());
    }

    #[test]
    fn unknown_format_version_reads_as_none() {
        let dir = temp_dir();
        let carrier = write_file(&dir, "herdr", b"CARRIER-IMAGE-BYTES");
        let (inputs, _, _) = sample_inputs(&dir);
        let out = dir.join("herdr-bundle");
        pack(&carrier, &inputs, "1.0.0", None, &out).unwrap();

        // Rewrite the footer's format field (offset 16 from end of footer) to a
        // future version. A current reader must fall back cleanly to None.
        let mut bytes = fs::read(&out).unwrap();
        let len = bytes.len();
        let format_at = len - FOOTER_LEN as usize + 16;
        bytes[format_at..format_at + 4].copy_from_slice(&999u32.to_le_bytes());
        fs::write(&out, &bytes).unwrap();

        assert!(read_index(&out).unwrap().is_none());
    }
}
