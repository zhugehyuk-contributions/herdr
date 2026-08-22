/**
 * The Hermes contract, as a test instead of a convention.
 *
 * `src/` runs on a phone. `tsconfig.json` already enforces most of that (`types: []`, `lib` capped
 * at ES2020), but two things it does *not* catch became possible the moment `src/node/` appeared:
 *
 *   1. `import "node:net"` in a file that never uses a Node *type* — a bare side-effect or
 *      value-only import can slip past a types-only gate.
 *   2. the React Native entry (`src/index.ts`) reaching, at any depth, into `src/node/` and so
 *      into `ssh2`, whose transitive dependencies include native bindings.
 *
 * So this walks the real import graph from the `.` entry point and fails on either. It is the
 * cheapest possible check and the only one that runs in the default gate, which is where it has to
 * run: a Metro bundle failure is discovered on a device, days later.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "src");

/** Every `from "…"` / `import("…")` specifier in a file, whatever the import form. */
function specifiersOf(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.push(match[1] as string);
    }
  }
  return found;
}

/** Resolves a relative TS specifier the way `moduleResolution: bundler` does (`.js` -> `.ts`). */
function resolveRelative(fromFile: string, specifier: string): string {
  const raw = resolve(dirname(fromFile), specifier);
  return raw.replace(/\.js$/, ".ts");
}

interface Reach {
  files: string[];
  /** `specifier` -> the file that imported it, for bare (non-relative) specifiers. */
  bare: Array<{ specifier: string; importer: string }>;
}

/** Transitive closure of relative imports from `entry`, plus every bare specifier encountered. */
function reachableFrom(entry: string): Reach {
  const seen = new Set<string>();
  const bare: Array<{ specifier: string; importer: string }> = [];
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith(".")) {
        queue.push(resolveRelative(file, specifier));
      } else {
        bare.push({ specifier, importer: file });
      }
    }
  }

  return { files: [...seen], bare };
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesUnder(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("Hermes contract", () => {
  const reach = reachableFrom(join(SRC, "index.ts"));

  it("reaches every module of the React Native entry (the walker is not vacuous)", () => {
    // If the import walker silently resolved nothing, every assertion below would pass trivially.
    expect(reach.files.length).toBeGreaterThan(8);
    expect(reach.files.map((file) => file.replace(`${SRC}/`, ""))).toContain("transport.ts");
  });

  it("imports no Node built-in from the React Native entry", () => {
    const builtins = reach.bare.filter(
      ({ specifier }) => specifier.startsWith("node:") || NODE_BUILTINS.has(specifier),
    );
    expect(
      builtins.map(({ specifier, importer }) => `${importer.replace(`${SRC}/`, "")} -> ${specifier}`),
    ).toEqual([]);
  });

  it("imports nothing at all from outside src/ — the entry is dependency-free", () => {
    expect(
      reach.bare.map(({ specifier, importer }) => `${importer.replace(`${SRC}/`, "")} -> ${specifier}`),
    ).toEqual([]);
  });

  it("never reaches src/node/, which is where ssh2 lives", () => {
    const leaked = reach.files.filter((file) => file.startsWith(join(SRC, "node")));
    expect(leaked).toEqual([]);
  });

  /**
   * The other half of the same contract: `src/node/` is allowed Node imports, but only there. If a
   * future file grows a `node:` import outside `src/node/`, the walk above only catches it when it
   * is reachable from the entry — this catches it regardless.
   */
  it("confines Node imports to src/node/", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(SRC)) {
      if (file.startsWith(join(SRC, "node"))) {
        continue;
      }
      for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
        if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier) || specifier === "ssh2") {
          offenders.push(`${file.replace(`${SRC}/`, "")} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps ssh2 out of the runtime dependency graph", () => {
    const pkg = JSON.parse(readFileSync(resolve(SRC, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      exports?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.devDependencies?.["ssh2"]).toBeDefined();
    // Metro resolves the "." subpath; "./node" is opt-in and never pulled in by it.
    expect(pkg.exports?.["."]).toBe("./src/index.ts");
    expect(pkg.exports?.["./node"]).toBe("./src/node/index.ts");
  });
});

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "crypto", "dns", "events", "fs", "http", "https", "net",
  "os", "path", "process", "stream", "timers", "tls", "url", "util", "worker_threads", "zlib",
]);
