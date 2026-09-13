import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Stage 4 is where these earn their keep: the availability engine and the
    // ranking formula are pure functions, so they test without a database.
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
  },
});
