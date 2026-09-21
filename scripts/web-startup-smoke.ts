import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const host = "127.0.0.1";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const webRoot = join(repositoryRoot, "apps", "web");
const buildIdPath = join(webRoot, ".next", "BUILD_ID");
const outputLimit = 16_000;
const failureOutputLimit = 4_000;
const redactedValue = "[REDACTED]";
const sensitiveKey =
  /(?:password|secret|token|authorization|cookie|credential|api[-_]?key|session)/iu;
const childEnvironmentAllowlist = [
  "APPDATA",
  "ComSpec",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "Path",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
] as const;
let childOutput = "";
let activeSensitiveValues: readonly string[] = [];

export function createAllowlistedChildEnvironment(
  parentEnvironment: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of childEnvironmentAllowlist) {
    const value = parentEnvironment[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...overrides };
}

function limitFailureText(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  const suffix = "...[TRUNCATED]";
  return `${value.slice(0, Math.max(0, maximumLength - suffix.length))}${suffix}`;
}

function redactFailureText(
  value: string,
  sensitiveValues: readonly string[],
  maximumLength: number,
): string {
  let sanitized = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length > 0) {
      sanitized = sanitized.split(sensitiveValue).join(redactedValue);
    }
  }
  sanitized = sanitized
    .replace(/(bearer\s+)[a-z\d._~+/-]+=*/giu, `$1${redactedValue}`)
    .replace(/(https?:\/\/)[^/\s:@]+:[^@/\s]+@/giu, `$1${redactedValue}@`)
    .replace(
      /((?:password|secret|token|authorization|cookie|credential|api[-_]?key|session)[\w.-]*\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/giu,
      `$1${redactedValue}`,
    );
  return limitFailureText(sanitized, maximumLength);
}

function redactFailureValue(
  value: unknown,
  sensitiveValues: readonly string[],
  visited: WeakSet<object>,
  depth: number,
): unknown {
  if (depth > 8) return "[DEPTH_LIMIT]";
  if (typeof value === "string") {
    return redactFailureText(value, sensitiveValues, 2_000);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (visited.has(value)) return "[CIRCULAR]";
  visited.add(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactFailureText(value.message, sensitiveValues, 2_000),
    };
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 25)
      .map((item) => redactFailureValue(item, sensitiveValues, visited, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .map(([key, nested]) => [
        key,
        sensitiveKey.test(key)
          ? redactedValue
          : redactFailureValue(nested, sensitiveValues, visited, depth + 1),
      ]),
  );
}

export function sanitizeFailureOutput(
  input: unknown,
  sensitiveValues: readonly string[] = [],
  maximumLength = failureOutputLimit,
): string {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return sanitizeFailureOutput(JSON.parse(trimmed), sensitiveValues, maximumLength);
      } catch {
        // Malformed structured output is redacted as bounded text below.
      }
    }
    return redactFailureText(input, sensitiveValues, maximumLength);
  }
  const redacted = redactFailureValue(input, sensitiveValues, new WeakSet<object>(), 0);
  const serialized = JSON.stringify(redacted) ?? String(redacted);
  return redactFailureText(serialized, sensitiveValues, maximumLength);
}

function appendOutput(source: "stdout" | "stderr", chunk: Buffer | string): void {
  childOutput = `${childOutput}[${source}] ${chunk.toString()}`.slice(-outputLimit);
}

async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a local TCP port for the web smoke test."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function childStopped(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (childStopped(child)) return true;
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMilliseconds);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("exit", onExit);
    if (childStopped(child)) onExit();
  });
}

async function terminateExactChild(child: ChildProcess): Promise<void> {
  if (childStopped(child)) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 5_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForChildExit(child, 5_000))) {
    throw new Error(`Web smoke child PID ${child.pid ?? "unknown"} did not terminate.`);
  }
}

async function fetchWithTimeout(
  url: string,
  timeoutMilliseconds: number,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    return await fetch(url, {
      ...init,
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForSignIn(
  child: ChildProcess,
  baseUrl: string,
  sensitiveValues: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastObservation = "server not reachable";
  while (Date.now() < deadline) {
    if (childStopped(child)) {
      throw new Error(
        `Built web server exited before readiness (exit=${String(child.exitCode)}, signal=${String(child.signalCode)}).\n${sanitizeFailureOutput(childOutput, sensitiveValues)}`,
      );
    }
    try {
      const response = await fetchWithTimeout(`${baseUrl}/sign-in`, 5_000);
      const body = await response.text();
      lastObservation = `HTTP ${response.status}`;
      if (
        response.status === 200 &&
        response.headers.get("content-type")?.includes("text/html") &&
        (body.includes("Open the local demo") ||
          body.includes("Open the local development workspace"))
      ) {
        return;
      }
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await delay(150);
  }
  throw new Error(
    `Built web server was not ready within 60 seconds: ${sanitizeFailureOutput(lastObservation, sensitiveValues, 1_000)}.\n${sanitizeFailureOutput(childOutput, sensitiveValues)}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeHealthShape(response: Response, bodyText: string, sentinel: string): void {
  if (response.status !== 200 && response.status !== 503) {
    throw new Error(`Web health returned unexpected HTTP ${response.status}.`);
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("Web health did not return JSON.");
  }
  if (bodyText.includes(sentinel)) {
    throw new Error("Web health exposed a server-only smoke credential marker.");
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(
      `Web health returned malformed JSON: ${sanitizeFailureOutput(bodyText, [sentinel])}`,
    );
  }
  if (
    !isRecord(body) ||
    body.service !== "bea-operations-command-center-web" ||
    body.phase !== "0" ||
    !["healthy", "degraded", "unhealthy"].includes(String(body.status)) ||
    typeof body.timestamp !== "string" ||
    Number.isNaN(Date.parse(body.timestamp)) ||
    typeof body.correlationId !== "string" ||
    !isRecord(body.components) ||
    body.components.web !== "healthy"
  ) {
    throw new Error(
      `Web health returned an unexpected safe shape: ${sanitizeFailureOutput(body, [sentinel])}`,
    );
  }

  const sensitiveKey = /(?:authorization|cookie|credential|password|secret|token)/iu;
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      if (sensitiveKey.test(key)) {
        throw new Error(`Web health exposed a sensitive field name: ${key}.`);
      }
      inspect(nested);
    }
  };
  inspect(body);
}

async function assertLocalDemoCookie(baseUrl: string): Promise<void> {
  const form = new URLSearchParams({
    personaId: "10000000-0000-4000-8000-000000000002",
    returnTo: "/",
  });
  const response = await fetchWithTimeout(`${baseUrl}/api/auth/sign-in`, 15_000, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: baseUrl,
    },
    body: form,
  });
  const cookie = response.headers.get("set-cookie") ?? "";
  if (
    response.status !== 303 ||
    !cookie.includes("bea_session=") ||
    !/;\s*HttpOnly/iu.test(cookie) ||
    !/;\s*SameSite=Lax/iu.test(cookie) ||
    /;\s*Secure/iu.test(cookie)
  ) {
    throw new Error("Local HTTP demo sign-in returned an unsafe or unusable cookie policy.");
  }
}

async function main(): Promise<void> {
  if (!existsSync(buildIdPath)) {
    throw new Error("Built web artifact is missing. Run `pnpm build:web` before `pnpm smoke:web`.");
  }

  const port = await findFreePort();
  const baseUrl = `http://${host}:${port}`;
  const credentialSentinel = `web-smoke-${randomUUID()}-${randomUUID()}`;
  activeSensitiveValues = [credentialSentinel];
  const requireFromWeb = createRequire(join(webRoot, "package.json"));
  const nextPackagePath = requireFromWeb.resolve("next/package.json");
  const nextCliPath = join(dirname(nextPackagePath), "dist", "bin", "next");
  const child = spawn(
    process.execPath,
    [nextCliPath, "start", "--hostname", host, "--port", String(port)],
    {
      cwd: webRoot,
      env: createAllowlistedChildEnvironment(process.env, {
        NODE_ENV: "production",
        APP_MODE: "demo",
        APP_BASE_URL: baseUrl,
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        WORKER_DEMO_DATABASE_PATH: "memory://",
        DEMO_AUTH_ENABLED: "true",
        SESSION_SECRET: credentialSentinel,
        WORKER_MODE: "once",
        WORKER_QUEUE_ADAPTER: "inline",
        WORKER_HEALTH_PORT: "0",
        LOG_LEVEL: "silent",
        PORT: String(port),
      }),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout?.on("data", (chunk: Buffer | string) => appendOutput("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer | string) => appendOutput("stderr", chunk));

  try {
    await waitForSignIn(child, baseUrl, activeSensitiveValues);
    await assertLocalDemoCookie(baseUrl);
    const healthResponse = await fetchWithTimeout(`${baseUrl}/api/health`, 15_000);
    const healthBody = await healthResponse.text();
    assertSafeHealthShape(healthResponse, healthBody, credentialSentinel);
    process.stdout.write(
      `${JSON.stringify({
        code: "BEA_WEB_STARTUP_SMOKE_OK",
        host,
        port,
        signInStatus: 200,
        demoSignInStatus: 303,
        demoCookieSecure: false,
        healthStatus: healthResponse.status,
        childPid: child.pid,
      })}\n`,
    );
  } finally {
    await terminateExactChild(child);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    const message = sanitizeFailureOutput(
      error instanceof Error ? error.message : error,
      activeSensitiveValues,
    );
    process.stderr.write(`${JSON.stringify({ code: "BEA_WEB_STARTUP_SMOKE_FAILED", message })}\n`);
    process.exitCode = 1;
  });
}
