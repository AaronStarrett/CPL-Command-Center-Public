import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./tests/workspace-aliases";

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    allowOnly: false,
    environment: "node",
    env: {
      APP_MODE: "demo",
      BEA_DISABLE_ENV_FILE: "true",
      OPENAI_API_KEY: "",
    },
    fileParallelism: false,
    include: ["tests/integration/**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: false,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    reporters: ["default"],
    testTimeout: 30_000,
  },
});
