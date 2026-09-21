import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";

import { repositoryRoot } from "./production-paths.mjs";

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function tokensMatch(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const first = createHash("sha256").update(left).digest();
  const second = createHash("sha256").update(right).digest();
  return timingSafeEqual(first, second);
}

export function validateRuntimeMetadata(value) {
  const issues = [];
  if (!record(value)) return { issues: ["Runtime metadata is not an object."] };
  if (value.version !== 2 || value.profile !== "local-live") {
    issues.push("Runtime metadata version/profile is unsupported.");
  }
  if (
    typeof value.repositoryRoot !== "string" ||
    resolve(value.repositoryRoot).toLowerCase() !== repositoryRoot.toLowerCase()
  ) {
    issues.push("Runtime metadata repository does not match this BEA checkout.");
  }
  if (!Number.isSafeInteger(value.supervisorPid) || value.supervisorPid < 1) {
    issues.push("Supervisor PID is invalid.");
  }
  if (
    typeof value.supervisorExecutable !== "string" ||
    resolve(value.supervisorExecutable).toLowerCase() !== resolve(process.execPath).toLowerCase()
  ) {
    issues.push("Supervisor executable does not match the pinned runtime.");
  }
  if (
    typeof value.supervisorScript !== "string" ||
    !resolve(value.supervisorScript)
      .toLowerCase()
      .endsWith("\\scripts\\phase134\\production-supervisor.mjs")
  ) {
    issues.push("Supervisor script identity is invalid.");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.supervisorFingerprint ?? "")) {
    issues.push("Supervisor command fingerprint is invalid.");
  } else {
    const expectedSupervisorFingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          resolve(process.execPath).toLowerCase(),
          resolve(repositoryRoot, "scripts", "phase134", "production-supervisor.mjs"),
        ]),
      )
      .digest("hex");
    if (value.supervisorFingerprint !== expectedSupervisorFingerprint) {
      issues.push("Supervisor command fingerprint does not match the pinned launch contract.");
    }
  }
  if (value.controlHost !== "127.0.0.1") issues.push("Control host is not loopback.");
  if (
    !Number.isSafeInteger(value.controlPort) ||
    value.controlPort < 1 ||
    value.controlPort > 65_535
  ) {
    issues.push("Control port is invalid.");
  }
  const ports = value.ports;
  if (
    !record(ports) ||
    ["web", "https", "workerHealth", "control", "setup"].some(
      (key) => !Number.isSafeInteger(ports[key]) || ports[key] < 1 || ports[key] > 65_535,
    ) ||
    new Set(record(ports) ? Object.values(ports) : []).size !== 5 ||
    ports?.control !== value.controlPort
  ) {
    issues.push("Runtime port metadata is invalid.");
  }
  if (
    !record(value.children) ||
    Object.keys(value.children).sort().join(",") !== "gateway,web,worker"
  ) {
    issues.push("Runtime child metadata is invalid.");
  } else {
    for (const child of Object.values(value.children)) {
      if (
        !record(child) ||
        !Number.isSafeInteger(child.pid) ||
        child.pid < 1 ||
        !/^[a-f0-9]{64}$/u.test(child.commandFingerprint ?? "") ||
        !Number.isSafeInteger(child.restartCount) ||
        child.restartCount < 0 ||
        typeof child.startedAt !== "string" ||
        Number.isNaN(Date.parse(child.startedAt))
      ) {
        issues.push("A runtime child identity is invalid.");
        break;
      }
    }
  }
  if (!new Set(["starting", "ready", "degraded", "stopping", "failed"]).has(value.state)) {
    issues.push("Runtime state is invalid.");
  }
  if (
    typeof value.startedAt !== "string" ||
    Number.isNaN(Date.parse(value.startedAt)) ||
    typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.updatedAt))
  ) {
    issues.push("Runtime timestamps are invalid.");
  }
  if ("controlToken" in value) issues.push("Runtime metadata must not contain the control token.");
  return issues.length === 0 ? { issues, metadata: value } : { issues };
}

export function readRuntimeMetadata(path) {
  try {
    return { exists: true, ...validateRuntimeMetadata(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, issues: [] };
    return { exists: true, issues: ["Runtime metadata could not be parsed."] };
  }
}

export async function controlRequest(metadata, controlToken, path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
  try {
    const response = await fetch(`http://127.0.0.1:${String(metadata.controlPort)}${path}`, {
      method: options.method ?? "GET",
      headers: { "x-bea-control-token": controlToken },
      cache: "no-store",
      signal: controller.signal,
    });
    return {
      body: await response.json().catch(() => undefined),
      ok: response.ok,
      status: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolveCheck) => {
    const server = createNetServer();
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      server.removeAllListeners();
      resolveCheck(result);
    };
    server.once("error", (error) => finish({ available: false, code: error.code ?? "UNKNOWN" }));
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) =>
        finish(
          error ? { available: false, code: error.code ?? "CLOSE_FAILED" } : { available: true },
        ),
      );
    });
  });
}

export async function waitFor(predicate, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, options.intervalMs ?? 250));
  }
  if (lastError) throw lastError;
  throw new Error(options.message ?? "The production owner operation timed out.");
}
