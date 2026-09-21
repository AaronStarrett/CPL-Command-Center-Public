import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

export const HOSTED_ACTIONS_PARKED_MARKER = "BEA_HOSTED_ACTIONS_PARKED";
export const HOSTED_ACTIONS_ORIGINAL_BEGIN = "BEA_HOSTED_ACTIONS_ORIGINAL_BEGIN";
export const HOSTED_ACTIONS_ORIGINAL_END = "BEA_HOSTED_ACTIONS_ORIGINAL_END";

export const HOSTED_WORKFLOW_PATHS = Object.freeze([
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-manual.yml",
  ".github/workflows/windows-owner-acceptance-package.yml",
]);

function triggerNames(on) {
  if (!on) return [];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on);
}

export function extractCommentedOriginalWorkflow(contents) {
  const lines = String(contents).split(/\r?\n/u);
  const start = lines.findIndex((line) => line.includes(HOSTED_ACTIONS_ORIGINAL_BEGIN));
  const stop = lines.findIndex((line) => line.includes(HOSTED_ACTIONS_ORIGINAL_END));
  if (start < 0 || stop < 0 || stop <= start) {
    throw new Error("parked workflow missing original markers");
  }
  return lines
    .slice(start + 1, stop)
    .map((line) => {
      if (line.startsWith("# ")) return line.slice(2);
      if (line.startsWith("#")) return line.slice(1);
      return line;
    })
    .join("\n");
}

export function inspectHostedWorkflow(contents) {
  const text = String(contents);
  const parked = text.includes(HOSTED_ACTIONS_PARKED_MARKER);
  let active = null;
  try {
    active = yaml.load(text) ?? {};
  } catch {
    return {
      parked,
      invalidYaml: true,
      active: null,
      original: null,
      originalText: parked ? "" : text,
      automaticTriggers: [],
    };
  }

  let original = active;
  let originalText = text;
  if (parked) {
    try {
      originalText = extractCommentedOriginalWorkflow(text);
      original = yaml.load(originalText) ?? {};
    } catch {
      return {
        parked,
        invalidYaml: true,
        active,
        original: null,
        originalText,
        automaticTriggers: triggerNames(active.on).filter((name) => name !== "workflow_dispatch"),
      };
    }
  }

  return {
    parked,
    invalidYaml: false,
    active,
    original,
    originalText,
    automaticTriggers: triggerNames(active.on).filter((name) => name !== "workflow_dispatch"),
  };
}

export function inspectHostedWorkflowFile(root, relativePath) {
  const candidate = path.join(root, relativePath);
  if (!existsSync(candidate)) {
    return {
      relativePath,
      missing: true,
      parked: false,
      invalidYaml: false,
      active: null,
      original: null,
      originalText: "",
      automaticTriggers: [],
    };
  }
  return {
    relativePath,
    missing: false,
    ...inspectHostedWorkflow(readFileSync(candidate, "utf8")),
  };
}

export function hostedActionsParkingFindings(root, paths = HOSTED_WORKFLOW_PATHS) {
  const findings = [];
  const directory = path.join(root, ".github", "workflows");
  const discovered = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => /\.ya?ml$/u.test(name))
        .map((name) => ".github/workflows/" + name)
    : [];
  for (const relativePath of new Set([...paths, ...discovered])) {
    const inspection = inspectHostedWorkflowFile(root, relativePath);
    if (inspection.missing) {
      findings.push("missing:" + relativePath);
      continue;
    }
    if (inspection.invalidYaml) findings.push("invalid-yaml:" + relativePath);
    if (!inspection.parked) findings.push("hosted-actions-must-remain-parked:" + relativePath);
    const triggers = triggerNames(inspection.active?.on);
    if (triggers.length !== 1 || triggers[0] !== "workflow_dispatch")
      findings.push("hosted-actions-only-manual-trigger-required:" + relativePath);
    const jobs = Object.values(inspection.active?.jobs ?? {});
    if (
      jobs.length === 0 ||
      jobs.some(
        (job) => job?.if !== false && !/^\s*\$\{\{\s*false\s*\}\}\s*$/u.test(String(job?.if)),
      )
    )
      findings.push("hosted-actions-jobs-must-be-disabled:" + relativePath);
    if (inspection.automaticTriggers.length > 0) {
      findings.push("hosted-actions-automatic-triggers-present:" + relativePath);
    }
  }
  return findings;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = hostedActionsParkingFindings(repositoryRoot);
  if (findings.length > 0) {
    process.stderr.write(findings.join("\n") + "\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("BEA_HOSTED_ACTIONS=PARKED\n");
  }
}
