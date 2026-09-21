import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireSupervisorLock,
  commandFingerprint,
  nextRestartDelay,
  publicMetadata,
  validateSupervisorConfiguration,
} from "../../scripts/phase134/production-supervisor.mjs";

const config = {
  schemaVersion: 1,
  deploymentProfile: "local-live",
  appBaseUrl: "https://bea.localhost:3443",
  hostname: "bea.localhost",
  ports: { web: 3210, https: 3443, workerHealth: 3211, control: 3212, setup: 3444 },
  database: { driver: "postgres", tlsMode: "prefer" },
  queue: { adapter: "pg-boss" },
  worker: { mode: "serve" },
  authentication: { provider: "local-owner", ownerUsername: "andrew", sessionTtlMinutes: 30 },
  https: { pfxPath: "C:\\BEA\\certs\\bea.localhost.pfx" },
  paths: { logDirectory: "C:\\BEA\\logs", backupDirectory: "C:\\BEA\\backups" },
};

describe("Phase 1.3.4 production supervisor", () => {
  it("acquires one instance and replaces only validated stopped stale locks", () => {
    const directory = mkdtempSync(join(tmpdir(), "bea-supervisor-lock-"));
    const path = join(directory, "production.lock");
    const first = acquireSupervisorLock(path);
    expect(existsSync(path)).toBe(true);
    expect(() => acquireSupervisorLock(path, { processIsAlive: () => true })).toThrow(/active/iu);
    first.release();
    expect(existsSync(path)).toBe(false);

    const stale = acquireSupervisorLock(path);
    const evidence = stale.evidence;
    stale.release();
    writeFileSync(path, `${JSON.stringify({ ...evidence, supervisorPid: 999_999 })}\n`);
    const replacement = acquireSupervisorLock(path, { processIsAlive: () => false });
    replacement.release();
    writeFileSync(path, "{}\n");
    expect(() => acquireSupervisorLock(path, { processIsAlive: () => false })).toThrow(
      /invalid.*preserved|unverifiable/iu,
    );
  });

  it("blocks an active restore maintenance lock and replaces only a validated dead one", () => {
    const directory = mkdtempSync(join(tmpdir(), "bea-supervisor-maintenance-lock-"));
    const path = join(directory, "production.lock");
    const maintenance = {
      version: 1,
      kind: "maintenance-restore",
      repositoryRoot: resolve(fileURLToPath(new URL("../..", import.meta.url))),
      ownerPid: 4242,
      operation: "restore",
      nonce: "phase134-maintenance-lock-nonce",
      createdAt: "2026-08-24T12:00:00.000Z",
    };
    writeFileSync(path, `${JSON.stringify(maintenance)}\n`);
    expect(() => acquireSupervisorLock(path, { processIsAlive: () => true })).toThrow(/active/iu);
    const replacement = acquireSupervisorLock(path, { processIsAlive: () => false });
    replacement.release();
  });

  it("accepts only the complete loopback Local Live production contract", () => {
    expect(validateSupervisorConfiguration(config).issues).toEqual([]);
    expect(
      validateSupervisorConfiguration({
        ...config,
        deploymentProfile: "enterprise",
        authentication: { provider: "local-owner" },
      }).issues,
    ).toEqual(expect.arrayContaining(["Local Live profile is required."]));
    expect(
      validateSupervisorConfiguration({
        ...config,
        ports: { ...config.ports, control: config.ports.web },
      }).issues,
    ).toEqual(expect.arrayContaining(["Production ports must be distinct."]));
  });

  it("uses a bounded exponential restart policy", () => {
    expect([0, 1, 2, 3].map(nextRestartDelay)).toEqual([500, 1000, 2000, undefined]);
  });

  it("produces deterministic command identities and never serializes the control token", () => {
    expect(commandFingerprint("C:\\node.exe", ["worker.js", "--serve"])).toMatch(/^[a-f0-9]{64}$/u);
    const metadata = publicMetadata({
      supervisorPid: 123,
      supervisorExecutable: "C:\\node.exe",
      supervisorScript: "C:\\repo\\production-supervisor.mjs",
      supervisorFingerprint: "a".repeat(64),
      controlPort: 3212,
      ports: config.ports,
      children: {},
      state: "starting",
      startedAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:01.000Z",
      controlToken: "must-not-serialize",
    });
    expect(JSON.stringify(metadata)).not.toContain("must-not-serialize");
    expect(metadata.profile).toBe("local-live");
  });
});
