// Not from orca. Modelled on the sibling package's opt-in live configs
// (`packages/herdr-client-ts/vitest.live.config.ts` / `vitest.live-ssh.config.ts`), for the same
// reason they exist: a suite that spawns a real herdr server and a real sshd must not run on every
// `pnpm test`, and it must not be *silently* skipped either — see `test/live/paneViewer.live.test.tsx`
// and `HERDR_LIVE_REQUIRE`.
//
// Why `test/` and not `src/`: the default config is a byte-identical copy of orca's
// (`vitest.config.ts`, port map §2.1 grades it `copy`) and collects `src/**/*.test.ts(x)`. Adding
// an `exclude` there to keep the live files out would have been the first divergence in that file.
// Putting the live suite outside `src/` costs nothing and keeps the copy intact.
import { defineConfig } from 'vitest/config'

const vitestOxcConfig = { tsconfig: false } as never

export default defineConfig({
  root: import.meta.dirname,
  oxc: vitestOxcConfig,
  test: {
    // happy-dom, not node: this suite renders the real `@xterm/xterm` build so it can read the
    // screen the server's bytes produced. The codec and the app are indifferent; xterm is not.
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    onConsoleLog: (log) => !log.includes('react-test-renderer is deprecated'),
    include: ['test/live/**/*.live.test.ts', 'test/live/**/*.live.test.tsx'],
    // One file, one process, no parallelism: each spawns a herdr server and an sshd on its own
    // ports, and the receipt prints in order.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000
  }
})
