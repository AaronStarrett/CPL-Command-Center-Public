// Phase 1.3.3 exact staged-path manifest. The root integrator must reconcile this
// list against the final, intentionally staged change set before aggregate verification.

export const PHASE1_3_3_INTENDED_FILES = Object.freeze([
  ".env.example",
  "BEA-Doctor.cmd",
  "Start-BEA.cmd",
  "Stop-BEA.cmd",
  "README.md",
  "apps/web/app/(authenticated)/integrations/[id]/page.tsx",
  "apps/web/app/(authenticated)/layout.tsx",
  "apps/web/app/api/ai-command/messages/route.ts",
  "apps/web/app/api/ai-command/stream/route.ts",
  "apps/web/app/api/ai-command/realtime/client-secret/route.ts",
  "apps/web/app/api/ai-command/realtime/events/route.ts",
  "apps/web/app/api/ai-command/realtime/preferences/route.ts",
  "apps/web/app/api/ai-command/realtime/tools/execute/route.ts",
  "apps/web/app/api/integrations/[id]/simulate/route.ts",
  "apps/web/app/api/integrations/ai/routes/test/route.ts",
  "apps/web/app/api/integrations/ai/settings/route.ts",
  "apps/web/app/globals.css",
  "apps/web/app/layout.tsx",
  "apps/web/app/sign-in/page.tsx",
  "apps/web/components/ai-command-motion-workspace.tsx",
  "apps/web/components/ai-command.module.css",
  "apps/web/components/application-pdf-viewer.tsx",
  "apps/web/components/openai-administration-panel.tsx",
  "apps/web/components/openai-administration.module.css",
  "apps/web/components/operating-mode-banner.tsx",
  "apps/web/components/workspace-renderer.tsx",
  "apps/web/lib/ai-command-client.ts",
  "apps/web/lib/ai-command-contracts.ts",
  "apps/web/lib/ai-command-stream.ts",
  "apps/web/lib/ai-command.ts",
  "apps/web/lib/browser-realtime-voice.ts",
  "apps/web/lib/demo-artifact-runner.ts",
  "apps/web/lib/openai-administration-client.ts",
  "apps/web/lib/openai-administration.ts",
  "apps/web/lib/phase133-production-presentation-test.ts",
  "apps/worker/src/runtime.ts",
  "docs/ACTIVATION_CHECKLIST.md",
  "docs/AGENT_WORKFORCE_VISION.md",
  "docs/AI_AND_MEMORY.md",
  "docs/ASSUMPTIONS_AND_GAPS.md",
  "docs/CHANGELOG.md",
  "docs/DECISIONS.md",
  "docs/DEMO_GUIDE.md",
  "docs/DEPLOYMENT.md",
  "docs/FILE_INVENTORY.md",
  "docs/INTEGRATIONS.md",
  "docs/OPERATIONS_RUNBOOK.md",
  "docs/PHASE_1_3_3_VERIFICATION.md",
  "docs/PROJECT_CONTEXT.md",
  "docs/REQUIREMENTS_TRACEABILITY.md",
  "docs/SECURITY.md",
  "docs/SYSTEM_ARCHITECTURE.md",
  "docs/TEST_PLAN.md",
  "docs/UX_ARCHITECTURE.md",
  "package.json",
  "packages/ai/src/capabilities.ts",
  "packages/ai/src/contracts.ts",
  "packages/ai/src/demo-streaming-provider.ts",
  "packages/ai/src/executive-context.ts",
  "packages/ai/src/index.ts",
  "packages/ai/src/openai/client.ts",
  "packages/ai/src/openai/models.ts",
  "packages/ai/src/openai/responses.ts",
  "packages/ai/src/openai/voices.ts",
  "packages/ai/src/openai/web-search.ts",
  "packages/ai/src/routing.ts",
  "packages/ai/src/unavailable-provider.ts",
  "packages/config/src/environment.ts",
  "packages/database/migrations/0007_phase1_3_3_production_ai_routing.sql",
  "packages/database/migrations/0008_phase1_3_3_connection_fingerprint.sql",
  "packages/database/migrations/0009_phase1_3_3_realtime_route_provenance.sql",
  "packages/database/src/ai-provider-repository.ts",
  "packages/database/src/migrations.ts",
  "packages/database/src/schema.ts",
  "packages/database/src/server-runtime.ts",
  "packages/domain/src/ai-provider.ts",
  "packages/domain/src/ai-routing.ts",
  "packages/domain/src/executive-profile.ts",
  "packages/domain/src/index.ts",
  "packages/integrations/src/defaults.ts",
  "packages/integrations/src/index.ts",
  "packages/integrations/src/registry.ts",
  "packages/integrations/src/unavailable-provider.ts",
  "playwright.phase133-presentation.config.ts",
  "playwright.shared.ts",
  "scripts/phase1-3-3-intended-files.mjs",
  "scripts/phase133/production-owner-tools.mjs",
  "scripts/phase133/production-preflight.mjs",
  "scripts/phase133/production-start.mjs",
  "scripts/phase133/production-stop.mjs",
  "scripts/verify-phase1-3-3.mjs",
  "tests/component/ai-command-workspace.test.tsx",
  "tests/component/openai-administration.test.tsx",
  "tests/component/openai-route-transport.test.ts",
  "tests/component/phase133-long-workspace-renderer.test.tsx",
  "tests/component/phase133-openai-admin-ui.test.tsx",
  "tests/component/phase133-pdf-scroll-position.test.tsx",
  "tests/component/phase133-production-isolation-ui.test.ts",
  "tests/component/phase133-production-presentation-server-boundary.test.ts",
  "tests/component/phase133-realtime-preference-route.test.ts",
  "tests/component/phase133-route-test-api.test.ts",
  "tests/component/phase133-scroll-ownership.test.tsx",
  "tests/component/realtime-route-transport.test.ts",
  "tests/e2e/command-center.spec.ts",
  "tests/e2e/phase133-production-presentation.spec.ts",
  "tests/integration/database-pglite.test.ts",
  "tests/integration/phase131-policy-provenance.test.ts",
  "tests/integration/realtime-session-persistence.test.ts",
  "tests/unit/browser-realtime-voice.test.ts",
  "tests/unit/environment.test.ts",
  "tests/unit/live-realtime-voice.test.ts",
  "tests/unit/openai-administration-backend.test.ts",
  "tests/unit/phase131-persona-brand.test.ts",
  "tests/unit/phase133-openai-routing.test.ts",
  "tests/unit/phase133-production-owner-tools.test.mjs",
  "tests/unit/phase133-production-presentation-test-mode.test.ts",
  "tests/unit/phase133-production-provider-isolation.test.ts",
  "tests/unit/phase133-verifier.test.mjs",
]);

const forbiddenPathPatterns = Object.freeze([
  /(?:^|\/)\.data(?:\/|$)/u,
  /(?:^|\/)\.env(?!\.example$)(?:\.|$)/u,
  /(?:^|\/)\.next(?:\/|$)/u,
  /(?:^|\/)dist(?:\/|$)/u,
  /(?:^|\/)node_modules(?:\/|$)/u,
  /(?:^|\/)playwright-report(?:\/|$)/u,
  /(?:^|\/)test-results(?:\/|$)/u,
  /\.(?:db|log|sqlite|sqlite3|wav)$/iu,
]);

export function normalizePhase1_3_3Path(value) {
  return String(value).trim().replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function findForbiddenPhase1_3_3Paths(paths) {
  return paths
    .map(normalizePhase1_3_3Path)
    .filter((entry) => forbiddenPathPatterns.some((pattern) => pattern.test(entry)));
}

export function reconcilePhase1_3_3StagedPaths(paths) {
  const normalized = paths.map(normalizePhase1_3_3Path).filter(Boolean);
  const duplicates = normalized.filter((entry, index) => normalized.indexOf(entry) !== index);
  const actual = new Set(normalized);
  const expected = new Set(PHASE1_3_3_INTENDED_FILES);
  return {
    duplicates: [...new Set(duplicates)].sort(),
    forbidden: findForbiddenPhase1_3_3Paths(normalized).sort(),
    missing: PHASE1_3_3_INTENDED_FILES.filter((entry) => !actual.has(entry)),
    unexpected: [...actual].filter((entry) => !expected.has(entry)).sort(),
  };
}

export function assertExactPhase1_3_3StagedPaths(paths) {
  const reconciliation = reconcilePhase1_3_3StagedPaths(paths);
  const problems = Object.entries(reconciliation).filter(([, entries]) => entries.length > 0);
  if (problems.length > 0) {
    throw new Error(
      `Phase 1.3.3 staged manifest mismatch: ${problems
        .map(([name, entries]) => `${name}=${entries.join(",")}`)
        .join("; ")}`,
    );
  }
  return reconciliation;
}
