import { AUTHORIZED_REPOSITORY, FORBIDDEN_REPOSITORY } from "../repository-boundary.mjs";
import { prohibitedRepositoryPathReason } from "../repository-data-policy.mjs";

export const OWNER_ACCEPTANCE_PACKAGE_NAME = "BEA-Phase-2-3-Digital-Workforce-Evaluation";
export const OWNER_ACCEPTANCE_PACKAGE_VERSION = "phase-2.3";
export const CANONICAL_EXTRACTION_PATH = "C:\\CPL-Dev\\BEA-Automation-Command-Center";
export const START_LAUNCHER = "Start-BEA-Owner-Acceptance.cmd";
export const STOP_LAUNCHER = "Stop-BEA-Owner-Acceptance.cmd";
export const EXPECTED_MIGRATION_LEVEL = "0030_cpl_commercial_spine";

export const OWNER_ACCEPTANCE_DISK_GUIDANCE = Object.freeze({
  minimumFreeBytes: 5 * 1024 * 1024 * 1024,
  recommendedFreeBytes: 10 * 1024 * 1024 * 1024,
  estimatedFirstRunDependencyBytes: 500 * 1024 * 1024,
  estimatedToolchainBytes: 250 * 1024 * 1024,
  estimatedPostgresqlBytes: 400 * 1024 * 1024,
  firstRunDownloadTimeCategory:
    "several minutes on typical broadband for the BEA-owned Node toolchain plus the first frozen pnpm install",
});

const excludedPrefixes = [
  ".cursor/",
  ".git/",
  ".github/",
  ".next/",
  ".next-preview/",
  ".turbo/",
  "coverage/",
  "dist/",
  "node_modules/",
  "playwright-report/",
  "reports/",
  "test-results/",
  "tests/",
];

const excludedExact = new Set([
  "playwright.config.ts",
  "playwright.phase20.config.ts",
  "playwright.phase21.config.ts",
  "playwright.phase22.config.ts",
  "playwright.phase23.config.ts",
  "playwright.phase30.config.ts",
  "playwright.phase31a.config.ts",
  "playwright.phase134-production.config.ts",
  "playwright.shared.ts",
  "vitest.component.config.ts",
  "vitest.integration.config.ts",
  "vitest.unit.config.ts",
]);

export function normalizePackagePath(value) {
  return String(value).trim().replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function shouldIncludeRepositoryFile(relativePath) {
  const normalized = normalizePackagePath(relativePath);
  if (!normalized) return false;
  if (excludedExact.has(normalized)) return false;
  if (
    excludedPrefixes.some(
      (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
    )
  ) {
    return false;
  }
  const prohibited = prohibitedRepositoryPathReason(normalized);
  if (prohibited) return false;
  return true;
}

export function packageExclusionReason(relativePath) {
  const normalized = normalizePackagePath(relativePath);
  if (
    excludedExact.has(normalized) ||
    excludedPrefixes.some((prefix) => normalized.startsWith(prefix))
  ) {
    return "NOT_REQUIRED_FOR_OWNER_RUNTIME";
  }
  return prohibitedRepositoryPathReason(normalized);
}

export function ownerAcceptanceManifestTemplate(input) {
  return {
    applicationName: "BEA Operations Command Center",
    packageName: OWNER_ACCEPTANCE_PACKAGE_NAME,
    packageVersion: OWNER_ACCEPTANCE_PACKAGE_VERSION,
    gitBranch: input.gitBranch,
    gitCommitSha: input.gitCommitSha,
    buildDate: input.buildDate,
    expectedExtractionPath: CANONICAL_EXTRACTION_PATH,
    authorizedRepository: AUTHORIZED_REPOSITORY,
    prohibitedSiblingPath: FORBIDDEN_REPOSITORY.replaceAll("/", "\\"),
    includedFileCount: input.includedFileCount,
    compressedBytes: input.compressedBytes,
    extractedBytes: input.extractedBytes,
    sha256: input.sha256,
    syntheticDataDisclosure:
      "This package contains application source and synthetic BEA demonstration fixtures only. It does not contain Andrew's live business systems or customer data.",
    externalIntegrationStatus: "NOT CONNECTED",
    openAiConnectionStatusAtPackaging: "NOT CONNECTED",
    migrationLevel: EXPECTED_MIGRATION_LEVEL,
    supportedWindowsArchitecture: "win-x64",
    requiredPrerequisites: [
      "Windows 10/11 x64",
      "Canonical extraction path C:\\CPL-Dev\\BEA-Automation-Command-Center",
      "BEA-owned Node 24.19.0 and pnpm 11.19.0 via Ensure-BEA-Toolchain.cmd",
      "Current-user DPAPI, LOCALAPPDATA, and NTFS ACL support",
      "Loopback ports 3300/3301/3302",
    ],
    launchers: {
      first: START_LAUNCHER,
      stop: STOP_LAUNCHER,
      doctor: "BEA-Doctor.cmd",
      configure: "Configure-BEA.cmd",
      toolchain: "Ensure-BEA-Toolchain.cmd",
    },
    diskGuidance: OWNER_ACCEPTANCE_DISK_GUIDANCE,
    openaiKeyIncluded: false,
    liveOpenAiCallDuringPackaging: false,
  };
}

export function buildReadMeFirst(input) {
  const checksumLine = input.sha256
    ? `SHA-256 of the downloaded zip: ${input.sha256}`
    : "SHA-256 of the downloaded zip is in the GitHub Actions artifact file PACKAGE-CHECKSUMS.txt (a zip cannot contain its own final hash).";
  return `BEA Operations Command Center
Owner Evaluation — Phase 2.3 Digital Workforce Alpha

READ THIS FIRST.

1. Extract so this file sits at:

   ${CANONICAL_EXTRACTION_PATH}\\READ-ME-FIRST.txt

   Create C:\\CPL-Dev if needed. Extract the zip INTO
   C:\\CPL-Dev\\BEA-Automation-Command-Center
   (or extract to C:\\CPL-Dev if the zip contains that folder).

   If you see an extra nested folder, move the files up so
   ${START_LAUNCHER} is directly in the path above.

2. Double-click:

   ${START_LAUNCHER}

   PostgreSQL is not required. The launcher starts Owner Evaluation
   with synthetic BEA records and live OpenAI (after you connect
   inside the application). It keeps this window open if setup fails.

3. No OpenAI API key is included in this package.
   Do not paste a key into Cursor, Terminal, PowerShell, a command,
   a source file, .env.local, GitHub, or this documentation.

4. Connect OpenAI inside the application:
   Cloud: Sign in → OpenAI Setup → Server credential available →
   Test connection and discover models.
   Windows: Sign in → OpenAI Setup → paste the project-scoped key →
   Save key and connect OpenAI → choose models → Go to AI Command.
   Ask for a BEA executive briefing PDF from research or a lead.

5. This package contains synthetic BEA demonstration data only.
   Andrew's real CRM, email, files, and accounting systems are not connected.

6. External BEA systems are not connected.

7. In AI Command, choose Voice Mode, then Start Voice.
   Type Mode is a separate typed conversation. Switching to Type stops the microphone.

8. Stop safely by double-clicking:

   ${STOP_LAUNCHER}

   That stops only the Owner Evaluation child processes.
   Do not use Task Manager to kill Node by name.

Package: ${OWNER_ACCEPTANCE_PACKAGE_NAME}
Git commit: ${input.gitCommitSha}
Branch: ${input.gitBranch}
${checksumLine}

Disk guidance
- Minimum free space: 5 GB
- Recommended free space: 10 GB
- First-run toolchain: about 250 MB under %LOCALAPPDATA%\\BEA\\CommandCenter
- First-run pnpm install: about 400-500 MB in this folder
- PostgreSQL is not required for Owner Evaluation

If the launcher says the path is wrong, stop. Do not continue from another folder.
Never open, copy from, or save into:

   C:\\CPL-Dev\\Cyber Pirate Labs Command Center

Full steps: docs\\PHASE_2_1_OWNER_LIVE_RUNBOOK.md
`;
}
