import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests share one Postgres database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
