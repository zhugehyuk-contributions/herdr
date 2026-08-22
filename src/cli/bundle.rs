//! `herdr bundle` — inspect and build multi-platform "fat" herdr binaries (issue #28).
//!
//! - `herdr bundle list [path] [--json]` shows which platforms a binary carries.
//! - `herdr bundle pack ...` appends cross-compiled sibling binaries to a carrier;
//!   used by `just bundle` / `scripts/build_bundle.sh`.

use std::path::PathBuf;

use crate::bundle::{self, BundleIndex, PackInput};

// Default `--version` for `bundle pack`: the FULL build version (channel-suffixed for
// mx/preview builds), so a locally packed fat bundle passes the seed parity gate that
// compares the index against what the carried binaries report from `--version`.
const CURRENT_VERSION: &str = crate::build_info::FULL_VERSION;

pub(crate) fn run_bundle_command(args: &[String]) -> std::io::Result<i32> {
    let Some(subcommand) = args.first().map(|arg| arg.as_str()) else {
        print_bundle_help();
        return Ok(2);
    };

    match subcommand {
        "list" => run_list(&args[1..]),
        "pack" => run_pack(&args[1..]),
        "help" | "--help" | "-h" => {
            print_bundle_help();
            Ok(0)
        }
        other => {
            eprintln!("unknown bundle subcommand: {other}");
            print_bundle_help();
            Ok(2)
        }
    }
}

fn print_bundle_help() {
    eprintln!("herdr bundle commands:");
    eprintln!("  herdr bundle list [path] [--json]   Show platforms carried by a herdr binary");
    eprintln!("  herdr bundle pack --carrier <path> --output <path> \\");
    eprintln!("      --binary <os>-<arch>=<path> [--binary ...] [--version <v>] [--commit <c>]");
    eprintln!();
    eprintln!("A fat binary still runs natively; it carries sibling-platform binaries as");
    eprintln!("appended data so `herdr --remote <host>` can seed a different OS/arch offline.");
}

// ---------------------------------------------------------------------------
// bundle list
// ---------------------------------------------------------------------------

fn run_list(args: &[String]) -> std::io::Result<i32> {
    let mut json = false;
    let mut path: Option<PathBuf> = None;
    for arg in args {
        match arg.as_str() {
            "--json" => json = true,
            "help" | "--help" | "-h" => {
                print_bundle_help();
                return Ok(0);
            }
            other if other.starts_with('-') => {
                eprintln!("unknown option: {other}");
                return Ok(2);
            }
            other => {
                if path.is_some() {
                    eprintln!("usage: herdr bundle list [path] [--json]");
                    return Ok(2);
                }
                path = Some(PathBuf::from(other));
            }
        }
    }

    // No path => inspect the running binary (and report its native platform).
    let (index, native) = match &path {
        Some(path) => (bundle::read_index(path)?, None),
        None => (
            bundle::read_self_index()?,
            bundle::local_os_arch().map(|(os, arch)| format!("{os}-{arch}")),
        ),
    };

    if json {
        println!(
            "{}",
            serde_json::to_string(&list_json(index.as_ref(), native.as_deref())).unwrap()
        );
    } else {
        print!("{}", list_text(index.as_ref(), native.as_deref()));
    }
    Ok(0)
}

/// JSON view of a binary's carried platforms (or absence of a bundle).
fn list_json(index: Option<&BundleIndex>, native: Option<&str>) -> serde_json::Value {
    match index {
        Some(index) => {
            let entries: Vec<serde_json::Value> = index
                .entries
                .iter()
                .map(|entry| {
                    serde_json::json!({
                        "platform": entry.asset_key(),
                        "os": entry.os,
                        "arch": entry.arch,
                        "compressed_len": entry.compressed_len,
                        "uncompressed_len": entry.uncompressed_len,
                        "crc32": entry.crc32,
                    })
                })
                .collect();
            serde_json::json!({
                "bundled": true,
                "format": index.format,
                "herdr_version": index.herdr_version,
                "build_commit": index.build_commit,
                "image_len": index.image_len,
                "native": native,
                "entries": entries,
            })
        }
        None => serde_json::json!({
            "bundled": false,
            "native": native,
            "entries": [],
        }),
    }
}

/// Human-readable view of a binary's carried platforms.
fn list_text(index: Option<&BundleIndex>, native: Option<&str>) -> String {
    let mut out = String::new();
    match index {
        Some(index) => {
            let commit = index
                .build_commit
                .as_deref()
                .map(|commit| format!(" ({commit})"))
                .unwrap_or_default();
            out.push_str(&format!(
                "herdr {}{commit} — multi-platform bundle\n",
                index.herdr_version
            ));
            if let Some(native) = native {
                out.push_str(&format!("runs natively on: {native}\n"));
            }
            out.push_str(&format!("carries {} platform(s):\n", index.entries.len()));
            for entry in &index.entries {
                out.push_str(&format!(
                    "  {:<16} {:>9} ({} compressed)\n",
                    entry.asset_key(),
                    format_bytes(entry.uncompressed_len),
                    format_bytes(entry.compressed_len),
                ));
            }
        }
        None => {
            out.push_str(&format!("herdr {CURRENT_VERSION}\n"));
            match native {
                Some(native) => out.push_str(&format!(
                    "This build carries no bundled platforms (built for {native}).\n"
                )),
                None => out.push_str("This binary carries no herdr bundle.\n"),
            }
            out.push_str(
                "Run `just bundle` to produce a multi-platform build that can seed remotes of a different OS/arch offline.\n",
            );
        }
    }
    out
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

// ---------------------------------------------------------------------------
// bundle pack
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
struct PackArgs {
    carrier: PathBuf,
    output: PathBuf,
    version: String,
    commit: Option<String>,
    inputs: Vec<ParsedInput>,
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedInput {
    os: String,
    arch: String,
    binary: PathBuf,
}

/// Parse `bundle pack` arguments. `default_commit` is the running binary's build
/// commit, used when `--commit` is omitted.
fn parse_pack_args(args: &[String], default_commit: Option<&str>) -> Result<PackArgs, String> {
    let mut carrier: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut version: Option<String> = None;
    let mut commit: Option<String> = None;
    let mut inputs = Vec::new();

    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        let value = |index: usize| -> Result<&String, String> {
            args.get(index + 1)
                .ok_or_else(|| format!("missing value for {flag}"))
        };
        match flag {
            "--carrier" => {
                carrier = Some(PathBuf::from(value(index)?));
                index += 2;
            }
            "--output" => {
                output = Some(PathBuf::from(value(index)?));
                index += 2;
            }
            "--version" => {
                version = Some(value(index)?.clone());
                index += 2;
            }
            "--commit" => {
                commit = Some(value(index)?.clone());
                index += 2;
            }
            "--binary" => {
                inputs.push(parse_binary_spec(value(index)?)?);
                index += 2;
            }
            other => return Err(format!("unknown option: {other}")),
        }
    }

    let carrier = carrier.ok_or("missing required --carrier")?;
    let output = output.ok_or("missing required --output")?;
    if inputs.is_empty() {
        return Err("at least one --binary <os>-<arch>=<path> is required".to_string());
    }

    Ok(PackArgs {
        carrier,
        output,
        version: version.unwrap_or_else(|| CURRENT_VERSION.to_string()),
        commit: commit.or_else(|| default_commit.map(str::to_string)),
        inputs,
    })
}

/// Parse a `--binary <os>-<arch>=<path>` value into its parts.
fn parse_binary_spec(spec: &str) -> Result<ParsedInput, String> {
    let (key, path) = spec
        .split_once('=')
        .ok_or_else(|| format!("--binary expects <os>-<arch>=<path>, got `{spec}`"))?;
    let (os, arch) = key
        .split_once('-')
        .ok_or_else(|| format!("--binary platform must be <os>-<arch>, got `{key}`"))?;
    if os.is_empty() || arch.is_empty() || path.is_empty() {
        return Err(format!("--binary has an empty field: `{spec}`"));
    }
    Ok(ParsedInput {
        os: os.to_string(),
        arch: arch.to_string(),
        binary: PathBuf::from(path),
    })
}

fn run_pack(args: &[String]) -> std::io::Result<i32> {
    if matches!(
        args.first().map(String::as_str),
        Some("help" | "--help" | "-h")
    ) {
        print_bundle_help();
        return Ok(0);
    }
    let parsed = match parse_pack_args(args, option_env!("HERDR_BUILD_COMMIT")) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("error: {message}");
            print_bundle_help();
            return Ok(2);
        }
    };

    let inputs: Vec<PackInput> = parsed
        .inputs
        .iter()
        .map(|input| PackInput {
            os: input.os.clone(),
            arch: input.arch.clone(),
            binary: input.binary.clone(),
        })
        .collect();

    let index = bundle::pack(
        &parsed.carrier,
        &inputs,
        &parsed.version,
        parsed.commit.as_deref(),
        &parsed.output,
    )?;

    eprintln!(
        "packed herdr {} ({}) carrying {} platform(s) -> {}",
        index.herdr_version,
        index.build_commit.as_deref().unwrap_or("no-commit"),
        index.entries.len(),
        parsed.output.display()
    );
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parse_pack_args_reads_carrier_output_and_binaries() {
        let parsed = parse_pack_args(
            &args(&[
                "--carrier",
                "target/release/herdr",
                "--output",
                "target/release/herdr-bundle",
                "--binary",
                "linux-x86_64=/tmp/linux/herdr",
                "--binary",
                "macos-aarch64=/tmp/mac/herdr",
            ]),
            Some("abc1234"),
        )
        .unwrap();

        assert_eq!(parsed.carrier, PathBuf::from("target/release/herdr"));
        assert_eq!(parsed.output, PathBuf::from("target/release/herdr-bundle"));
        // Version defaults to the running binary's package version.
        assert_eq!(parsed.version, CURRENT_VERSION);
        // Commit defaults to the running binary's build commit.
        assert_eq!(parsed.commit.as_deref(), Some("abc1234"));
        assert_eq!(
            parsed.inputs,
            vec![
                ParsedInput {
                    os: "linux".into(),
                    arch: "x86_64".into(),
                    binary: PathBuf::from("/tmp/linux/herdr"),
                },
                ParsedInput {
                    os: "macos".into(),
                    arch: "aarch64".into(),
                    binary: PathBuf::from("/tmp/mac/herdr"),
                },
            ]
        );
    }

    #[test]
    fn parse_pack_args_allows_explicit_version_and_commit() {
        let parsed = parse_pack_args(
            &args(&[
                "--carrier",
                "c",
                "--output",
                "o",
                "--version",
                "1.2.3",
                "--commit",
                "feedface",
                "--binary",
                "linux-aarch64=/b",
            ]),
            Some("ignored"),
        )
        .unwrap();
        assert_eq!(parsed.version, "1.2.3");
        assert_eq!(parsed.commit.as_deref(), Some("feedface"));
    }

    #[test]
    fn parse_pack_args_requires_carrier_output_and_binary() {
        assert!(parse_pack_args(
            &args(&["--output", "o", "--binary", "linux-x86_64=/b"]),
            None
        )
        .is_err());
        assert!(parse_pack_args(
            &args(&["--carrier", "c", "--binary", "linux-x86_64=/b"]),
            None
        )
        .is_err());
        assert!(parse_pack_args(&args(&["--carrier", "c", "--output", "o"]), None).is_err());
    }

    #[test]
    fn parse_pack_args_rejects_malformed_binary_spec() {
        // Missing '='.
        assert!(parse_pack_args(
            &args(&[
                "--carrier",
                "c",
                "--output",
                "o",
                "--binary",
                "linux-x86_64"
            ]),
            None
        )
        .is_err());
        // Missing '-' between os and arch.
        assert!(parse_pack_args(
            &args(&["--carrier", "c", "--output", "o", "--binary", "linux=/b"]),
            None
        )
        .is_err());
    }

    fn sample_index() -> BundleIndex {
        BundleIndex {
            format: 1,
            herdr_version: "0.6.4".into(),
            build_commit: Some("abc1234".into()),
            image_len: 1000,
            entries: vec![
                bundle::BundleEntry {
                    os: "linux".into(),
                    arch: "x86_64".into(),
                    offset: 1000,
                    compressed_len: 300,
                    uncompressed_len: 900,
                    crc32: 1,
                },
                bundle::BundleEntry {
                    os: "macos".into(),
                    arch: "x86_64".into(),
                    offset: 1300,
                    compressed_len: 250,
                    uncompressed_len: 800,
                    crc32: 2,
                },
            ],
        }
    }

    #[test]
    fn list_text_shows_carried_platforms_and_native() {
        let text = list_text(Some(&sample_index()), Some("macos-aarch64"));
        assert!(text.contains("0.6.4"));
        assert!(text.contains("abc1234"));
        assert!(text.contains("macos-aarch64")); // native line
        assert!(text.contains("linux-x86_64"));
        assert!(text.contains("macos-x86_64"));
    }

    #[test]
    fn list_text_explains_absence_when_no_bundle() {
        let text = list_text(None, Some("macos-aarch64"));
        assert!(text.contains("no bundled platforms"));
        assert!(text.contains("just bundle"));
        assert!(text.contains("macos-aarch64"));
    }

    #[test]
    fn list_json_reports_entries_and_bundled_flag() {
        let value = list_json(Some(&sample_index()), Some("macos-aarch64"));
        assert_eq!(value["bundled"], serde_json::json!(true));
        assert_eq!(value["herdr_version"], serde_json::json!("0.6.4"));
        assert_eq!(value["native"], serde_json::json!("macos-aarch64"));
        let platforms: Vec<String> = value["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["platform"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(platforms, vec!["linux-x86_64", "macos-x86_64"]);
    }

    #[test]
    fn list_json_reports_no_bundle() {
        let value = list_json(None, Some("macos-aarch64"));
        assert_eq!(value["bundled"], serde_json::json!(false));
        assert_eq!(value["entries"], serde_json::json!([]));
    }
}
