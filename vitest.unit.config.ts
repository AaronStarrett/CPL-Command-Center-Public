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
    include: [
      "tests/unit/**/*.{test,spec}.{ts,tsx,mts,mjs}",
      "packages/*/src/**/*.{test,spec}.{ts,tsx}",
      "apps/worker/src/**/*.{test,spec}.ts",
    ],
    passWithNoTests: false,
    maxWorkers: 1,
    minWorkers: 1,
    reporters: ["default"],
    testTimeout: 15_000,
  },
});
