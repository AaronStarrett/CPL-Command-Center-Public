import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  CompositeServerSecrets,
  type WindowsSecretProtector,
} from "../../packages/config/src/secrets.js";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "bea-phase13-secrets-"));
  roots.push(value);
  return value;
}

const protector: WindowsSecretProtector = {
  protect: (plaintext) => Buffer.from(`protected:${plaintext}`, "utf8").toString("base64"),
  unprotect: (ciphertext) => {
    const decoded = Buffer.from(ciphertext, "base64").toString("utf8");
    if (!decoded.startsWith("protected:")) throw new Error("invalid protected fixture");
    return decoded.slice("protected:".length);
  },
};

function store(repositoryRoot: string, environmentKey?: string) {
  return new CompositeServerSecrets(
    { OPENAI_API_KEY: environmentKey },
    { repositoryRoot, platform: "win32", protector },
  );
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { force: true, recursive: true });
});

describe("provider-neutral server secret storage", () => {
  it("persists only protected ciphertext and prefers it over environment fallback", () => {
    const repositoryRoot = root();
    const environmentKey = "phase13-environment-secret-value-0001";
    const protectedKey = "phase13-protected-secret-value-0002";
    const secrets = store(repositoryRoot, environmentKey);

    const descriptor = secrets.storeOpenAiApiKey(protectedKey);
    const secretPath = join(repositoryRoot, ".data", "secrets", "openai-api-key.dpapi");
    const disk = readFileSync(secretPath, "utf8");

    expect(descriptor).toMatchObject({ status: "configured", source: "windows_protected" });
    expect(descriptor.fingerprint).toMatch(/^sha256:[a-f0-9]{12}$/u);
    expect(descriptor.fingerprint).not.toContain(protectedKey);
    expect(disk).not.toContain(protectedKey);
    expect(disk).not.toContain(environmentKey);
    expect(secrets.readOpenAiApiKey()).toBe(protectedKey);
    expect(secrets.redact(`environment=${environmentKey}; protected=${protectedKey}`)).toBe(
      "environment=[REDACTED_OPENAI_API_KEY]; protected=[REDACTED_OPENAI_API_KEY]",
    );
  });

  it("replaces and deletes the protected value without retaining plaintext", () => {
    const repositoryRoot = root();
    const first = "phase13-first-secret-value-00000001";
    const second = "phase13-second-secret-value-0000002";
    const secrets = store(repositoryRoot);
    const secretPath = join(repositoryRoot, ".data", "secrets", "openai-api-key.dpapi");

    secrets.storeOpenAiApiKey(first);
    secrets.storeOpenAiApiKey(second);
    expect(secrets.readOpenAiApiKey()).toBe(second);
    expect(readFileSync(secretPath, "utf8")).not.toContain(first);
    expect(readFileSync(secretPath, "utf8")).not.toContain(second);

    expect(secrets.deleteProtectedOpenAiApiKey()).toMatchObject({
      status: "not_configured",
      source: "none",
    });
    expect(existsSync(secretPath)).toBe(false);
    expect(secrets.readOpenAiApiKey()).toBeUndefined();
  });

  it("fails closed when a protected envelope is corrupt instead of using an environment key", () => {
    const repositoryRoot = root();
    const secrets = store(repositoryRoot, "phase13-environment-fallback-value-0003");
    secrets.storeOpenAiApiKey("phase13-valid-protected-secret-value-0004");
    const secretPath = join(repositoryRoot, ".data", "secrets", "openai-api-key.dpapi");
    writeFileSync(secretPath, '{"version":1,"ciphertext":"not valid"}\n', "utf8");

    expect(secrets.describeOpenAiApiKey()).toMatchObject({
      status: "invalid",
      source: "windows_protected",
      fingerprint: null,
    });
    expect(() => secrets.readOpenAiApiKey()).toThrow("protected OpenAI secret is invalid");
  });

  it("never falls back to plaintext persistence when Windows protection is unavailable", () => {
    const repositoryRoot = root();
    const secrets = new CompositeServerSecrets(
      { OPENAI_API_KEY: "phase13-environment-only-secret-value-0005" },
      { repositoryRoot, platform: "linux", protector },
    );

    expect(secrets.readOpenAiApiKey()).toBe("phase13-environment-only-secret-value-0005");
    expect(() => secrets.storeOpenAiApiKey("phase13-new-secret-value-000000006")).toThrow(
      "Windows protected secret storage is unavailable",
    );
    expect(existsSync(join(repositoryRoot, ".data", "secrets", "openai-api-key.dpapi"))).toBe(
      false,
    );
  });
});
