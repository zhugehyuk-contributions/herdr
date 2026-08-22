import { defineConfig } from "vitest/config";

/**
 * A third runner, separate from both `vitest.config.ts` (codec) and `vitest.live.config.ts`
 * (unix-socket live suite), because this suite has a *third* precondition on top of theirs: a
 * usable `sshd` binary. Folding it into `test:live` would make the existing three tests' result
 * depend on an ssh daemon that has nothing to do with them.
 *
 * Single fork, long timeouts: each file spawns a herdr server, an sshd and an ssh connection.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/live-ssh/**/*.live.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
