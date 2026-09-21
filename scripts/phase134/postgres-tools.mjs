import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const postgresProtocols = new Set(["postgres:", "postgresql:"]);

export const PRODUCTION_POSTGRES_PREREQUISITES_SQL = `
  SELECT current_database() AS database_name,current_user AS role_name,
         current_setting('server_version_num')::integer AS server_version_num,
         r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,r.rolreplication,
         (d.datdba=r.oid) AS owns_database,
         has_database_privilege(current_user,current_database(),'CONNECT') AS can_connect,
         has_schema_privilege(current_user,'public','USAGE') AS can_use_schema,
         has_schema_privilege(current_user,'public','CREATE') AS can_create_schema_objects,
         COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),FALSE) AS tls_active,
         EXISTS(
           WITH RECURSIVE inherited_roles(roleid) AS (
             SELECT roleid FROM pg_auth_members WHERE member=r.oid
             UNION
             SELECT membership.roleid
             FROM pg_auth_members membership
             JOIN inherited_roles inherited_role ON membership.member=inherited_role.roleid
           )
           SELECT 1
           FROM inherited_roles inherited_role
           JOIN pg_roles inherited ON inherited.oid=inherited_role.roleid
           WHERE inherited.rolsuper OR inherited.rolcreatedb OR inherited.rolcreaterole
              OR inherited.rolbypassrls OR inherited.rolreplication
              OR left(inherited.rolname, 3) = 'pg_'
         ) AS has_elevated_membership
  FROM pg_roles r
  JOIN pg_database d ON d.datname=current_database()
  WHERE r.rolname=current_user`;

export function isLoopbackPostgresUrl(databaseUrl) {
  try {
    const hostname = new URL(databaseUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function productionPostgresConnectionUrl(databaseUrl, tlsMode) {
  const url = new URL(databaseUrl);
  if (
    !postgresProtocols.has(url.protocol) ||
    !["prefer", "require", "verify-full"].includes(tlsMode)
  ) {
    throw new Error("The production PostgreSQL connection policy is invalid.");
  }
  for (const key of [...url.searchParams.keys()]) {
    if (["ssl", "sslmode"].includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.set("sslmode", tlsMode);
  return url.toString();
}

export function validateProductionPostgresPrerequisites(row, options) {
  const major = Math.floor(Number(row?.server_version_num ?? 0) / 10_000);
  if (!row || major < 14 || major > 18) {
    throw new Error("The PostgreSQL server version is unsupported.");
  }
  if (
    row.rolsuper ||
    row.rolcreatedb ||
    row.rolcreaterole ||
    row.rolbypassrls ||
    row.rolreplication ||
    row.owns_database ||
    row.has_elevated_membership ||
    !row.can_connect ||
    !row.can_use_schema ||
    !row.can_create_schema_objects
  ) {
    throw new Error(
      "The PostgreSQL application role is not least-privileged and migration-capable.",
    );
  }
  const tlsRequired =
    options.forceTls === true ||
    options.tlsMode !== "prefer" ||
    !isLoopbackPostgresUrl(options.databaseUrl);
  if (tlsRequired && row.tls_active !== true) {
    throw new Error("The selected PostgreSQL TLS policy was not active.");
  }
  return Object.freeze({
    databaseName: String(row.database_name),
    roleName: String(row.role_name),
    serverMajor: major,
    tlsActive: row.tls_active === true,
  });
}

function officialInstallCandidates(environment = process.env) {
  const programFiles = environment.ProgramFiles ?? "C:\\Program Files";
  const root = join(programFiles, "PostgreSQL");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)?$/u.test(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
    .map((entry) => join(root, entry.name, "bin"));
}

const signatureInspectionScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$signature = Get-AuthenticodeSignature -LiteralPath ([string]$inputData.path)
[ordered]@{
  status = [string]$signature.Status
  publisher = if ($null -ne $signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { $null }
} | ConvertTo-Json -Compress | Write-Output
`;

function inspectAuthenticode(path, options = {}) {
  const powershell =
    options.powershellExecutable ??
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  const result = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      signatureInspectionScript,
    ],
    {
      encoding: "utf8",
      input: JSON.stringify({ path }),
      shell: false,
      windowsHide: true,
    },
  );
  if (result.status !== 0 || result.error) {
    throw new Error("PostgreSQL tool publisher verification failed.");
  }
  try {
    return JSON.parse(String(result.stdout ?? ""));
  } catch {
    throw new Error("PostgreSQL tool publisher evidence is invalid.");
  }
}

function inspectToolVersion(path) {
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    throw new Error("PostgreSQL tool version verification failed.");
  }
  const match = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/u.exec(String(result.stdout ?? ""));
  if (!match) throw new Error("PostgreSQL tool version evidence is invalid.");
  return Object.freeze({ major: Number(match[1]), version: `${match[1]}.${match[2] ?? "0"}` });
}

function trustedPostgresPublisher(value) {
  return (
    typeof value === "string" &&
    /(?:^|,\s*)(?:O|CN)=(?:EnterpriseDB Corporation|EnterpriseDB|EDB|PostgreSQL Global Development Group)(?:,|$)/iu.test(
      value,
    )
  );
}

export function resolvePostgresTools(config, options = {}) {
  const environment = options.environment ?? process.env;
  const explicit = config.database?.toolsDirectory;
  if (explicit !== null && explicit !== undefined && (!isAbsolute(explicit) || !explicit)) {
    throw new Error("The configured PostgreSQL tool directory must be absolute.");
  }
  const directories = explicit ? [resolve(explicit)] : officialInstallCandidates(environment);
  const found = {};
  for (const name of ["pg_dump.exe", "pg_restore.exe"]) {
    for (const directory of directories) {
      const candidate = join(directory, name);
      if (
        existsSync(candidate) &&
        lstatSync(candidate).isFile() &&
        !lstatSync(candidate).isSymbolicLink()
      ) {
        found[name] = resolve(candidate);
        break;
      }
    }
  }
  if (!found["pg_dump.exe"] || !found["pg_restore.exe"]) {
    throw new Error("PostgreSQL pg_dump and pg_restore are required for backup readiness.");
  }
  if (
    dirname(found["pg_dump.exe"]).toLowerCase() !== dirname(found["pg_restore.exe"]).toLowerCase()
  ) {
    throw new Error("pg_dump and pg_restore must come from the same PostgreSQL tool directory.");
  }
  const inspectVersion = options.inspectVersion ?? inspectToolVersion;
  const dumpVersion = inspectVersion(found["pg_dump.exe"]);
  const restoreVersion = inspectVersion(found["pg_restore.exe"]);
  if (
    dumpVersion.major !== restoreVersion.major ||
    dumpVersion.major < 14 ||
    dumpVersion.major > 18
  ) {
    throw new Error("PostgreSQL backup tools must use one supported 14-18 major version.");
  }
  const inspectSignature = options.inspectSignature ?? inspectAuthenticode;
  const signatures = [
    inspectSignature(found["pg_dump.exe"], options),
    inspectSignature(found["pg_restore.exe"], options),
  ];
  if (
    signatures.some(
      (signature) => signature.status !== "Valid" || !trustedPostgresPublisher(signature.publisher),
    )
  ) {
    throw new Error("PostgreSQL backup tools are not signed by an approved official publisher.");
  }
  return Object.freeze({
    directory: dirname(found["pg_dump.exe"]),
    pgDump: found["pg_dump.exe"],
    pgRestore: found["pg_restore.exe"],
    majorVersion: dumpVersion.major,
    publisher: signatures[0].publisher,
  });
}

export function postgresConnectionEnvironment(databaseUrl, tlsMode, source = process.env) {
  const url = new URL(databaseUrl);
  if (!postgresProtocols.has(url.protocol)) {
    throw new Error("The protected database URL is not PostgreSQL.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  const user = decodeURIComponent(url.username);
  if (!url.hostname || !database || !user)
    throw new Error("The protected PostgreSQL URL is incomplete.");
  const inherited = Object.fromEntries(
    ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE"]
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
  return Object.freeze({
    ...inherited,
    PGDATABASE: database,
    PGHOST: url.hostname,
    PGPASSWORD: decodeURIComponent(url.password),
    PGPORT: url.port || "5432",
    PGSSLMODE: tlsMode,
    PGUSER: user,
  });
}

export function safeDatabaseDescriptor(databaseUrl) {
  const url = new URL(databaseUrl);
  return Object.freeze({
    database: decodeURIComponent(url.pathname.replace(/^\//u, "")),
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
  });
}

export function runPostgresTool(executable, arguments_, environment, options = {}) {
  const result = spawnSync(executable, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: options.stdio ?? "pipe",
  });
  return Object.freeze({
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
  });
}
