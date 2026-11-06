import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Each end-to-end test starts a real agent process and a model turn.
    testTimeout: 30000,
  },
});
