import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

describe("authoritative tooling env-file exclusion", () => {
  it("keeps formatting and lint traversal away from local env files", () => {
    const prettierIgnore = readFileSync(path.join(repositoryRoot, ".prettierignore"), "utf8");
    const eslintConfig = readFileSync(path.join(repositoryRoot, "eslint.config.mjs"), "utf8");

    expect(prettierIgnore.replaceAll("\r\n", "\n")).toContain(".env\n.env.*\n!.env.example");
    expect(eslintConfig).toContain('"**/.env"');
    expect(eslintConfig).toContain('"**/.env.*"');
    expect(eslintConfig).toContain('"!**/.env.example"');
  });
});
