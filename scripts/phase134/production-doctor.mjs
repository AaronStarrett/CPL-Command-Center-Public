import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { assertRepositoryBoundary } from "../repository-boundary.mjs";
import { CONFIG_SCHEMA_VERSION, readProductionConfig } from "./production-config.mjs";
import { inspectCertificateTrust, validateCertificateMetadata } from "./production-certificate.mjs";
import {
  productionPaths,
  repositoryRoot,
  TOOLCHAIN_NODE_VERSION,
  TOOLCHAIN_PNPM_VERSION,
} from "./production-paths.mjs";
import { verifyPinnedToolchain } from "./toolchain-bootstrap.mjs";
import { readProductionSecrets, readSecretStatus } from "./production-secrets.mjs";
import {
  PRODUCTION_POSTGRES_PREREQUISITES_SQL,
  productionPostgresConnectionUrl,
  validateProductionPostgresPrerequisites,
} from "./postgres-tools.mjs";
import {
  checkPortAvailable,
  controlRequest,
  processIsAlive,
  readRuntimeMetadata,
} from "./runtime-control.mjs";
import { inspectAcl } from "./windows-acl.mjs";

const requireFromRoot = createRequire(join(repositoryRoot, "package.json"));
const productionHealthQueue = "bea.phase134.production-health";

function add(checks, name, status, detail, options = {}) {
  checks.push({
    name,
    status,
    detail,
    blocker: options.blocker ?? status === "BLOCKED",
    startBlocker:
      options.startBlocker ??
      (status === "BLOCKED" || (status === "SETUP REQUIRED" && !options.nonBlocking)),
  });
}

function run(command, arguments_, options = {}) {
  const commandIsBatch = /\.(?:cmd|bat)$/iu.test(command);
  const executable = commandIsBatch ? (process.env.ComSpec ?? "cmd.exe") : command;
  const executableArguments = commandIsBatch
    ? ["/d", "/s", "/c", "call", command, ...arguments_]
    : arguments_;
  const result = spawnSync(executable, executableArguments, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: false,
    windowsHide: true,
  });
  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
  };
}

function firstLine(result) {
  return (result.stdout || result.stderr).split(/\r?\n/u).find(Boolean) ?? "no output";
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function currentMigrationVersion() {
  const directory = join(repositoryRoot, "packages", "database", "migrations");
  return (
    readdirSync(directory)
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
      .sort()
      .at(-1) ?? "none"
  );
}

export function aclIsRestricted(text) {
  const normalized = String(text).toLowerCase();
  return !["everyone", "builtin\\users", "authenticated users", "well-known group\\users"].some(
    (forbidden) => normalized.includes(forbidden),
  );
}

function validateBuildManifest(config, options = {}) {
  const path = options.path ?? productionPaths.buildManifestFile;
  if (!existsSync(path)) return { ok: false, reason: "build manifest is absent" };
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const git = (options.run ?? run)("git", [
      "-c",
      `safe.directory=${repositoryRoot.replaceAll("\\", "/")}`,
      "rev-parse",
      "HEAD",
    ]);
    const lockHash = sha256File(join(repositoryRoot, "pnpm-lock.yaml"));
    const expected = {
      gitCommit: git.stdout,
      nodeVersion: TOOLCHAIN_NODE_VERSION,
      pnpmVersion: TOOLCHAIN_PNPM_VERSION,
      configSchemaVersion: CONFIG_SCHEMA_VERSION,
      databaseMigrationVersion: currentMigrationVersion().replace(/\.sql$/u, ""),
      packageLockSha256: lockHash,
    };
    const mismatches = Object.entries(expected)
      .filter(([key, value]) => manifest[key] !== value)
      .map(([key]) => key);
    return mismatches.length === 0
      ? { ok: true, manifest }
      : { ok: false, reason: `build manifest is stale (${mismatches.join(", ")})` };
  } catch {
    return { ok: false, reason: "build manifest is invalid" };
  }
}

async function inspectPostgres(config, secrets, options = {}) {
  const pgModule = options.pgModule ?? requireFromRoot("pg");
  const pool = new pgModule.Pool({
    connectionString: productionPostgresConnectionUrl(secrets.databaseUrl, config.database.tlsMode),
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
  try {
    const result = await pool.query(PRODUCTION_POSTGRES_PREREQUISITES_SQL);
    const row = result.rows.at(0);
    const prerequisites = validateProductionPostgresPrerequisites(row, {
      databaseUrl: secrets.databaseUrl,
      tlsMode: config.database.tlsMode,
    });
    const queueTables = await pool.query(
      "SELECT to_regclass('pgboss.job')::text AS pgboss_job,to_regclass('pgboss.queue')::text AS pgboss_queue",
    );
    const queueRow = queueTables.rows.at(0) ?? {};
    const ledger = await pool.query("SELECT id,checksum FROM bea_schema_migrations ORDER BY id");
    const migrationDirectory = join(repositoryRoot, "packages", "database", "migrations");
    const expected = readdirSync(migrationDirectory)
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
      .sort()
      .map((id) => ({ id, checksum: sha256File(join(migrationDirectory, id)) }));
    if (
      ledger.rows.length !== expected.length ||
      expected.some(
        (migration, index) =>
          ledger.rows[index]?.id !== migration.id ||
          ledger.rows[index]?.checksum !== migration.checksum,
      )
    ) {
      throw new Error("PostgreSQL migration ledger is missing, stale, or drifted.");
    }
    let queueContractReady = false;
    let activationAuditReady = false;
    if (queueRow.pgboss_job && queueRow.pgboss_queue) {
      const queue = await pool.query(
        "SELECT EXISTS(SELECT 1 FROM pgboss.queue WHERE name=$1) AS ready",
        [productionHealthQueue],
      );
      queueContractReady = queue.rows[0]?.ready === true;
      const activation = await pool.query(
        `SELECT EXISTS(
           SELECT 1 FROM audit_logs
           WHERE event_type='production.configuration-activated'
             AND action='production.configure' AND outcome='succeeded'
             AND metadata->>'queueVerified'='true'
         ) AS ready`,
      );
      activationAuditReady = activation.rows[0]?.ready === true;
    }
    const provider = await pool.query(
      `SELECT c.connection_status,c.requirement_status,c.mock_mode,c.test_mode,
              t.authenticated,t.outcome,t.credential_fingerprint
       FROM integration_connections c
       LEFT JOIN LATERAL (
         SELECT authenticated,outcome,credential_fingerprint
         FROM ai_provider_connection_tests
         WHERE provider='openai' ORDER BY tested_at DESC,id DESC LIMIT 1
       ) t ON TRUE
       WHERE c.provider_type='ai' LIMIT 1`,
    );
    const owner = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM auth_identities) AS identities,
        (SELECT COUNT(*) FROM auth_identities WHERE provider='local-owner') AS local_identities,
        (SELECT COUNT(*) FROM local_owner_credentials) AS local_credentials,
        (SELECT COUNT(*)
         FROM users u
         JOIN auth_identities ai ON ai.user_id=u.id AND ai.provider='local-owner'
         JOIN local_owner_credentials loc ON loc.user_id=u.id
         JOIN user_roles ur ON ur.user_id=u.id
         JOIN roles r ON r.id=ur.role_id AND r.key='owner-admin' AND r.status='active'
         WHERE u.status='active' AND u.archived_at IS NULL AND u.persona_key IS NULL
           AND u.email IS NULL AND u.display_name='Andrew McMullan'
           AND u.title='Chief Executive Officer') AS owner_contract,
        (SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at>CURRENT_TIMESTAMP) AS active_sessions
    `);
    const providerRow = provider.rows[0];
    const ownerRow = owner.rows[0] ?? {};
    return {
      databaseName: prerequisites.databaseName,
      roleName: prerequisites.roleName,
      serverMajor: prerequisites.serverMajor,
      tlsActive: prerequisites.tlsActive,
      migrationVersion: expected.at(-1)?.id ?? "none",
      pgBossReady:
        Boolean(queueRow.pgboss_job) &&
        Boolean(queueRow.pgboss_queue) &&
        queueContractReady &&
        activationAuditReady,
      openAiConnection: providerRow
        ? {
            connected:
              providerRow.connection_status === "connected" &&
              providerRow.requirement_status === "CONNECTED" &&
              providerRow.mock_mode === false &&
              providerRow.test_mode === false &&
              providerRow.authenticated === true &&
              providerRow.outcome === "succeeded",
            credentialFingerprint: providerRow.credential_fingerprint ?? null,
          }
        : { connected: false, credentialFingerprint: null },
      ownerReady:
        Number(ownerRow.users ?? 0) === 1 &&
        Number(ownerRow.identities ?? 0) === 1 &&
        Number(ownerRow.local_identities ?? 0) === 1 &&
        Number(ownerRow.local_credentials ?? 0) === 1 &&
        Number(ownerRow.owner_contract ?? 0) === 1,
      activeSessionCount: Number(ownerRow.active_sessions ?? 0),
    };
  } finally {
    await pool.end();
  }
}

export async function collectProductionDoctorReport(options = {}) {
  const checks = [];
  const paths = options.paths ?? productionPaths;
  const runner = options.run ?? run;
  (options.assertBoundary ?? assertRepositoryBoundary)({
    cwd: repositoryRoot,
    target: repositoryRoot,
  });
  add(checks, "Repository boundary", "PASS", repositoryRoot);

  const windows = (options.platform ?? process.platform) === "win32";
  add(checks, "Windows", windows ? "PASS" : "BLOCKED", windows ? "win32" : "Windows is required");
  const nodeVersion = (options.nodeVersion ?? process.version).replace(/^v/u, "");
  add(
    checks,
    "BEA-owned Node",
    nodeVersion === TOOLCHAIN_NODE_VERSION ? "PASS" : "BLOCKED",
    nodeVersion === TOOLCHAIN_NODE_VERSION
      ? `exact Node ${nodeVersion}`
      : `exact Node ${TOOLCHAIN_NODE_VERSION} is required; received ${nodeVersion}`,
  );
  const toolchain = (options.verifyToolchain ?? verifyPinnedToolchain)({
    paths,
    run: runner,
    environment: options.environment ?? process.env,
  });
  add(
    checks,
    "Isolated pnpm",
    toolchain.pnpmReady && toolchain.pnpmVersion === TOOLCHAIN_PNPM_VERSION ? "PASS" : "BLOCKED",
    toolchain.pnpmReady
      ? `pnpm ${toolchain.pnpmVersion} at ${toolchain.pnpmPath}`
      : `${toolchain.code}: pnpm=${toolchain.pnpmVersion || "unavailable"} at ${toolchain.pnpmPath}`,
  );

  const git = runner("git", [
    "-c",
    `safe.directory=${repositoryRoot.replaceAll("\\", "/")}`,
    "--version",
  ]);
  add(checks, "Git", git.exitCode === 0 ? "PASS" : "BLOCKED", firstLine(git));
  add(
    checks,
    "Dependencies",
    existsSync(join(repositoryRoot, "node_modules")) ? "PASS" : "SETUP REQUIRED",
    existsSync(join(repositoryRoot, "node_modules"))
      ? "repository dependencies are present"
      : "run Configure-BEA to install frozen dependencies",
  );

  let config;
  try {
    config = (options.readConfig ?? readProductionConfig)({ filePath: paths.configFile });
    add(
      checks,
      "Production config",
      "PASS",
      `schema ${String(config.schemaVersion)} ${config.deploymentProfile}`,
    );
  } catch (error) {
    add(
      checks,
      "Production config",
      existsSync(paths.configFile) ? "BLOCKED" : "SETUP REQUIRED",
      existsSync(paths.configFile)
        ? `configuration is invalid (${error instanceof Error ? error.name : "UnknownError"})`
        : "run Configure-BEA to create the protected Local Live profile",
    );
  }

  let secretStatus;
  try {
    secretStatus = (options.readSecretStatus ?? readSecretStatus)({ filePath: paths.secretFile });
    add(
      checks,
      "Protected secret store",
      secretStatus.available ? "PASS" : "BLOCKED",
      secretStatus.available
        ? "DPAPI CurrentUser secret descriptors are available; values were not read"
        : "Windows DPAPI CurrentUser is unavailable",
    );
    for (const [label, key] of [
      ["Session secret", "sessionSecret"],
      ["PostgreSQL credential", "databaseUrl"],
      ["HTTPS PFX password", "httpsPfxPassword"],
      ["Production control token", "controlToken"],
    ]) {
      const configured = secretStatus.records[key]?.configured === true;
      add(
        checks,
        label,
        configured ? "PASS" : "SETUP REQUIRED",
        configured
          ? "configured in DPAPI vault (value redacted)"
          : `Configure-BEA must create ${key}`,
      );
    }
    const openAiConfigured = secretStatus.records.openAiApiKey?.configured === true;
    add(
      checks,
      "OpenAI",
      openAiConfigured ? "WARNING" : "SETUP REQUIRED",
      openAiConfigured
        ? "a protected key is present; authenticated persisted connection evidence is checked after sign-in"
        : "no connected provider; Owner can configure after sign-in",
      { nonBlocking: true },
    );
  } catch (error) {
    add(
      checks,
      "Protected secret store",
      existsSync(paths.secretFile) ? "BLOCKED" : "SETUP REQUIRED",
      existsSync(paths.secretFile)
        ? `secret descriptors are invalid (${error instanceof Error ? error.name : "UnknownError"})`
        : "Configure-BEA must create the DPAPI vault",
    );
  }

  if (config) {
    const profileValid =
      config.deploymentProfile === "local-live" &&
      config.authentication.provider === "local-owner" &&
      config.hostname.endsWith(".localhost");
    add(
      checks,
      "Local Live loopback contract",
      profileValid ? "PASS" : "BLOCKED",
      profileValid
        ? `${config.appBaseUrl}; externally reachable listeners are loopback-only`
        : "Local Owner authentication is permitted only with a .localhost Local Live profile",
    );

    try {
      if (!existsSync(paths.certificateMetadataFile)) {
        throw new Error("certificate metadata is absent");
      }
      const certificate = validateCertificateMetadata(
        JSON.parse(readFileSync(paths.certificateMetadataFile, "utf8")),
        { productRoot: paths.productRoot },
      );
      if (
        certificate.hostname !== config.hostname ||
        certificate.pfxPath !== config.https.pfxPath ||
        certificate.pfxPath !== paths.certificatePfxFile ||
        certificate.rootCertificatePath !== paths.certificateRootFile ||
        certificate.certificateThumbprint !== config.https.certificateThumbprint ||
        certificate.notAfter !== config.https.notAfter
      ) {
        throw new Error("certificate metadata does not match the production configuration");
      }
      if (secretStatus?.records.httpsPfxPassword?.configured !== true) {
        throw new Error("the protected HTTPS PFX password is absent");
      }
      const certificateSecrets = (options.readSecrets ?? readProductionSecrets)(
        ["httpsPfxPassword"],
        { filePath: paths.secretFile },
      );
      const inspection = await (options.inspectCertificateTrust ?? inspectCertificateTrust)(
        certificate,
        {
          productRoot: paths.productRoot,
          metadataValidated: true,
          pfxPassword: certificateSecrets.httpsPfxPassword,
        },
      );
      const status = inspection.contractValid
        ? inspection.renewalWarning
          ? "WARNING"
          : "PASS"
        : "SETUP REQUIRED";
      add(
        checks,
        "Trusted local HTTPS",
        status,
        inspection.contractValid
          ? `trusted certificate ${certificate.certificateThumbprint} expires ${inspection.notAfter}; ${String(inspection.daysUntilExpiration)} days remain${inspection.renewalWarning ? "; renewal is recommended" : ""}`
          : "certificate artifacts, private keys, exact SANs, thumbprints, validity, or CurrentUser trust do not satisfy the Local Live contract",
      );
    } catch (error) {
      add(
        checks,
        "Trusted local HTTPS",
        "SETUP REQUIRED",
        `certificate/trust is incomplete (${error instanceof Error ? error.message : "UnknownError"})`,
      );
    }

    const metadataResult = readRuntimeMetadata(paths.runtimeMetadataFile);
    let running = false;
    if (!metadataResult.exists) {
      add(checks, "Production supervisor", "PASS", "STOPPED; no owned runtime metadata is present");
    } else if (!metadataResult.metadata) {
      add(checks, "Production supervisor", "BLOCKED", metadataResult.issues.join(" "));
    } else if (!processIsAlive(metadataResult.metadata.supervisorPid)) {
      add(
        checks,
        "Production supervisor",
        "WARNING",
        `stale metadata for stopped PID ${String(metadataResult.metadata.supervisorPid)}; Stop-BEA may remove it after validation`,
      );
    } else {
      running = true;
      let authenticated = false;
      if (secretStatus?.records.controlToken?.configured) {
        try {
          const secrets = (options.readSecrets ?? readProductionSecrets)(["controlToken"], {
            filePath: paths.secretFile,
          });
          const status = await controlRequest(
            metadataResult.metadata,
            secrets.controlToken,
            "/status",
          );
          authenticated =
            status.ok &&
            status.body?.supervisorPid === metadataResult.metadata.supervisorPid &&
            status.body?.profile === "local-live";
        } catch {
          authenticated = false;
        }
      }
      add(
        checks,
        "Production supervisor",
        authenticated ? "PASS" : "BLOCKED",
        authenticated
          ? `owned supervisor PID ${String(metadataResult.metadata.supervisorPid)} is authenticated`
          : "a process is tracked but its authenticated identity could not be verified; no process was touched",
      );
    }

    if (!running) {
      for (const [name, port] of Object.entries(config.ports)) {
        const result = await (options.checkPort ?? checkPortAvailable)(port);
        add(
          checks,
          `Port ${name}`,
          result.available ? "PASS" : "BLOCKED",
          result.available
            ? `${String(port)} is available on loopback`
            : `${String(port)} is occupied (${result.code})`,
        );
      }
    } else {
      add(
        checks,
        "Port ownership",
        "PASS",
        "authenticated supervisor metadata owns the configured ports",
      );
    }

    const manifest = validateBuildManifest(config, { path: paths.buildManifestFile, run: runner });
    add(
      checks,
      "Build freshness",
      manifest.ok ? "PASS" : "SETUP REQUIRED",
      manifest.ok ? `build matches Git ${manifest.manifest.gitCommit}` : manifest.reason,
    );

    for (const [label, path, directory, allowInherited] of [
      ["Product root ACL", paths.productRoot, true, false],
      ["Config directory ACL", paths.configDirectory, true, false],
      ["Config ACL", paths.configFile, false, true],
      ["Secret directory ACL", paths.secretDirectory, true, false],
      ["Secret ACL", paths.secretFile, false, false],
      ["Certificate directory ACL", paths.certificateDirectory, true, false],
      ["Certificate PFX ACL", paths.certificatePfxFile, false, false],
      ["Runtime ACL", paths.runtimeDirectory, true, true],
      ["Production log ACL", config.paths.logDirectory, true, true],
      ["Production backup ACL", config.paths.backupDirectory, true, false],
    ]) {
      if (!existsSync(path)) {
        add(checks, label, "SETUP REQUIRED", `${path} does not exist`);
        continue;
      }
      try {
        const inspected = (options.inspectAcl ?? inspectAcl)(path, {
          allowedRoot: paths.productRoot,
          directory,
          allowInherited,
        });
        const restricted = inspected.exactRestricted === true;
        add(
          checks,
          label,
          restricted ? "PASS" : "BLOCKED",
          restricted
            ? inspected.exactInherited
              ? "the exact current-user and SYSTEM-only ACL is inherited from a protected BEA parent"
              : "the exact current-user and SYSTEM-only protected ACL is present"
            : "the ACL is not the required current-user and SYSTEM-only contract",
        );
      } catch (error) {
        add(
          checks,
          label,
          "BLOCKED",
          `ACL could not be verified (${error instanceof Error ? error.name : "UnknownError"})`,
        );
      }
    }

    try {
      accessSync(config.paths.logDirectory, constants.W_OK);
      add(checks, "Production logs", "PASS", `${config.paths.logDirectory} is writable`);
    } catch {
      add(
        checks,
        "Production logs",
        "SETUP REQUIRED",
        "Configure-BEA must create and protect the log directory",
      );
    }

    if (options.deep) {
      try {
        const secrets = (options.readSecrets ?? readProductionSecrets)(["databaseUrl"], {
          filePath: paths.secretFile,
        });
        const database = await (options.inspectPostgres ?? inspectPostgres)(
          config,
          secrets,
          options,
        );
        add(
          checks,
          "PostgreSQL deep readiness",
          "PASS",
          `PostgreSQL ${String(database.serverMajor)} database ${database.databaseName}; least-privileged role ${database.roleName}; TLS ${database.tlsActive ? "active" : "loopback preference"}; migration ${database.migrationVersion}`,
        );
        add(
          checks,
          "Local Owner deep readiness",
          database.ownerReady ? "PASS" : "BLOCKED",
          database.ownerReady
            ? `exactly one Local Owner identity is ready; ${String(database.activeSessionCount)} active sessions`
            : "the authoritative database does not contain the exact single Local Owner identity contract",
        );
        add(
          checks,
          "pg-boss deep readiness",
          database.pgBossReady ? "PASS" : "BLOCKED",
          database.pgBossReady
            ? "pg-boss schema, production health queue, and activation evidence are present"
            : "pg-boss schema, health queue, or activation evidence is incomplete",
        );
        const vaultFingerprint = secretStatus?.records.openAiApiKey?.fingerprint;
        const expectedCredentialFingerprint =
          typeof vaultFingerprint === "string" && /^sha256:[a-f0-9]{64}$/u.test(vaultFingerprint)
            ? `sha256:${vaultFingerprint.slice("sha256:".length, "sha256:".length + 12)}`
            : null;
        const openAiConnected =
          database.openAiConnection?.connected === true &&
          expectedCredentialFingerprint !== null &&
          database.openAiConnection.credentialFingerprint === expectedCredentialFingerprint;
        add(
          checks,
          "OpenAI persisted connection",
          openAiConnected ? "PASS" : "SETUP REQUIRED",
          openAiConnected
            ? "authenticated connection evidence matches the protected credential fingerprint"
            : "no matching authenticated provider activation; Owner can configure after sign-in",
          { nonBlocking: true },
        );
      } catch (error) {
        add(
          checks,
          "PostgreSQL deep readiness",
          "BLOCKED",
          `connection, role, or migration validation failed (${error instanceof Error ? error.name : "UnknownError"})`,
        );
        add(checks, "pg-boss deep readiness", "NOT RUN", "PostgreSQL readiness did not pass");
        add(checks, "Local Owner deep readiness", "NOT RUN", "PostgreSQL readiness did not pass");
      }
    } else {
      add(
        checks,
        "PostgreSQL deep readiness",
        "NOT RUN",
        "use --deep to test connectivity without provider calls",
      );
      add(checks, "pg-boss deep readiness", "NOT RUN", "use --deep after PostgreSQL configuration");
      add(
        checks,
        "Local Owner deep readiness",
        "NOT RUN",
        "use --deep after PostgreSQL configuration",
      );
    }
  } else {
    add(
      checks,
      "HTTPS/profile/ports/database/runtime",
      "NOT RUN",
      "production config is not ready",
    );
  }

  if (options.testOpenAi) {
    if (options.confirmOpenAi !== true) {
      add(
        checks,
        "OpenAI provider test",
        "BLOCKED",
        "explicit paid-call confirmation was not supplied",
      );
    } else {
      try {
        const secrets = (options.readSecrets ?? readProductionSecrets)(["openAiApiKey"], {
          filePath: paths.secretFile,
        });
        const response = await (options.fetch ?? fetch)("https://api.openai.com/v1/models", {
          headers: { authorization: `Bearer ${secrets.openAiApiKey}` },
          signal: AbortSignal.timeout(15_000),
        });
        add(
          checks,
          "OpenAI provider test",
          response.ok ? "PASS" : "BLOCKED",
          response.ok
            ? "authenticated Models API test succeeded"
            : `authenticated test returned HTTP ${String(response.status)}`,
        );
      } catch (error) {
        add(
          checks,
          "OpenAI provider test",
          "BLOCKED",
          `authenticated test failed (${error instanceof Error ? error.name : "UnknownError"})`,
        );
      }
    }
  } else {
    add(checks, "OpenAI provider test", "NOT RUN", "no paid/provider request was made");
  }
  add(
    checks,
    "Owner acceptance",
    "NOT RUN",
    "Aaron's live text, web, voice, backup, stop, and restart walkthrough remains owner-run",
  );

  return {
    checks,
    blockers: checks.filter((check) => check.blocker),
    startBlockers: checks.filter((check) => check.startBlocker),
    setupRequired: checks.filter((check) => check.status === "SETUP REQUIRED"),
    warnings: checks.filter((check) => check.status === "WARNING"),
  };
}

export function printProductionDoctorReport(report) {
  process.stdout.write("BEA Operations Command Center - Phase 1.3.4 Production Doctor\n");
  process.stdout.write("Read-only by default; secret values are never printed.\n\n");
  for (const check of report.checks) {
    process.stdout.write(`[${check.status}] ${check.name}: ${check.detail}\n`);
  }
  const result =
    report.blockers.length > 0
      ? "BLOCKED"
      : report.startBlockers.length > 0 || report.setupRequired.length > 0
        ? "SETUP_REQUIRED"
        : "PASS";
  process.stdout.write(`\nBEA_PRODUCTION_DOCTOR=${result}\n`);
  return result;
}

function parseArguments(arguments_) {
  const options = { deep: false, testOpenAi: false };
  for (const argument of arguments_) {
    if (argument === "--check") continue;
    if (argument === "--deep") options.deep = true;
    else if (argument === "--test-openai") options.testOpenAi = true;
    else throw new Error("Usage: production-doctor.mjs [--check|--deep|--test-openai]");
  }
  if (options.testOpenAi) options.deep = true;
  return options;
}

async function confirmOpenAiTest() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      "This authenticated OpenAI test may incur API usage. Type TEST OPENAI to continue: ",
    );
    return answer.trim() === "TEST OPENAI";
  } finally {
    terminal.close();
  }
}

if (process.argv[1]?.toLowerCase().endsWith("production-doctor.mjs")) {
  Promise.resolve()
    .then(async () => {
      const options = parseArguments(process.argv.slice(2));
      const confirmOpenAi = options.testOpenAi ? await confirmOpenAiTest() : false;
      const report = await collectProductionDoctorReport({ ...options, confirmOpenAi });
      const result = printProductionDoctorReport(report);
      process.exitCode = result === "PASS" || result === "SETUP_REQUIRED" ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(
        `BEA_PRODUCTION_DOCTOR=BLOCKED (${error instanceof Error ? error.name : "UnknownError"})\n`,
      );
      process.exitCode = 1;
    });
}
