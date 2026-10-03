import { defineConfig } from "vitest/config";

// Sims bind fixed ports (4701-4705, 4800), so test files never run in parallel.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
