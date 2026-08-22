export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0) {
    throw new Error(`hex string has odd length: ${clean.length}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** `[u32 LE len][payload]` around an already-encoded payload, built independently of src/. */
export function frameHex(payloadHex: string): string {
  const payload = fromHex(payloadHex);
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, payload.length, true);
  return toHex(prefix) + toHex(payload);
}
