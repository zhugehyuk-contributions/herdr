import { defineConfig } from "vitest/config";

/**
 * The live suite runs against a real spawned `herdr server`, so it is kept out of the default
 * `vitest run` entirely (`vitest.config.ts` includes only `test/**\/*.test.ts`, and this file's
 * tests are named `*.live.test.ts` under `test/live/`).
 *
 * Single-threaded and unbounded-ish timeouts on purpose: each file spawns a server that binds
 * fixed-name sockets inside its own runtime dir, and waits on a real shell.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/live/**/*.live.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
