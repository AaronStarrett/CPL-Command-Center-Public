// Phase 1.3.4 exact cumulative change-set manifest. The verifier reconciles
// this list against the staged tree relative to the immutable pre-Phase 1.3.4
// base, so later focused correction commits retain the original phase paths
// without requiring those already-committed files to be restaged. Machine
// config, secrets, certificates, databases, logs, backups, toolchains, browser
// reports, and generated artifacts are never admitted.

export const PHASE1_3_4_BASE_COMMIT = "c99b9e6b9b72e14365b722aa9022a431ebabb827";

export const PHASE1_3_4_INTENDED_FILES = Object.freeze([
  ".gitignore",
  "Backup-BEA.cmd",
  "BEA-Doctor.cmd",
  "Configure-BEA.cmd",
  "Ensure-BEA-Toolchain.cmd",
  "README.md",
  "Restore-BEA.cmd",
  "Start-BEA-Demo.cmd",
  "Start-BEA-Preview.cmd",
  "Start-BEA.cmd",
  "Stop-BEA-Demo.cmd",
  "Stop-BEA-Preview.cmd",
  "Stop-BEA.cmd",
  "apps/web/app/(authenticated)/access-denied/page.tsx",
  "apps/web/app/(authenticated)/account/page.tsx",
  "apps/web/app/(authenticated)/administration/page.tsx",
  "apps/web/app/(authenticated)/integrations/page.tsx",
  "apps/web/app/(authenticated)/layout.tsx",
  "apps/web/app/(authenticated)/notifications/page.tsx",
  "apps/web/app/(authenticated)/page.tsx",
  "apps/web/app/(authenticated)/tasks/new/page.tsx",
  "apps/web/app/(authenticated)/tasks/page.tsx",
  "apps/web/app/api/auth/recover/route.ts",
  "apps/web/app/api/auth/sign-in/route.ts",
  "apps/web/app/api/auth/sign-out/route.ts",
  "apps/web/app/api/auth/switch-persona/route.ts",
  "apps/web/app/api/route-helpers.ts",
  "apps/web/app/recover/page.tsx",
  "apps/web/app/sign-in/page.tsx",
  "apps/web/components/ai-command-motion-workspace.tsx",
  "apps/web/components/foundation-check.tsx",
  "apps/web/components/operating-mode-banner.tsx",
  "apps/web/components/openai-administration-panel.tsx",
  "apps/web/components/profile-menu.tsx",
  "apps/web/components/workspace-renderer.tsx",
  "apps/web/lib/auth/session-store.ts",
  "apps/web/lib/local-owner-recovery.ts",
  "apps/web/lib/production-presentation.ts",
  "apps/web/next.config.ts",
  "apps/web/tsconfig.json",
  "apps/worker/src/production-queue-check.ts",
  "docs/ACTIVATION_CHECKLIST.md",
  "docs/AI_AND_MEMORY.md",
  "docs/ASSUMPTIONS_AND_GAPS.md",
  "docs/CHANGELOG.md",
  "docs/DECISIONS.md",
  "docs/DEMO_GUIDE.md",
  "docs/DEPLOYMENT.md",
  "docs/FILE_INVENTORY.md",
  "docs/INTEGRATIONS.md",
  "docs/LOCAL_LIVE_PRODUCTION.md",
  "docs/OPERATIONS_RUNBOOK.md",
  "docs/PHASE_1_3_4_VERIFICATION.md",
  "docs/PROJECT_CONTEXT.md",
  "docs/REQUIREMENTS_TRACEABILITY.md",
  "docs/SECURITY.md",
  "docs/SYSTEM_ARCHITECTURE.md",
  "docs/TEST_PLAN.md",
  "eslint.config.mjs",
  "package.json",
  "packages/artifacts/src/store.ts",
  "packages/config/src/environment.ts",
  "packages/config/src/repository-environment.ts",
  "packages/config/src/secrets.ts",
  "packages/database/migrations/0010_phase1_3_4_local_owner.sql",
  "packages/database/package.json",
  "packages/database/src/cli/database-command.ts",
  "packages/database/src/index.ts",
  "packages/database/src/local-owner-repository.ts",
  "packages/database/src/migrations.ts",
  "packages/database/src/production-verification.ts",
  "packages/database/src/repository.ts",
  "packages/database/src/schema.ts",
  "packages/database/src/server-runtime.ts",
  "packages/database/src/system-seed.ts",
  "packages/security/src/authentication.ts",
  "packages/security/src/index.ts",
  "packages/security/src/local-owner-authentication.ts",
  "playwright.phase134-production.config.ts",
  "scripts/phase1-3-4-intended-files.mjs",
  "scripts/phase134/build-manifest.mjs",
  "scripts/phase134/configure-production.mjs",
  "scripts/phase134/database-backup.mjs",
  "scripts/phase134/database-restore.mjs",
  "scripts/phase134/dpapi-current-user-readiness.ps1",
  "scripts/phase134/ensure-toolchain.ps1",
  "scripts/phase134/https-gateway.mjs",
  "scripts/phase134/postgres-tools.mjs",
  "scripts/phase134/production-activation.mjs",
  "scripts/phase134/production-certificate.mjs",
  "scripts/phase134/production-config.mjs",
  "scripts/phase134/production-doctor.mjs",
  "scripts/phase134/production-paths.mjs",
  "scripts/phase134/production-profile.mjs",
  "scripts/phase134/production-secrets.mjs",
  "scripts/phase134/production-setup-session.mjs",
  "scripts/phase134/production-start.mjs",
  "scripts/phase134/production-stop.mjs",
  "scripts/phase134/production-supervisor.mjs",
  "scripts/phase134/repair-production-acl.ps1",
  "scripts/phase134/runtime-control.mjs",
  "scripts/phase134/toolchain-bootstrap.mjs",
  "scripts/phase134/windows-acl.mjs",
  "scripts/preview-common.mjs",
  "scripts/preview-network-guard.cjs",
  "scripts/preview-start.mjs",
  "scripts/preview-stop.mjs",
  "scripts/preview-supervisor.mjs",
  "scripts/verify-phase1-3-4-real-postgres.mjs",
  "scripts/verify-phase1-3-4.mjs",
  "tests/component/phase132-seamless-tiles.test.tsx",
  "tests/component/phase133-long-workspace-renderer.test.tsx",
  "tests/component/phase134-local-owner-recovery-page.test.tsx",
  "tests/component/phase134-openai-setup-reachability.test.tsx",
  "tests/component/phase134-production-empty-state.test.tsx",
  "tests/e2e/phase134-production-bootstrap.spec.ts",
  "tests/integration/database-pglite.test.ts",
  "tests/integration/phase134-local-owner-authentication.test.ts",
  "tests/integration/phase134-local-owner-recovery-route.test.ts",
  "tests/integration/phase134-production-queue-contract.test.ts",
  "tests/integration/phase134-real-postgres.test.ts",
  "tests/integration/phase134-system-seed.test.ts",
  "tests/unit/database-service.test.ts",
  "tests/unit/environment.test.ts",
  "tests/unit/phase134-backup-restore.test.mjs",
  "tests/unit/phase134-bootstrap-config.test.mjs",
  "tests/unit/phase134-bootstrap-configure-wrappers.test.mjs",
  "tests/unit/phase134-bootstrap-secrets-acl.test.mjs",
  "tests/unit/phase134-bootstrap-toolchain-certificate-manifest.test.mjs",
  "tests/unit/phase134-https-gateway.test.mjs",
  "tests/unit/phase134-local-owner-environment.test.ts",
  "tests/unit/phase134-production-activation.test.mjs",
  "tests/unit/phase134-production-doctor.test.mjs",
  "tests/unit/phase134-production-openai-vault.test.ts",
  "tests/unit/phase134-production-setup-session.test.mjs",
  "tests/unit/phase134-production-supervisor.test.mjs",
  "tests/unit/phase134-protected-secret-readiness.test.mjs",
  "tests/unit/phase134-preview-runtime.test.mjs",
  "tests/unit/phase134-real-postgres-gate.test.mjs",
  "tests/unit/phase134-runtime-control.test.mjs",
  "tests/unit/phase134-start-stop.test.mjs",
  "tests/unit/phase134-verifier.test.mjs",
]);

const forbiddenPathPatterns = Object.freeze([
  /(?:^|\/)\.data(?:\/|$)/u,
  /(?:^|\/)\.env(?!\.example$)(?:\.|$)/u,
  /(?:^|\/)\.next(?:-preview)?(?:\/|$)/u,
  /(?:^|\/)dist(?:\/|$)/u,
  /(?:^|\/)node_modules(?:\/|$)/u,
  /(?:^|\/)playwright-report(?:\/|$)/u,
  /(?:^|\/)test-results(?:\/|$)/u,
  /(?:^|\/)(?:backups|certificates|logs|runtime|toolchain)(?:\/|$)/u,
  /\.(?:cer|db|dump|key|log|pfx|sqlite|sqlite3|wav|zip)$/iu,
]);

export function normalizePhase1_3_4Path(value) {
  return String(value).trim().replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function findForbiddenPhase1_3_4Paths(paths) {
  return paths
    .map(normalizePhase1_3_4Path)
    .filter((entry) => forbiddenPathPatterns.some((pattern) => pattern.test(entry)));
}

export function reconcilePhase1_3_4StagedPaths(paths) {
  const normalized = paths.map(normalizePhase1_3_4Path).filter(Boolean);
  const duplicates = normalized.filter((entry, index) => normalized.indexOf(entry) !== index);
  const actual = new Set(normalized);
  const expected = new Set(PHASE1_3_4_INTENDED_FILES);
  return {
    duplicates: [...new Set(duplicates)].sort(),
    forbidden: findForbiddenPhase1_3_4Paths(normalized).sort(),
    missing: PHASE1_3_4_INTENDED_FILES.filter((entry) => !actual.has(entry)),
    unexpected: [...actual].filter((entry) => !expected.has(entry)).sort(),
  };
}

export function assertExactPhase1_3_4StagedPaths(paths) {
  const reconciliation = reconcilePhase1_3_4StagedPaths(paths);
  const problems = Object.entries(reconciliation).filter(([, entries]) => entries.length > 0);
  if (problems.length > 0) {
    throw new Error(
      `Phase 1.3.4 cumulative manifest mismatch: ${problems
        .map(([name, entries]) => `${name}=${entries.join(",")}`)
        .join("; ")}`,
    );
  }
  return reconciliation;
}
