import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { WindowsDpapiCurrentUserProtector } from "./phase134/production-secrets.mjs";
import { REPOSITORY_ID } from "./repository-boundary.mjs";
import { loadLocalIntegrationMaterial } from "./cpl-local-integration-secrets.mjs";

export const DEVELOPMENT_DATABASE_PORT = 55433;
export const DEVELOPMENT_DATABASE_NAME = "cpl_local_development";

function checkedPath(base, target) {
  if (!target.toLowerCase().startsWith(base.toLowerCase() + path.sep))
    throw new Error("Development database storage boundary refused.");
  let current = target;
  while (!existsSync(current)) current = path.dirname(current);
  if (realpathSync.native(current).toLowerCase() !== path.resolve(current).toLowerCase())
    throw new Error("Redirected development database storage refused.");
}

export function developmentDatabasePaths(cacheRoot) {
  const base = path.join(cacheRoot, "local-development");
  return {
    base,
    data: path.join(base, "postgres-data"),
    marker: path.join(base, "owner.json"),
    credentials: path.join(base, "credentials.dpapi"),
    log: path.join(base, "postgres.log"),
    bin: path.join(cacheRoot, "toolchain", "postgresql-16.15", "pgsql", "bin"),
  };
}

export async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Local port ${port} is already in use. Stop its owning application; no process was terminated.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

/** This owns only the explicitly marked synthetic cluster. Existing acceptance
 * clusters and cloud databases are never read, reconfigured, stopped or reset. */
export async function startDevelopmentDatabase({
  root,
  cacheRoot,
  environment,
  onProgress = () => {},
}) {
  const paths = developmentDatabasePaths(cacheRoot);
  for (const value of Object.values(paths)) checkedPath(cacheRoot, value);
  const pgctl = path.join(paths.bin, "pg_ctl.exe");
  const initdb = path.join(paths.bin, "initdb.exe");
  if (!existsSync(pgctl) || !existsSync(initdb))
    throw new Error(
      "The verified portable PostgreSQL 16.15 toolchain is missing from the SSD. No download or installation was attempted.",
    );
  mkdirSync(paths.base, { recursive: true });
  const expected = {
    repositoryId: REPOSITORY_ID,
    root,
    purpose: "synthetic-local-development",
    port: DEVELOPMENT_DATABASE_PORT,
  };
  if (existsSync(paths.marker)) {
    const actual = JSON.parse(readFileSync(paths.marker, "utf8"));
    if (Object.keys(expected).some((key) => actual[key] !== expected[key]))
      throw new Error(
        "The local database belongs to a different checkout. Existing data was preserved.",
      );
  } else {
    if (existsSync(paths.data) || existsSync(paths.credentials))
      throw new Error("Unmarked local database files were found. Existing data was preserved.");
    writeFileSync(paths.marker, JSON.stringify(expected) + "\n", { flag: "wx" });
  }
  const protector = new WindowsDpapiCurrentUserProtector();
  onProgress("Unlocking this Windows user's protected local development credentials...");
  let credentials;
  if (existsSync(paths.credentials)) {
    try {
      credentials = JSON.parse(protector.unprotect(readFileSync(paths.credentials, "utf8").trim()));
    } catch {
      throw new Error(
        "The local database credentials cannot be unlocked by this Windows user. Existing data was preserved.",
      );
    }
  } else {
    if (existsSync(path.join(paths.data, "PG_VERSION")))
      throw new Error("Local database credentials are missing. Existing data was preserved.");
    credentials = {
      operator: randomBytes(32).toString("hex"),
      web: randomBytes(32).toString("hex"),
      worker: randomBytes(32).toString("hex"),
    };
    writeFileSync(paths.credentials, protector.protect(JSON.stringify(credentials)), {
      flag: "wx",
      mode: 0o600,
    });
  }
  if (
    !credentials ||
    ![credentials.operator, credentials.web, credentials.worker].every((value) =>
      /^[a-f0-9]{64}$/u.test(value),
    )
  )
    throw new Error("The local database credential format was refused.");
  const childOptions = {
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 65_000,
  };
  // PostgreSQL descendants must not inherit captured pipes on Windows: those
  // handles keep spawnSync waiting even after pg_ctl has finished successfully.
  const pg = (args) =>
    spawnSync(pgctl, ["-D", paths.data, ...args], { ...childOptions, stdio: "ignore" });
  const wasRunning = existsSync(path.join(paths.data, "PG_VERSION")) && pg(["status"]).status === 0;
  if (!wasRunning) await assertPortAvailable(DEVELOPMENT_DATABASE_PORT);
  if (!existsSync(path.join(paths.data, "PG_VERSION"))) {
    onProgress("Preparing the isolated local PostgreSQL database (first launch only)...");
    const passwordFile = path.join(paths.base, "initialize-password.tmp");
    checkedPath(cacheRoot, passwordFile);
    try {
      writeFileSync(passwordFile, credentials.operator + "\n", { flag: "wx", mode: 0o600 });
      execFileSync(
        initdb,
        [
          "-D",
          paths.data,
          "--username=cpl_local_operator",
          "--auth=scram-sha-256",
          "--encoding=UTF8",
          "--locale=C",
          "--pwfile=" + passwordFile,
        ],
        childOptions,
      );
    } catch {
      throw new Error(
        "Local PostgreSQL initialization failed. Existing files were preserved; check the SSD and local-development directory.",
      );
    } finally {
      if (existsSync(passwordFile)) rmSync(passwordFile);
    }
    writeFileSync(
      path.join(paths.data, "postgresql.auto.conf"),
      "# Dedicated synthetic CPL development cluster.\nlisten_addresses = '127.0.0.1'\nport = 55433\nmax_connections = 30\nshared_buffers = '64MB'\npassword_encryption = 'scram-sha-256'\n",
    );
  }
  // Explicit startup options enforce loopback even after a manual config edit.
  if (
    !wasRunning &&
    pg(["-l", paths.log, "-o", "-h 127.0.0.1 -p 55433", "-w", "-t", "60", "start"]).status !== 0
  )
    throw new Error(
      "Local PostgreSQL did not start. See the SSD local-development/postgres.log; no cloud database was contacted.",
    );
  const connection = (role, password, database = DEVELOPMENT_DATABASE_NAME) =>
    `postgresql://${role}:${password}@127.0.0.1:${DEVELOPMENT_DATABASE_PORT}/${database}`;
  const settings = {
    expectedDataDirectory: paths.data,
    operatorUrl: connection("cpl_local_operator", credentials.operator),
    bootstrapUrl: connection("cpl_local_operator", credentials.operator, "postgres"),
    webUrl: connection("cpl_local_web", credentials.web),
    workerUrl: connection("cpl_local_worker", credentials.worker),
  };
  let runtime;
  const stop = async () => {
    await runtime?.stopJobs();
    if (pg(["status"]).status !== 0) return;
    // pg_ctl targets this verified cluster directory, never an arbitrary PID/port.
    if (pg(["-m", "fast", "-w", "-t", "60", "stop"]).status !== 0)
      throw new Error("The owned local database could not stop cleanly. Its data was preserved.");
  };
  try {
    onProgress("Checking local schema, restricted roles and synthetic workspace...");
    // The launcher itself imports this operator helper. Keep its loader cache on
    // the SSD too, not just the web child process's caches.
    for (const key of ["TEMP", "TMP", "TMPDIR", "XDG_CACHE_HOME"])
      if (environment[key]) process.env[key] = environment[key];
    process.env.TSX_DISABLE_CACHE = "1";
    const { tsImport } = await import("tsx/esm/api");
    const module = await tsImport("./cpl-development-runtime.ts", import.meta.url);
    const integrationEnvironment = {
      ...environment,
      CPL_LOCAL_DEVELOPMENT_AUTH: "true",
      CPL_HOSTED_ENABLED: "false",
      CPL_INTEGRATION_PROVIDER_MODE: "local_fixture",
      CPL_LOCAL_INTEGRATION_MATERIAL: loadLocalIntegrationMaterial({ root, cacheRoot }),
    };
    runtime = await module.prepareDevelopmentRuntime(settings, integrationEnvironment);
    onProgress("Local PostgreSQL ready. Synthetic development records stay on the SSD.");
    return {
      webUrl: settings.webUrl,
      stop,
      startJobs: runtime.startJobs,
      status: runtime.status,
      integrationEnvironment: {
        CPL_LOCAL_SCHEMA_MANIFEST: JSON.stringify(runtime.expectedSchema),
        CPL_INTEGRATION_PROVIDER_MODE: "local_fixture",
        CPL_LOCAL_INTEGRATION_MATERIAL: integrationEnvironment.CPL_LOCAL_INTEGRATION_MATERIAL,
      },
    };
  } catch (error) {
    await stop();
    const diagnostic = String(error?.message ?? "Unknown local initialization error")
      .replaceAll(credentials.operator, "[redacted]")
      .replaceAll(credentials.web, "[redacted]")
      .replaceAll(credentials.worker, "[redacted]")
      .replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, "[redacted database connection]");
    onProgress("Local database check: " + diagnostic.slice(0, 500));
    const code =
      typeof error?.code === "string" && /^[A-Z0-9_]{1,80}$/u.test(error.code)
        ? error.code
        : typeof error?.message === "string" && /^CPL_[A-Z0-9_]{1,80}$/u.test(error.message)
          ? error.message
          : "BOOTSTRAP_FAILED";
    throw new Error(
      "Local database schema/fixture verification failed (" +
        code +
        "). Existing data was preserved; run CPL-Doctor.cmd. No cloud database was used.",
    );
  }
}
