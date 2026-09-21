import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";
import globals from "globals";

const javascriptFiles = ["**/*.{js,mjs,cjs}"];
const typescriptFiles = ["**/*.{ts,tsx,mts,cts}"];
const webFiles = ["apps/web/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"];

function scoped(configurations, files, settings) {
  return configurations.map((configuration) => ({
    ...configuration,
    files,
    ...(settings ? { settings: { ...configuration.settings, ...settings } } : {}),
  }));
}

export default defineConfig([
  globalIgnores([
    "**/.env",
    "**/.env.*",
    "!**/.env.example",
    "**/.next/**",
    "**/.next-preview/**",
    "**/.open-next/**",
    "**/.wrangler/**",
    "**/.dev.vars*",
    "**/dist/**",
    "**/node_modules/**",
    "**/playwright-report/**",
    "**/test-results/**",
    "**/coverage/**",
    "**/.data/**",
  ]),
  {
    ...eslint.configs.recommended,
    files: javascriptFiles,
    languageOptions: {
      ...eslint.configs.recommended.languageOptions,
      globals: globals.node,
    },
  },
  ...scoped(nextTypeScript, typescriptFiles),
  ...scoped(nextVitals, webFiles, {
    next: { rootDir: "apps/web" },
  }),
]);
