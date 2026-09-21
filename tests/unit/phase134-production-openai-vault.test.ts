import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CompositeServerSecrets,
  WindowsProductionVaultOpenAiProvider,
  type WindowsSecretProtector,
} from "../../packages/config/src/index.js";

const originalLocalAppData = process.env.LOCALAPPDATA;
afterEach(() => {
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
});

const protector: WindowsSecretProtector = {
  protect: (value) => Buffer.from(value, "utf8").toString("base64"),
  unprotect: (value) => Buffer.from(value, "base64").toString("utf8"),
};

describe("Phase 1.3.4 production OpenAI vault", () => {
  it("preserves the multi-secret vault and refuses environment fallback", () => {
    const localAppData = mkdtempSync(join(tmpdir(), "bea-local-app-data-"));
    process.env.LOCALAPPDATA = localAppData;
    const productionVaultPath = join(
      localAppData,
      "BEA",
      "CommandCenter",
      "secrets",
      "production-secrets.dpapi.json",
    );
    const provider = new WindowsProductionVaultOpenAiProvider({
      repositoryRoot: process.cwd(),
      productionVaultPath,
      platform: "win32",
      protector,
    });
    const key = "fixture-openai-vault-key";
    provider.store(key);
    expect(provider.read()).toBe(key);
    const envelope = JSON.parse(readFileSync(productionVaultPath, "utf8"));
    expect(envelope.records.openAiApiKey.ciphertext).not.toContain(key);
    expect(envelope.records.openAiApiKey.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const secrets = new CompositeServerSecrets(
      { OPENAI_API_KEY: "fixture-environment-key-must-not-win" },
      {
        repositoryRoot: process.cwd(),
        productionVaultPath,
        platform: "win32",
        protector,
      },
    );
    expect(secrets.readOpenAiApiKey()).toBe(key);
    expect(secrets.describeOpenAiApiKey()).toMatchObject({
      status: "configured",
      source: "windows_protected",
    });
    secrets.deleteProtectedOpenAiApiKey();
    expect(secrets.readOpenAiApiKey()).toBeUndefined();
    expect(secrets.describeOpenAiApiKey().status).toBe("not_configured");
  });

  it("rejects a vault path outside the exact user-local BEA root", () => {
    const localAppData = mkdtempSync(join(tmpdir(), "bea-local-app-data-"));
    process.env.LOCALAPPDATA = localAppData;
    expect(
      () =>
        new WindowsProductionVaultOpenAiProvider({
          repositoryRoot: process.cwd(),
          productionVaultPath: join(localAppData, "unrelated", "secrets.json"),
          platform: "win32",
          protector,
        }),
    ).toThrow(/path is invalid/u);
  });
});
