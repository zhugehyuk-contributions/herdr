#!/usr/bin/env bash
# Build a multi-platform "fat" herdr (issue #28).
#
# Cross-compiles every supported os/arch with cargo-zigbuild (Linux -> static musl, so
# the seeded remote needs no matching libc) and appends the sibling binaries to the
# native build via `herdr bundle pack`. The result still runs natively but carries the
# other platforms as appended data, so `herdr --remote <host>` can seed a different-OS
# host offline at exact version parity with the local build.
#
# This is opt-in: plain `cargo build` / released / brew / nix artifacts are unchanged.
#
# Prerequisites:
#   - Rust + rustup (https://rustup.rs)
#   - cargo-zigbuild   (cargo install cargo-zigbuild)
#   - Zig 0.15         (set ZIG=/path/to/zig if it is not the default on PATH)
#
# Override the output path with HERDR_BUNDLE_OUTPUT; defaults to target/herdr-bundle.
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

# Supported targets. Linux uses static musl so the seeded remote needs no matching libc.
# Windows is intentionally omitted for now (issue #28 non-goal); the bundle format is
# forward-compatible, so adding a windows target later needs no format change.
TARGETS=(
  aarch64-apple-darwin
  x86_64-apple-darwin
  x86_64-unknown-linux-musl
  aarch64-unknown-linux-musl
)

OUTPUT=${HERDR_BUNDLE_OUTPUT:-"$ROOT_DIR/target/herdr-bundle"}

# Map a Rust target triple to the bundle os-arch key herdr uses (matches `uname`).
target_to_os_arch() {
  case "$1" in
    aarch64-apple-darwin) echo "macos-aarch64" ;;
    x86_64-apple-darwin) echo "macos-x86_64" ;;
    x86_64-unknown-linux-musl) echo "linux-x86_64" ;;
    aarch64-unknown-linux-musl) echo "linux-aarch64" ;;
    *) echo "" ;;
  esac
}

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: $1 not found. $2" >&2
    exit 1
  }
}

require cargo "Install Rust: https://rustup.rs"
require rustc "Install Rust: https://rustup.rs"
require rustup "Install Rust: https://rustup.rs"
if ! cargo-zigbuild --version >/dev/null 2>&1; then
  echo "error: cargo-zigbuild not found. Install with: cargo install cargo-zigbuild" >&2
  exit 1
fi

# build.rs builds the vendored libghostty-vt for each target via Zig 0.15.
ZIG_BIN=${ZIG:-zig}
if ! "$ZIG_BIN" version >/dev/null 2>&1; then
  echo "error: zig not found. Install Zig 0.15 and set ZIG=/path/to/zig" >&2
  exit 1
fi
export ZIG="$ZIG_BIN"

HOST_TARGET=$(rustc -vV | sed -n 's/^host: //p')

echo "host target: $HOST_TARGET"
echo "zig:         $("$ZIG_BIN" version) ($ZIG_BIN)"
echo "output:      $OUTPUT"
echo

# build.rs links the vendored libghostty-vt static lib DIRECTLY from the shared in-repo path
# vendor/libghostty-vt/zig-out/lib (it is not copied into a per-target OUT_DIR). On a warm tree the
# next target therefore links the PREVIOUS target's wrong-arch `.a` (`ld.lld: ... is incompatible`)
# unless zig's shared output + cache are cleared before each target build. Clear them before every
# target so each one regenerates and links its own arch's lib.
clean_libghostty_shared_artifacts() {
  rm -rf "$ROOT_DIR/vendor/libghostty-vt/zig-out" "$ROOT_DIR/vendor/libghostty-vt/.zig-cache"
}

echo "==> building native carrier ($HOST_TARGET)"
clean_libghostty_shared_artifacts
cargo build --release --locked --target "$HOST_TARGET"
CARRIER="$ROOT_DIR/target/$HOST_TARGET/release/herdr"
test -x "$CARRIER" || {
  echo "error: native carrier was not built at $CARRIER" >&2
  exit 1
}

# Cross-build every non-host target and collect its --binary argument.
BINARY_ARGS=()
for target in "${TARGETS[@]}"; do
  # The host platform is seeded straight from the running carrier, so it is not
  # carried in the payload (no point doubling the native binary's bytes).
  [[ "$target" == "$HOST_TARGET" ]] && continue
  os_arch=$(target_to_os_arch "$target")
  [[ -n "$os_arch" ]] || {
    echo "error: no os-arch mapping for target $target" >&2
    exit 1
  }
  echo "==> cross-building $target ($os_arch)"
  rustup target add "$target" >/dev/null 2>&1 || true
  clean_libghostty_shared_artifacts
  cargo zigbuild --release --locked --target "$target"
  bin="$ROOT_DIR/target/$target/release/herdr"
  test -f "$bin" || {
    echo "error: $target binary was not built at $bin" >&2
    exit 1
  }
  BINARY_ARGS+=(--binary "$os_arch=$bin")
done

if [[ ${#BINARY_ARGS[@]} -eq 0 ]]; then
  echo "error: no cross-platform binaries to bundle — every target in TARGETS equals the host" \
       "($HOST_TARGET), so there is nothing to pack." >&2
  echo "       add a non-host target to TARGETS, or skip bundling on this host." >&2
  exit 1
fi

echo
echo "==> packing $OUTPUT"
# BINARY_ARGS is guaranteed non-empty here, so the expansion is safe even under `set -u` on the
# stock macOS bash 3.2 (which errors on an empty-array expansion).
"$CARRIER" bundle pack --carrier "$CARRIER" --output "$OUTPUT" "${BINARY_ARGS[@]}"

echo
echo "==> verifying the packed carrier still runs natively"
"$OUTPUT" --version
echo
"$OUTPUT" bundle list
echo
echo "done. Run \`herdr --remote <host>\` from $OUTPUT to seed a remote of any carried platform offline."
echo "note (macOS): appending data invalidates an existing code signature; the file still"
echo "      runs locally (the kernel honors the original code limit), but do not re-sign the"
echo "      packed binary or the appended payload will be stripped/rejected."