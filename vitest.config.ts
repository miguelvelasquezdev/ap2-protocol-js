import { defineConfig } from "vitest/config";

// The published SDK's own suite lives in test/. The VI-based sample suite under
// examples/ has its own toolchain and is not part of the library's test run.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["examples/**", "node_modules/**", "dist/**"],
  },
});
