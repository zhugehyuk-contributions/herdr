/**
 * Client for herdr's newline-delimited JSON control API (the `herdr.sock` socket), as opposed to
 * the binary client stream (`herdr-client.sock`) the rest of this package encodes.
 *
 * The one non-obvious thing about this API — and the reason it deserves a type rather than a
 * one-liner at each call site — is that **one request is one connection**. `handle_connection`
 * (`src/api/server.rs:139-152`) reads a single line, dispatches it, writes one response line and
 * returns; there is no loop. A client that keeps the socket open and writes a second request gets
 * silence, not an answer. {@link JsonApiClient.call} therefore connects, exchanges, and closes on
 * every call, and that lifecycle is the class's whole reason to exist.
 *
 * Like the rest of `src/`, this file touches no Node built-in: the caller supplies the transport
 * ({@link JsonApiConnect}), so the same client runs over `node:net` in tests and over whatever
 * socket API the mobile host exposes.
 */
import { utf8Decode } from "./utf8.js";

/** A single-use connection to the API socket. Closed by {@link JsonApiClient.call} when done. */
export interface JsonApiConnection {
  /** Writes the whole request line, newline included. */
  write(line: string): void | Promise<void>;
  /** Resolves the first complete newline-terminated line the server sends, without the newline. */
  readLine(): Promise<string>;
  /** Releases the connection. Called exactly once per {@link JsonApiClient.call}, even on failure. */
  close(): void;
}

/** Opens a fresh connection to the API socket. Invoked once per request, by contract. */
export type JsonApiConnect = () => Promise<JsonApiConnection>;

/** Success envelope. `result.type` is the server's discriminator (e.g. `"agent_list"`). */
export interface JsonApiOkResponse {
  id: string;
  result: { type: string } & Record<string, unknown>;
}

/** Failure envelope (`ErrorResponse` / `ErrorBody`, `src/api/server.rs:165-173`). */
export interface JsonApiErrorResponse {
  id: string;
  error: { code: string; message: string };
}

export type JsonApiResponse = JsonApiOkResponse | JsonApiErrorResponse;

export function isJsonApiError(response: JsonApiResponse): response is JsonApiErrorResponse {
  return "error" in response;
}

/** Thrown by {@link JsonApiClient.request} when the server answered with an error envelope. */
export class JsonApiError extends Error {
  readonly code: string;
  readonly method: string;

  constructor(method: string, code: string, message: string) {
    super(`${method} failed [${code}]: ${message}`);
    this.name = "JsonApiError";
    this.code = code;
    this.method = method;
  }
}

/** Thrown when a reply is not a well-formed response envelope. */
export class JsonApiProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonApiProtocolError";
  }
}

/**
 * Splits a byte stream into newline-terminated lines.
 *
 * Kept here rather than in the transport because it is the only stateful part of reading NDJSON,
 * and it is pure: {@link JsonApiConnection} implementations feed it socket chunks and stay dumb.
 * Bytes are decoded per completed line, so a multi-byte UTF-8 character split across two chunks
 * still decodes correctly (the split cannot land inside a line, only inside the buffer).
 */
export class LineAccumulator {
  private buffer: Uint8Array = new Uint8Array(0);

  get bufferedBytes(): number {
    return this.buffer.length;
  }

  push(chunk: Uint8Array): string[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);

    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < merged.length; i += 1) {
      if (merged[i] !== 0x0a) {
        continue;
      }
      lines.push(utf8Decode(merged.subarray(start, i)));
      start = i + 1;
    }
    this.buffer = merged.subarray(start);
    return lines;
  }
}

/** Serializes one request as the exact line the server expects, newline included. */
export function encodeJsonApiRequest(
  id: string,
  method: string,
  params: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({ id, method, params })}\n`;
}

/** Parses one response line, rejecting anything that is neither a result nor an error envelope. */
export function parseJsonApiResponse(line: string): JsonApiResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    throw new JsonApiProtocolError(
      `API reply is not JSON (${(error as Error).message}): ${JSON.stringify(line.slice(0, 200))}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new JsonApiProtocolError(`API reply is not an object: ${line.slice(0, 200)}`);
  }

  const envelope = parsed as Record<string, unknown>;
  const id = typeof envelope["id"] === "string" ? envelope["id"] : "";

  const error = envelope["error"];
  if (typeof error === "object" && error !== null) {
    const body = error as Record<string, unknown>;
    return {
      id,
      error: {
        code: typeof body["code"] === "string" ? body["code"] : "unknown",
        message: typeof body["message"] === "string" ? body["message"] : line.slice(0, 200),
      },
    };
  }

  const result = envelope["result"];
  if (typeof result !== "object" || result === null) {
    throw new JsonApiProtocolError(`API reply carries neither result nor error: ${line.slice(0, 200)}`);
  }
  const body = result as Record<string, unknown>;
  if (typeof body["type"] !== "string") {
    throw new JsonApiProtocolError(`API result has no \`type\` discriminator: ${line.slice(0, 200)}`);
  }

  return { id, result: body as { type: string } & Record<string, unknown> };
}

/**
 * Checks that a reply belongs to the request that is waiting for it.
 *
 * One request is one connection, so there is no correlation to *do* — which is exactly why a
 * mismatched echo is worth stopping on: it cannot be a routing mistake, it can only mean the wire
 * is not what it claims to be (a bridge multiplexing two callers, a skewed protocol, a replayed
 * line). {@link parseJsonApiResponse} normalises a missing or non-string `id` to `""`, so without
 * this check such a reply was accepted as a successful result for whatever was asked.
 *
 * One reply is exempt: a request the server could not parse is answered with `id: ""` by
 * construction (`src/api/server.rs:159-172`, and the encode fallback at `:819`). It is the answer
 * to this request — there is no other request on this connection — so its diagnosis must survive
 * as a {@link JsonApiError} instead of being replaced by a complaint about correlation.
 */
function assertEchoedId(id: string, method: string, response: JsonApiResponse): void {
  if (response.id === id) {
    return;
  }
  if (isJsonApiError(response) && response.id === "") {
    return;
  }
  throw new JsonApiProtocolError(
    `${method} got a reply carrying id ${JSON.stringify(response.id)}, not ` +
      `${JSON.stringify(id)}; one request is one connection, so a mismatched echo means the ` +
      `reply belongs to something else`,
  );
}

/**
 * One connection per request, enforced. See the file header for why that is not optional.
 *
 * Only `agent.list` and `pane.list` get named methods — the two this package proves end-to-end
 * against a live server. Everything else the API exposes (`pane.get`, `pane.send_input`,
 * `workspace.list`, `remote.list`, …) goes through {@link JsonApiClient.request}, which is
 * untyped on purpose rather than a wall of hand-transcribed shapes nothing verifies.
 */
export class JsonApiClient {
  private readonly connect: JsonApiConnect;
  private nextId = 1;

  constructor(connect: JsonApiConnect) {
    this.connect = connect;
  }

  /**
   * Round-trips one request. Returns the envelope as-is; *server* errors are values, not throws.
   *
   * A reply that does not echo the request's `id` is not a server error, though — it is a broken
   * wire, and it throws {@link JsonApiProtocolError}. See {@link assertEchoedId}.
   */
  async call(method: string, params: Record<string, unknown> = {}): Promise<JsonApiResponse> {
    const id = `ts-${this.nextId}`;
    this.nextId += 1;

    const connection = await this.connect();
    try {
      await connection.write(encodeJsonApiRequest(id, method, params));
      const response = parseJsonApiResponse(await connection.readLine());
      assertEchoedId(id, method, response);
      return response;
    } finally {
      connection.close();
    }
  }

  /** {@link call}, but an error envelope becomes a {@link JsonApiError} and only `result` returns. */
  async request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<{ type: string } & Record<string, unknown>> {
    const response = await this.call(method, params);
    if (isJsonApiError(response)) {
      throw new JsonApiError(method, response.error.code, response.error.message);
    }
    return response.result;
  }

  /** `agent.list` — `{ type: "agent_list", agents: [...] }`. */
  async agentList(): Promise<{ type: string } & Record<string, unknown>> {
    return this.request("agent.list");
  }

  /** `pane.list` — `{ type: "pane_list", panes: [...] }`. */
  async paneList(): Promise<{ type: string } & Record<string, unknown>> {
    return this.request("pane.list");
  }
}
