import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    // tests/** is T2 + Codex; src/**/__tests__ is teammate 1's frontend suite (requested in docs/handoffs/frontend.txt).
    include: ["tests/**/*.test.ts", "src/**/__tests__/**/*.test.{ts,tsx}"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
