import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import { inspectHostedWorkflow, hostedActionsParkingFindings } from "./hosted-actions-parked.mjs";
import { assertRepositoryBoundary, targetForEnvironment } from "./repository-boundary.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const REQUIRED_DEPLOYMENT_FILES = [
  ".dockerignore",
  "infra/docker/Dockerfile.web",
  "infra/docker/Dockerfile.worker",
  "infra/deployment/environment.schema.json",
  "infra/deployment/manifest.example.json",
  "infra/deployment/health-contract.json",
  "infra/supabase/config.example.toml",
  "infra/supabase/migrations/0001_pgvector_tenancy_template.sql.example",
  "infra/r2/r2.example.json",
  "infra/r2/cors.example.json",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-manual.yml",
  ".github/dependabot.yml",
];

export function parseDockerStages(contents) {
  const instructions = [];
  let current = "";
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const continued = line.endsWith("\\");
    const segment = continued ? line.slice(0, -1).trimEnd() : line;
    current = current ? current + " " + segment : segment;
    if (!continued) {
      instructions.push(current);
      current = "";
    }
  }
  if (current) instructions.push(current);

  const stages = [];
  for (const instruction of instructions) {
    if (/^FROM\s/iu.test(instruction)) stages.push([]);
    if (stages.length === 0) throw new Error("DOCKERFILE_MISSING_FROM");
    stages.at(-1).push(instruction);
  }
  return stages;
}

function finalDockerStage(contents) {
  try {
    return parseDockerStages(contents).at(-1) ?? [];
  } catch {
    return [];
  }
}

export function validateDeploymentScaffolding(root = repositoryRoot) {
  const resolvedRoot = root instanceof URL ? fileURLToPath(root) : path.resolve(root);
  const findings = [];
  const text = (relativePath) => {
    const candidate = path.join(resolvedRoot, relativePath);
    if (!existsSync(candidate)) {
      findings.push("missing:" + relativePath);
      return null;
    }
    return readFileSync(candidate, "utf8");
  };
  const json = (relativePath) => {
    const contents = text(relativePath);
    if (contents === null) return null;
    try {
      return JSON.parse(contents);
    } catch {
      findings.push("invalid-json:" + relativePath);
      return null;
    }
  };

  const jsonPaths = [
    "infra/deployment/environment.schema.json",
    "infra/deployment/manifest.example.json",
    "infra/deployment/health-contract.json",
    "infra/r2/r2.example.json",
    "infra/r2/cors.example.json",
  ];
  const parsed = Object.fromEntries(
    jsonPaths.map((relativePath) => [relativePath, json(relativePath)]),
  );
  for (const relativePath of REQUIRED_DEPLOYMENT_FILES.filter(
    (candidate) => !jsonPaths.includes(candidate),
  )) {
    text(relativePath);
  }
  const yamlDocuments = {};
  for (const relativePath of [
    ".github/workflows/ci.yml",
    ".github/workflows/deploy-manual.yml",
    ".github/dependabot.yml",
  ]) {
    const contents = text(relativePath);
    if (contents === null) continue;
    try {
      yamlDocuments[relativePath] = yaml.load(contents);
    } catch {
      findings.push("invalid-yaml:" + relativePath);
    }
  }
  findings.push(
    ...hostedActionsParkingFindings(resolvedRoot, [
      ".github/workflows/ci.yml",
      ".github/workflows/deploy-manual.yml",
    ]),
  );
  const ciWorkflowText = text(".github/workflows/ci.yml") ?? "";
  const deployWorkflowText = text(".github/workflows/deploy-manual.yml") ?? "";
  const ciInspection = ciWorkflowText ? inspectHostedWorkflow(ciWorkflowText) : null;
  const deployInspection = deployWorkflowText ? inspectHostedWorkflow(deployWorkflowText) : null;
  const ciWorkflow = ciInspection?.original;
  const deployWorkflow = deployInspection?.original;
  const ciContractText = ciInspection?.originalText ?? ciWorkflowText;
  const deployContractText = deployInspection?.originalText ?? deployWorkflowText;
  if (
    ciWorkflow &&
    !["quality", "secrets", "dependency-audit", "containers", "deployment-contracts"].every(
      (job) => ciWorkflow.jobs?.[job],
    )
  ) {
    findings.push("ci-required-jobs-missing");
  }
  if (
    deployWorkflow &&
    !JSON.stringify(deployWorkflow).includes("DEPLOYMENT_ADAPTER_NOT_IMPLEMENTED")
  ) {
    findings.push("manual-deployment-fail-closed-marker-missing");
  }
  if (deployWorkflow && !JSON.stringify(deployWorkflow).includes("DEPLOYMENT_EXECUTION=NOT_RUN")) {
    findings.push("manual-deployment-not-run-marker-missing");
  }
  if (
    /\b(?:az\s|bicep\s|kubectl\s|railway\s+up|terraform\s+(?:apply|destroy))/iu.test(
      deployContractText,
    )
  ) {
    findings.push("manual-workflow-contains-provisioning-command");
  }
  if (
    !ciContractText.includes("docker image inspect") ||
    !ciContractText.includes("credential-free two-container liveness smoke")
  ) {
    findings.push("container-runtime-contract-ci-missing");
  }

  const manifest = parsed["infra/deployment/manifest.example.json"];
  if (manifest && manifest.runtime?.recommendedInitialTarget !== "railway") {
    findings.push("initial-runtime-not-railway");
  }
  if (manifest && manifest.runtime?.adapterImplemented !== false) {
    findings.push("deployment-adapter-must-remain-unimplemented");
  }
  if (manifest && manifest.runtime?.deploymentEnabled !== false) {
    findings.push("deployment-must-remain-disabled");
  }
  if (manifest && manifest.providers?.database !== "supabase-postgres") {
    findings.push("primary-database-not-supabase-postgres");
  }
  if (manifest && manifest.providers?.objectStorage !== "cloudflare-r2") {
    findings.push("primary-object-storage-not-r2");
  }
  if (manifest && manifest.providers?.auth === "supabase-auth") {
    findings.push("supabase-auth-must-be-optional");
  }
  if (manifest && manifest.providers?.optionalAuthAdapter !== "supabase-auth") {
    findings.push("optional-supabase-auth-adapter-missing");
  }
  if (manifest && manifest.providers?.knowledgeSources?.[0] !== "onedrive") {
    findings.push("onedrive-must-be-default-knowledge-source");
  }
  if (manifest && !manifest.providers?.knowledgeSources?.includes("google-drive-optional")) {
    findings.push("google-drive-must-remain-optional");
  }
  const providerExpectations = {
    vectorMemory: "supabase-pgvector",
    queue: "postgres-pg-boss",
    secrets: "runtime-encrypted-secrets",
    email: "not-configured",
    monitoring: "structured-logs",
    backup: "manual-export-until-configured",
  };
  for (const [key, expected] of Object.entries(providerExpectations)) {
    if (manifest && manifest.providers?.[key] !== expected) {
      findings.push("provider-selection-mismatch:" + key);
    }
  }

  const r2 = parsed["infra/r2/r2.example.json"];
  if (r2?.lifecycle?.some((rule) => rule.enabled !== false)) {
    findings.push("r2-destructive-lifecycle-enabled");
  }
  if (r2 && r2.credentialsCommitted !== false) findings.push("r2-credential-policy-invalid");
  if (r2 && (r2.publicAccess !== false || r2.tenantKeyTemplate !== "tenants/TENANT_ID/")) {
    findings.push("r2-tenant-or-public-policy-invalid");
  }
  const cors = parsed["infra/r2/cors.example.json"];
  if (cors && (cors.wildcardOriginsAllowed !== false || cors.credentialsCommitted !== false)) {
    findings.push("r2-cors-policy-invalid");
  }

  const supabaseConfig = text("infra/supabase/config.example.toml") ?? "";
  if (!/\[auth\]\s*enabled\s*=\s*false/u.test(supabaseConfig)) {
    findings.push("supabase-auth-template-must-be-disabled");
  }
  const sql = text("infra/supabase/migrations/0001_pgvector_tenancy_template.sql.example") ?? "";
  if (!/CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;/u.test(sql)) {
    findings.push("pgvector-extension-template-invalid");
  }
  if (!sql.includes("tenant_id")) findings.push("tenant-template-missing");

  const environmentSchema = parsed["infra/deployment/environment.schema.json"];
  const runtimeContract = environmentSchema?.["x-bea-runtime-contract"];
  const requiredRuntimeVariables = [
    "APP_MODE",
    "BEA_RUNTIME_MODE",
    "BEA_DEPLOYMENT_PROFILE",
    "BEA_AUTH_PROVIDER",
    "DATABASE_DRIVER",
    "DEMO_AUTH_ENABLED",
    "WORKER_MODE",
    "WORKER_QUEUE_ADAPTER",
  ];
  if (
    runtimeContract?.adapterImplemented !== false ||
    !requiredRuntimeVariables.every((key) =>
      runtimeContract?.requiredRuntimeVariables?.includes(key),
    )
  ) {
    findings.push("runtime-environment-mapping-incomplete");
  }
  if (
    environmentSchema &&
    !requiredRuntimeVariables.every((key) => environmentSchema.required?.includes(key))
  ) {
    findings.push("runtime-variables-not-schema-required");
  }

  for (const relativePath of ["infra/docker/Dockerfile.web", "infra/docker/Dockerfile.worker"]) {
    const dockerfile = text(relativePath) ?? "";
    const runtimeInstructions = finalDockerStage(dockerfile);
    if (runtimeInstructions.length === 0) findings.push("invalid-dockerfile:" + relativePath);
    if (!runtimeInstructions.some((line) => /^FROM node:24\.19\.0-\S+ AS runtime$/u.test(line))) {
      findings.push("unpinned-node:" + relativePath);
    }
    if (
      !runtimeInstructions.some((line) => /^RUN npm install --global pnpm@11\.19\.0$/u.test(line))
    ) {
      findings.push("unpinned-pnpm:" + relativePath);
    }
    if (!runtimeInstructions.some((line) => line.startsWith("HEALTHCHECK "))) {
      findings.push("missing-healthcheck:" + relativePath);
    }
    if (!runtimeInstructions.includes("USER node"))
      findings.push("container-runs-as-root:" + relativePath);
  }

  const webRuntime = finalDockerStage(text("infra/docker/Dockerfile.web") ?? "");
  if (
    !webRuntime.some(
      (line) => line.startsWith("HEALTHCHECK ") && line.includes("process.env.PORT||3000"),
    )
  ) {
    findings.push("web-port-hardcoded");
  }
  const workerRuntime = finalDockerStage(text("infra/docker/Dockerfile.worker") ?? "");
  if (
    !workerRuntime.some(
      (line) =>
        line.startsWith("HEALTHCHECK ") && line.includes("process.env.WORKER_HEALTH_PORT||3001"),
    )
  ) {
    findings.push("worker-health-port-hardcoded");
  }

  const health = parsed["infra/deployment/health-contract.json"];
  if (manifest && health) {
    const web = manifest.services?.find((service) => service.name === "bea-web");
    const worker = manifest.services?.find((service) => service.name === "bea-worker");
    if (web?.healthPath !== health.web?.path || worker?.healthPath !== health.worker?.path) {
      findings.push("service-health-contract-mismatch");
    }
    if (
      web?.readinessPath !== health.web?.readinessPath ||
      web?.readinessStatus !== "blocked-until-hosted-worker-endpoint-adapter" ||
      health.web?.readinessStatus !== "blocked-until-hosted-worker-endpoint-adapter"
    ) {
      findings.push("hosted-worker-readiness-seam-not-blocked");
    }
  }

  const dockerIgnore = text(".dockerignore") ?? "";
  for (const required of [
    ".git",
    ".data",
    "node_modules",
    ".env.*",
    "**/secrets",
    "**/toolchain",
  ]) {
    if (!dockerIgnore.split(/\r?\n/u).includes(required)) {
      findings.push("dockerignore-missing:" + required);
    }
  }

  if (existsSync(path.join(resolvedRoot, "infra", "azure"))) {
    findings.push("azure-is-mandatory-in-infra");
  }
  if (existsSync(path.join(resolvedRoot, ".github", "workflows", "azure-manual.yml"))) {
    findings.push("azure-manual-workflow-present");
  }

  const uniqueFindings = [...new Set(findings)].sort();
  return {
    code:
      uniqueFindings.length === 0
        ? "BEA_DEPLOYMENT_SCAFFOLDING_OK"
        : "BEA_DEPLOYMENT_SCAFFOLDING_INVALID",
    ok: uniqueFindings.length === 0,
    providerNeutral: !existsSync(path.join(resolvedRoot, "infra", "azure")),
    files: REQUIRED_DEPLOYMENT_FILES.length,
    findings: uniqueFindings,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const boundary = assertRepositoryBoundary({ target: targetForEnvironment() });
  const result = validateDeploymentScaffolding(boundary.target);
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.ok) process.exitCode = 1;
}
