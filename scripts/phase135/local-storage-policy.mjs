import path from "node:path";

export const EXPECTED_REPOSITORY = "C:\\CPL-Dev\\BEA-Automation-Command-Center";
export const EXPECTED_GITHUB_REPOSITORY = "AaronStarrett/BEA-Automation-Command-Center";

const packageNames = [
  "ai",
  "artifacts",
  "automation",
  "bridge-agent",
  "config",
  "database",
  "domain",
  "integrations",
  "observability",
  "platform",
  "security",
  "testing",
  "ui",
];

export const REPOSITORY_CLEANUP_TARGETS = Object.freeze([
  { id: "repo-root-turbo", relativePath: ".turbo", classification: "CACHE" },
  { id: "web-next", relativePath: "apps/web/.next", classification: "REGENERABLE" },
  {
    id: "web-next-preview",
    relativePath: "apps/web/.next-preview",
    classification: "REGENERABLE",
  },
  { id: "web-turbo", relativePath: "apps/web/.turbo", classification: "CACHE" },
  { id: "worker-turbo", relativePath: "apps/worker/.turbo", classification: "CACHE" },
  { id: "worker-dist", relativePath: "apps/worker/dist", classification: "REGENERABLE" },
  {
    id: "web-next-env",
    relativePath: "apps/web/next-env.d.ts",
    classification: "REGENERABLE",
  },
  { id: "coverage", relativePath: "coverage", classification: "REGENERABLE" },
  {
    id: "playwright-report",
    relativePath: "playwright-report",
    classification: "REGENERABLE",
  },
  { id: "test-results", relativePath: "test-results", classification: "REGENERABLE" },
  { id: "reports", relativePath: "reports", classification: "REGENERABLE" },
  ...packageNames.flatMap((name) => [
    {
      id: "package-" + name + "-dist",
      relativePath: "packages/" + name + "/dist",
      classification: "REGENERABLE",
    },
    {
      id: "package-" + name + "-turbo",
      relativePath: "packages/" + name + "/.turbo",
      classification: "CACHE",
    },
  ]),
  ...[
    "phase0-verification",
    "phase1-verification",
    "phase1-1-verification",
    "phase1-2-verification",
    "phase1-3-1-verification",
    "phase1-3-1-browser",
    "phase1-3-1-browser-clean",
    "phase1-3-2-evidence",
    "artifact-qa",
  ].map((name) => ({
    id: "data-" + name,
    relativePath: ".data/" + name,
    classification: "REGENERABLE",
  })),
  {
    id: "owner-tools-logs",
    relativePath: ".data/bea-owner-tools/logs",
    classification: "REGENERABLE",
  },
  {
    id: "phase132-production-web-log",
    relativePath: ".data/phase1-3-2-production-web.log",
    classification: "REGENERABLE",
  },
  {
    id: "phase132-production-web-error-log",
    relativePath: ".data/phase1-3-2-production-web-error.log",
    classification: "REGENERABLE",
  },
]);

export function localAppDataCleanupTargets(localAppData) {
  const toolchain = path.join(localAppData, "BEA", "CommandCenter", "toolchain");
  return Object.freeze([
    {
      id: "toolchain-node-download",
      absolutePath: path.join(toolchain, "downloads", "node-v24.19.0-win-x64.zip"),
      classification: "CACHE",
      root: toolchain,
    },
    {
      id: "toolchain-node-checksums",
      absolutePath: path.join(toolchain, "downloads", "SHASUMS256.txt"),
      classification: "CACHE",
      root: toolchain,
    },
    {
      id: "toolchain-empty-staging",
      absolutePath: path.join(toolchain, "staging"),
      classification: "REGENERABLE",
      root: toolchain,
      emptyOnly: true,
    },
  ]);
}

export const OPTIONAL_CLEANUP_APPROVALS = Object.freeze([
  {
    id: "node-modules",
    relativePath: "node_modules",
    classification: "REGENERABLE",
    approval: "REMOVE BEA NODE_MODULES AT <HEAD>",
  },
  {
    id: "preview-data",
    relativePath: ".data/pglite and .data/bea-preview",
    classification: "PREVIEW DATA",
    approval: "REMOVE BEA PREVIEW DATA AT <HEAD>",
  },
  {
    id: "visualizations",
    relativePath: "%USERPROFILE%/.codex/visualizations/<owner-selected-session>",
    classification: "REGENERABLE",
    approval: "REMOVE BEA VISUALIZATIONS AT <HEAD>",
  },
  {
    id: "isolated-toolchain",
    relativePath: "%LOCALAPPDATA%/BEA/CommandCenter/toolchain",
    classification: "TOOLCHAIN",
    approval: "REMOVE BEA TOOLCHAIN AT <HEAD>",
  },
]);
