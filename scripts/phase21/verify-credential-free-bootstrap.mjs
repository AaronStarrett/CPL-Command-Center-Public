import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXPECTED_LAST_MIGRATION = "0025_cpl_tenant_foundation.sql";

export function verifyMigrationLedgerFiles() {
  if (process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY must remain empty for credential-free bootstrap.");
  }
  const directory = path.join(repositoryRoot, "packages", "database", "migrations");
  const files = readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  const last = files.at(-1);
  if (last !== EXPECTED_LAST_MIGRATION) {
    throw new Error(`Expected last migration ${EXPECTED_LAST_MIGRATION}; received ${last}`);
  }
  if (!files.includes("0001_phase0_foundation.sql") || files.length !== 25) {
    throw new Error("Migration ledger through 0025 is incomplete.");
  }
  return { ok: true, lastMigration: last, count: files.length, openaiKey: "" };
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    const result = verifyMigrationLedgerFiles();
    process.stdout.write(`${JSON.stringify({ code: "BEA_OWNER_BOOTSTRAP=PASS", ...result })}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ code: "BEA_OWNER_BOOTSTRAP=FAIL", ok: false, message: error instanceof Error ? error.message : "error" })}\n`,
    );
    process.exitCode = 1;
  }
}
