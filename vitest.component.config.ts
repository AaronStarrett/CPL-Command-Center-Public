import { resolve } from "node:path";

import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./tests/workspace-aliases";

export default defineConfig({
  resolve: {
    alias: [
      ...workspaceAliases,
      { find: "@", replacement: resolve(import.meta.dirname, "apps/web") },
      {
        find: "next/navigation",
        replacement: resolve(import.meta.dirname, "tests/component/stubs/next-navigation.ts"),
      },
      {
        find: "server-only",
        replacement: resolve(import.meta.dirname, "tests/component/stubs/server-only.ts"),
      },
    ],
  },
  test: {
    allowOnly: false,
    environment: "jsdom",
    env: {
      APP_MODE: "demo",
      BEA_DISABLE_ENV_FILE: "true",
      OPENAI_API_KEY: "",
    },
    fileParallelism: false,
    include: ["tests/component/**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: false,
    maxWorkers: 1,
    minWorkers: 1,
    reporters: ["default"],
    setupFiles: ["./tests/component/setup.ts"],
    testTimeout: 15_000,
  },
});
