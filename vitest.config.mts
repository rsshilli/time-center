import { defineConfig } from "vitest/config";

/**
 * Unit-test configuration. Tests run in plain Node, so anything that needs Electron is injected.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
