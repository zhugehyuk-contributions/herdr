import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLIENT_LAUNCH_MODE_ORDER,
  CLIENT_SURFACE_MODE_ORDER,
  ClientMessageTag,
  DEFAULT_MAX_FRAME_SIZE,
  FrameReader,
  RENDER_ENCODING_ORDER,
  RUST_MAX_FRAME_SIZE,
  RUST_MAX_GRAPHICS_FRAME_SIZE,
  ServerMessageTag,
  decodeServerMessage,
  encodeHelloFrame,
  encodeObserveTerminalFrame,
  serverFrameSizeCap,
  utf8Encode,
  type HelloParams,
} from "../src/index.js";
import { fromHex, toHex } from "./helpers.js";

/**
 * Cross-check against the conformance fixtures generated from the Rust side
 * (`docs/next/protocol/fixtures.json`, owned by another work stream). The file is optional: when
 * it is absent these checks are skipped and the rest of the suite still pins the wire format on
 * its own bincode-derived golden vectors.
 */
const FIXTURES_PATH = fileURLToPath(
  new URL("../../../docs/next/protocol/fixtures.json", import.meta.url),
);
const HAS_FIXTURES = existsSync(FIXTURES_PATH);

interface FixtureVector {
  name: string;
  direction?: string;
  message?: string;
  fields?: Record<string, unknown>;
  framed_hex?: string;
  /** Used when the body is too large to inline: envelope + everything up to `bytes`. */
  framed_header_hex?: string;
  bytes_prefix_hex?: string;
  bytes_prefix_len?: number;
  bytes_sha256?: string;
  bytes_len?: number;
  nondeterministic?: boolean;
  synthesized?: boolean | string;
}

/** Both arms of the server's per-frame cap choice, plus the rule that selects between them. */
interface FixtureFrameSizeCap {
  text?: number;
  graphics?: number;
  chosen_per_frame?: string;
  reader_rule?: string;
}

interface FixtureFile {
  protocol_version?: number;
  abi?: unknown;
  enums?: Record<string, unknown>;
  framing?: { max_frame_size?: FixtureFrameSizeCap };
  vectors?: FixtureVector[];
}

const fixtures: FixtureFile | null = HAS_FIXTURES
  ? (JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as FixtureFile)
  : null;

/** Fixture enums may be a name array (ordinal = index) or a name -> ordinal map. */
function ordinalOf(group: unknown, name: string): number | undefined {
  if (Array.isArray(group)) {
    const index = group.indexOf(name);
    return index >= 0 ? index : undefined;
  }
  if (group !== null && typeof group === "object") {
    const value = (group as Record<string, unknown>)[name];
    return typeof value === "number" ? value : undefined;
  }
  return undefined;
}

function fieldOf(fields: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (name in fields) return fields[name];
  }
  return undefined;
}

function asOrdinal(value: unknown, order: readonly string[]): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const index = order.indexOf(value);
    return index >= 0 ? index : undefined;
  }
  return undefined;
}

describe.skipIf(!HAS_FIXTURES)("docs/next/protocol/fixtures.json cross-check", () => {
  it("agrees with our enum ordinals", () => {
    const enums = fixtures!.enums ?? {};

    RENDER_ENCODING_ORDER.forEach((name, index) => {
      expect(ordinalOf(enums.RenderEncoding, name), `RenderEncoding::${name}`).toBe(index);
    });
    CLIENT_LAUNCH_MODE_ORDER.forEach((name, index) => {
      expect(ordinalOf(enums.ClientLaunchMode, name), `ClientLaunchMode::${name}`).toBe(index);
    });
    expect(ordinalOf(enums.ClientMessage, "ObserveTerminal")).toBe(ClientMessageTag.ObserveTerminal);
    expect(ordinalOf(enums.ServerMessage, "Welcome")).toBe(ServerMessageTag.Welcome);
    expect(ordinalOf(enums.ServerMessage, "Terminal")).toBe(ServerMessageTag.Terminal);
  });

  it("decodes every framed server vector into its declared fields", () => {
    const vectors = (fixtures!.vectors ?? []).filter(
      (vector) =>
        vector.nondeterministic !== true &&
        typeof vector.framed_hex === "string" &&
        (vector.message === "Welcome" || vector.message === "Terminal"),
    );

    for (const vector of vectors) {
      const frames = new FrameReader().push(fromHex(vector.framed_hex!));
      expect(frames, `${vector.name}: framed_hex should hold exactly one frame`).toHaveLength(1);
      const message = decodeServerMessage(frames[0]!);
      const fields = vector.fields ?? {};

      if (message.type === "welcome") {
        expect(vector.message, vector.name).toBe("Welcome");
        const version = fieldOf(fields, "version");
        if (typeof version === "number") expect(message.version, vector.name).toBe(version);
        const encoding = asOrdinal(fieldOf(fields, "encoding"), RENDER_ENCODING_ORDER);
        if (encoding !== undefined) expect(message.encoding, vector.name).toBe(encoding);
        if ("error" in fields) {
          expect(message.error, vector.name).toBe(fields.error ?? null);
        }
      } else {
        expect(vector.message, vector.name).toBe("Terminal");
        const seq = fieldOf(fields, "seq");
        if (typeof seq === "number" || typeof seq === "string") {
          expect(message.seq, vector.name).toBe(BigInt(seq));
        }
        const width = fieldOf(fields, "width");
        if (typeof width === "number") expect(message.width, vector.name).toBe(width);
        const height = fieldOf(fields, "height");
        if (typeof height === "number") expect(message.height, vector.name).toBe(height);
        const full = fieldOf(fields, "full");
        if (typeof full === "boolean") expect(message.full, vector.name).toBe(full);
        const bytes = fieldOf(fields, "bytes", "bytes_hex");
        if (typeof bytes === "string") expect(toHex(message.bytes), vector.name).toBe(bytes);
        if (Array.isArray(bytes)) expect(Array.from(message.bytes), vector.name).toEqual(bytes);
        if (typeof vector.bytes_len === "number") {
          expect(message.bytes.length, vector.name).toBe(vector.bytes_len);
        }
        if (typeof vector.bytes_prefix_hex === "string") {
          expect(
            toHex(message.bytes).startsWith(vector.bytes_prefix_hex),
            `${vector.name}: bytes prefix`,
          ).toBe(true);
        }
      }
    }
  });

  it("re-encodes every framed Hello vector to the same bytes", () => {
    const vectors = (fixtures!.vectors ?? []).filter(
      (vector) =>
        vector.nondeterministic !== true &&
        typeof vector.framed_hex === "string" &&
        vector.message === "Hello" &&
        vector.fields !== undefined,
    );
    expect(vectors.length, "no Hello vector to re-encode").toBeGreaterThan(0);

    for (const vector of vectors) {
      const fields = vector.fields!;
      const cols = fieldOf(fields, "cols");
      const rows = fieldOf(fields, "rows");
      const encoding = asOrdinal(
        fieldOf(fields, "requested_encoding", "requestedEncoding", "encoding"),
        RENDER_ENCODING_ORDER,
      );
      const launch = asOrdinal(
        fieldOf(fields, "launch_mode", "launchMode", "launch"),
        CLIENT_LAUNCH_MODE_ORDER,
      );
      const surface = asOrdinal(
        fieldOf(fields, "surface_mode", "surfaceMode", "surface"),
        CLIENT_SURFACE_MODE_ORDER,
      );

      // A vector we cannot map is a gap in this cross-check, not a pass.
      expect(typeof cols, `${vector.name}.cols`).toBe("number");
      expect(typeof rows, `${vector.name}.rows`).toBe("number");
      expect(encoding, `${vector.name}.requested_encoding`).toBeTypeOf("number");
      expect(launch, `${vector.name}.launch_mode`).toBeTypeOf("number");
      // `ClientKeybindings::Local` carries a payload this codec cannot encode.
      const keybindings = fieldOf(fields, "keybindings");
      if (keybindings !== undefined) expect(keybindings, vector.name).toBe("Server");

      const params: HelloParams = {
        cols: cols as number,
        rows: rows as number,
        requestedEncoding: encoding as 0 | 1,
        launchMode: launch as 0 | 1,
      };
      if (surface !== undefined) params.surfaceMode = surface as 0 | 1;
      const version = fieldOf(fields, "version");
      if (typeof version === "number") params.version = version;
      const cellWidth = fieldOf(fields, "cell_width_px", "cellWidthPx");
      if (typeof cellWidth === "number") params.cellWidthPx = cellWidth;
      const cellHeight = fieldOf(fields, "cell_height_px", "cellHeightPx");
      if (typeof cellHeight === "number") params.cellHeightPx = cellHeight;

      expect(toHex(encodeHelloFrame(params)), vector.name).toBe(vector.framed_hex);
    }
  });

  it("agrees with the header-only Terminal vectors on envelope and field layout", () => {
    const vectors = (fixtures!.vectors ?? []).filter(
      (vector) => vector.message === "Terminal" && typeof vector.framed_header_hex === "string",
    );

    for (const vector of vectors) {
      const fields = vector.fields ?? {};
      const bytesLen = fieldOf(fields, "bytes_len") ?? vector.bytes_len;
      expect(bytesLen, `${vector.name}: bytes_len is required to rebuild the frame`).toBeTypeOf(
        "number",
      );

      // The corpus omits the 55 KB body, so rebuild it: header + known prefix + filler. If the
      // header's length prefix or its `bytes` varint disagreed with bytes_len, the frame would not
      // close cleanly and FrameReader would either withhold it or leave a remainder.
      const header = fromHex(vector.framed_header_hex!);
      const prefix =
        typeof vector.bytes_prefix_hex === "string" ? fromHex(vector.bytes_prefix_hex) : new Uint8Array(0);
      if (typeof vector.bytes_prefix_len === "number") {
        expect(prefix.length, `${vector.name}: bytes_prefix_len`).toBe(vector.bytes_prefix_len);
      }
      const body = new Uint8Array(bytesLen as number);
      body.set(prefix.subarray(0, body.length), 0);

      const rebuilt = new Uint8Array(header.length + body.length);
      rebuilt.set(header, 0);
      rebuilt.set(body, header.length);

      const reader = new FrameReader();
      const frames = reader.push(rebuilt);
      expect(frames, `${vector.name}: header + body should form exactly one frame`).toHaveLength(1);
      expect(reader.hasPartialFrame, `${vector.name}: no bytes left over`).toBe(false);

      const message = decodeServerMessage(frames[0]!);
      expect(message.type).toBe("terminal");
      if (message.type !== "terminal") return;
      expect(message.bytes.length, `${vector.name}: bytes_len`).toBe(bytesLen);
      const seq = fieldOf(fields, "seq");
      if (typeof seq === "number" || typeof seq === "string") {
        expect(message.seq, vector.name).toBe(BigInt(seq));
      }
      const width = fieldOf(fields, "width");
      if (typeof width === "number") expect(message.width, vector.name).toBe(width);
      const height = fieldOf(fields, "height");
      if (typeof height === "number") expect(message.height, vector.name).toBe(height);
      const full = fieldOf(fields, "full");
      if (typeof full === "boolean") expect(message.full, vector.name).toBe(full);
      if (typeof vector.bytes_prefix_hex === "string") {
        expect(toHex(message.bytes).startsWith(vector.bytes_prefix_hex), vector.name).toBe(true);
      }
    }
  });

  /**
   * The cap the fixtures record is a *rule* with two arms, not a number. The previous version of
   * this check read a single `max_frame_size` number and only asserted `>=`, which passed happily
   * while the codec's default sat between the two Rust caps and rejected legal graphics frames.
   */
  it("matches both arms of the server's frame-size rule", () => {
    const cap = fixtures!.framing?.max_frame_size;
    expect(cap, "framing.max_frame_size must record both caps, not one value").toBeTypeOf("object");
    expect(cap!.text, "framing.max_frame_size.text").toBe(RUST_MAX_FRAME_SIZE);
    expect(cap!.graphics, "framing.max_frame_size.graphics").toBe(RUST_MAX_GRAPHICS_FRAME_SIZE);

    // The TS helper must reproduce the server's per-frame choice, arm for arm.
    expect(serverFrameSizeCap(false)).toBe(cap!.text);
    expect(serverFrameSizeCap(true)).toBe(cap!.graphics);

    // And the default must cover the larger arm, or a legal graphics frame flaps the connection.
    expect(DEFAULT_MAX_FRAME_SIZE).toBe(cap!.graphics);

    // The rule has to be written down, not inferred from two integers.
    expect(typeof cap!.chosen_per_frame, "framing.max_frame_size.chosen_per_frame").toBe("string");
    expect(typeof cap!.reader_rule, "framing.max_frame_size.reader_rule").toBe("string");
  });

  it("re-encodes the ObserveTerminal vector to the same bytes", () => {
    const vectors = (fixtures!.vectors ?? []).filter(
      (vector) => vector.message === "ObserveTerminal" && typeof vector.framed_hex === "string",
    );
    expect(vectors.length, "no ObserveTerminal vector to re-encode").toBeGreaterThan(0);

    for (const vector of vectors) {
      const target = fieldOf(vector.fields ?? {}, "target");
      expect(typeof target, `${vector.name}.target`).toBe("string");
      expect(toHex(encodeObserveTerminalFrame(target as string)), vector.name).toBe(
        vector.framed_hex,
      );

      // The corpus records the byte length separately; that is the number the varint carries.
      const utf8Len = fieldOf(vector.fields ?? {}, "target_utf8_len");
      if (typeof utf8Len === "number") {
        expect(utf8Encode(target as string).length, `${vector.name}.target_utf8_len`).toBe(utf8Len);
      }
    }
  });

  it("reports the same PROTOCOL_VERSION", () => {
    if (typeof fixtures!.protocol_version === "number") {
      expect(fixtures!.protocol_version).toBe(20);
    }
  });
});
