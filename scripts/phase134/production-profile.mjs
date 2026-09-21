export const DEPLOYMENT_PROFILES = Object.freeze(["local-live", "enterprise"]);
export const DEFAULT_PRODUCTION_PORTS = Object.freeze({
  web: 3210,
  https: 3443,
  workerHealth: 3211,
  control: 3212,
  setup: 3444,
});

const portKeys = Object.freeze(["web", "https", "workerHealth", "control", "setup"]);

export class ProductionProfileValidationError extends Error {
  constructor(issues) {
    super(`Production profile validation failed: ${issues.join("; ")}`);
    this.name = "ProductionProfileValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

export function isLoopbackAddress(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function isLoopbackSafeHostname(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase().replace(/\.$/u, "");
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

export function validateProductionPorts(input) {
  const issues = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProductionProfileValidationError(["ports must be an object"]);
  }
  const unknown = Object.keys(input).filter((key) => !portKeys.includes(key));
  if (unknown.length > 0) issues.push(`unknown port fields: ${unknown.join(", ")}`);

  const normalized = {};
  for (const key of portKeys) {
    const value = input[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
      issues.push(`${key} must be an integer from 1 through 65535`);
    } else {
      normalized[key] = value;
    }
  }
  const configured = Object.values(normalized);
  if (new Set(configured).size !== configured.length) {
    issues.push("all production ports must be distinct");
  }
  if (issues.length > 0) throw new ProductionProfileValidationError(issues);
  return Object.freeze(normalized);
}

export function validateProfileOrigin({ deploymentProfile, appBaseUrl, hostname }) {
  const issues = [];
  if (!DEPLOYMENT_PROFILES.includes(deploymentProfile)) {
    issues.push("deploymentProfile must be local-live or enterprise");
  }

  let url;
  try {
    url = new URL(appBaseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      issues.push("appBaseUrl must be a credential-free HTTPS origin");
    }
  } catch {
    issues.push("appBaseUrl must be a valid URL");
  }

  const normalizedHostname =
    typeof hostname === "string" ? hostname.trim().toLowerCase().replace(/\.$/u, "") : "";
  if (!normalizedHostname || url?.hostname.toLowerCase() !== normalizedHostname) {
    issues.push("hostname must exactly match appBaseUrl");
  }
  if (deploymentProfile === "local-live" && !isLoopbackSafeHostname(normalizedHostname)) {
    issues.push("local-live hostname must be localhost or a .localhost name");
  }
  if (deploymentProfile === "enterprise" && isLoopbackSafeHostname(normalizedHostname)) {
    issues.push("enterprise requires a non-localhost HTTPS hostname");
  }
  if (issues.length > 0) throw new ProductionProfileValidationError(issues);
  return Object.freeze({
    deploymentProfile,
    appBaseUrl: url.origin,
    hostname: normalizedHostname,
  });
}
