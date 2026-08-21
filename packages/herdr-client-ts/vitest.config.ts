import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    /**
     * The live suite spawns a real `herdr server`; it has its own runner
     * (`vitest.live.config.ts`, `pnpm test:live`). Excluding it here keeps the codec gate fast and
     * free of any dependency on a built binary — the `include` glob above would otherwise match it.
     */
    exclude: ["node_modules/**", "test/live/**"],
  },
});
