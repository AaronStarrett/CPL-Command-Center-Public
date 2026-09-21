import { describe, expect, it } from "vitest";

import { repositoryRoot } from "../../scripts/phase134/production-paths.mjs";
import { commandFingerprint } from "../../scripts/phase134/production-supervisor.mjs";
import { tokensMatch, validateRuntimeMetadata } from "../../scripts/phase134/runtime-control.mjs";

function validMetadata() {
  const supervisorScript = `${repositoryRoot}\\scripts\\phase134\\production-supervisor.mjs`;
  const child = (pid) => ({
    commandFingerprint: "b".repeat(64),
    exitCode: null,
    pid,
    restartCount: 0,
    signalCode: null,
    startedAt: "2026-08-24T00:00:00.000Z",
  });
  return {
    version: 2,
    profile: "local-live",
    repositoryRoot,
    supervisorPid: 123,
    supervisorExecutable: process.execPath,
    supervisorScript,
    supervisorFingerprint: commandFingerprint(process.execPath, [supervisorScript]),
    controlHost: "127.0.0.1",
    controlPort: 3212,
    ports: { web: 3210, https: 3443, workerHealth: 3211, control: 3212, setup: 3444 },
    children: { web: child(124), worker: child(125), gateway: child(126) },
    state: "ready",
    startedAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:01.000Z",
  };
}

describe("Phase 1.3.4 runtime control", () => {
  it("accepts exact owned metadata and rejects embedded secrets or other repositories", () => {
    expect(validateRuntimeMetadata(validMetadata()).issues).toEqual([]);
    expect(
      validateRuntimeMetadata({ ...validMetadata(), controlToken: "plaintext" }).issues,
    ).toContain("Runtime metadata must not contain the control token.");
    expect(
      validateRuntimeMetadata({ ...validMetadata(), repositoryRoot: "C:\\unrelated" }).issues,
    ).toContain("Runtime metadata repository does not match this BEA checkout.");
  });

  it("compares control tokens without length- or prefix-based acceptance", () => {
    expect(tokensMatch("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(tokensMatch("a".repeat(64), `${"a".repeat(63)}b`)).toBe(false);
    expect(tokensMatch("short", "shorter")).toBe(false);
  });
});
