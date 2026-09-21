import {
  findProhibitedRepositoryPaths,
  normalizeRepositoryPath,
} from "./repository-data-policy.mjs";

export const PHASE1_3_5_STARTING_COMMIT = "5273656d61968a4e2918d63a839f535f4a64dd34";

export const PHASE1_3_5_GOVERNANCE_FILES = Object.freeze([
  ".dockerignore",
  ".github/CODEOWNERS",
  ".github/ISSUE_TEMPLATE/architecture_change.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-manual.yml",
  ".gitignore",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/BRANCH_AND_RELEASE_WORKFLOW.md",
  "docs/GITHUB_REMOTE_WORKFLOW.md",
  "scripts/history-secret-scan.mjs",
  "scripts/repository-data-policy.mjs",
  "scripts/repository-health.mjs",
  "scripts/secret-scan.mjs",
  "tests/unit/phase135-history-security.test.mjs",
]);

export const PHASE1_3_5_ARCHITECTURE_FILES = Object.freeze([
  "README.md",
  "docs/ACTIVATION_CHECKLIST.md",
  "docs/AI_AND_MEMORY.md",
  "docs/ASSUMPTIONS_AND_GAPS.md",
  "docs/CHANGELOG.md",
  "docs/CLOUDFLARE_R2_STORAGE.md",
  "docs/DATA_MODEL.md",
  "docs/DECISIONS.md",
  "docs/DEPLOYMENT.md",
  "docs/DIGITAL_WORKFORCE_ARCHITECTURE.md",
  "docs/GOOGLE_DRIVE_KNOWLEDGE_CONNECTOR.md",
  "docs/HOSTING_PROVIDER_COMPARISON.md",
  "docs/INTEGRATIONS.md",
  "docs/LOCAL_BRIDGE_AGENT.md",
  "docs/LOCAL_TO_CLOUD_MIGRATION.md",
  "docs/LOW_COST_CLOUD_ARCHITECTURE.md",
  "docs/MULTI_TENANCY.md",
  "docs/ONEDRIVE_KNOWLEDGE_CONNECTOR.md",
  "docs/PROJECT_CONTEXT.md",
  "docs/REQUIREMENTS_TRACEABILITY.md",
  "docs/SECURITY.md",
  "docs/STORAGE_AND_MEMORY.md",
  "docs/SUPABASE_ARCHITECTURE.md",
  "docs/SYSTEM_ARCHITECTURE.md",
  "infra/README.md",
  "infra/deployment/README.md",
  "infra/deployment/environment.schema.json",
  "infra/deployment/health-contract.json",
  "infra/deployment/manifest.example.json",
  "infra/docker/Dockerfile.web",
  "infra/docker/Dockerfile.worker",
  "infra/r2/README.md",
  "infra/r2/cors.example.json",
  "infra/r2/r2.example.json",
  "infra/supabase/README.md",
  "infra/supabase/config.example.toml",
  "infra/supabase/migrations/0001_pgvector_tenancy_template.sql.example",
  "packages/bridge-agent/package.json",
  "packages/bridge-agent/src/contracts.ts",
  "packages/bridge-agent/src/index.ts",
  "packages/bridge-agent/tsconfig.json",
  "packages/domain/src/digital-workforce.ts",
  "packages/domain/src/index.ts",
  "packages/domain/src/tenancy.ts",
  "packages/integrations/package.json",
  "packages/integrations/src/connector-execution.ts",
  "packages/integrations/src/index.ts",
  "packages/platform/package.json",
  "packages/platform/src/contracts.ts",
  "packages/platform/src/index.ts",
  "packages/platform/src/provider-catalog.ts",
  "packages/platform/tsconfig.json",
  "pnpm-lock.yaml",
  "scripts/validate-deployment-scaffolding.mjs",
  "tests/unit/phase135-architecture-contracts.test.ts",
  "tests/unit/phase135-deployment-scaffolding.test.mjs",
]);

export const PHASE1_3_5_CLEANUP_FILES = Object.freeze([
  "Cleanup-BEA-Local.cmd",
  "docs/CURRENT_DATA_LOCATION_REPORT.md",
  "docs/FILE_INVENTORY.md",
  "docs/PHASE_1_3_5_VERIFICATION.md",
  "docs/TEST_PLAN.md",
  "package.json",
  "scripts/local-storage-audit.mjs",
  "scripts/phase1-3-5-intended-files.mjs",
  "scripts/phase134/ensure-toolchain.ps1",
  "scripts/phase135/local-storage-policy.mjs",
  "scripts/verify-phase1-3-5.mjs",
  "tests/unit/phase135-local-storage-audit.test.mjs",
  "tests/unit/phase135-verifier.test.mjs",
]);

export const PHASE1_3_5_INTENDED_FILES = Object.freeze([
  ...PHASE1_3_5_GOVERNANCE_FILES,
  ...PHASE1_3_5_ARCHITECTURE_FILES,
  ...PHASE1_3_5_CLEANUP_FILES,
]);

export function reconcilePhase1_3_5Paths(paths) {
  const normalized = paths
    .map(normalizeRepositoryPath)
    .filter((entry) => entry && entry !== "apps/web/next-env.d.ts");
  const duplicates = normalized.filter((entry, index) => normalized.indexOf(entry) !== index);
  const actual = new Set(normalized);
  const expected = new Set(PHASE1_3_5_INTENDED_FILES);
  return {
    duplicates: [...new Set(duplicates)].sort(),
    forbidden: findProhibitedRepositoryPaths(normalized),
    missing: PHASE1_3_5_INTENDED_FILES.filter((entry) => !actual.has(entry)),
    unexpected: [...actual].filter((entry) => !expected.has(entry)).sort(),
  };
}

export function assertExactPhase1_3_5Paths(paths) {
  const result = reconcilePhase1_3_5Paths(paths);
  const problems = Object.entries(result).filter(([, entries]) => entries.length > 0);
  if (problems.length > 0) {
    throw new Error(
      "Phase 1.3.5 intended-path mismatch: " +
        problems.map(([key, entries]) => key + "=" + entries.join(",")).join("; "),
    );
  }
  return result;
}
