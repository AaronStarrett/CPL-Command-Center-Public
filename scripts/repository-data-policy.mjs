import path from "node:path";

const prohibitedDirectoryNames = new Set([
  ".data",
  ".output",
  ".next",
  ".next-preview",
  ".open-next",
  ".wrangler",
  ".turbo",
  "backups",
  "build",
  "certificates",
  "coverage",
  "dist",
  "logs",
  "node_modules",
  "out",
  "playwright-report",
  "runtime",
  "screenshots",
  "secrets",
  "test-results",
  "toolchain",
]);

const prohibitedExtensions = [
  ".backup",
  ".bak",
  ".cer",
  ".crt",
  ".db",
  ".dump",
  ".jks",
  ".key",
  ".keystore",
  ".log",
  ".m4a",
  ".mp3",
  ".ogg",
  ".p12",
  ".pem",
  ".pfx",
  ".pid",
  ".sqlite",
  ".sqlite3",
  ".sql.gz",
  ".wav",
];

const prohibitedBaseNames = new Set([
  "kubeconfig",
  "production-process.json",
  "service-account.json",
]);

const prohibitedRootDirectoryNames = new Set(["reports"]);

export function normalizeRepositoryPath(value) {
  return String(value).trim().replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function prohibitedRepositoryPathReason(value) {
  const normalized = normalizeRepositoryPath(value);
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.includes("../")) {
    return "UNSAFE_REPOSITORY_PATH";
  }
  const lower = normalized.toLowerCase();
  const segments = lower.split("/");
  const base = segments.at(-1) ?? "";

  if (base.startsWith(".env") && base !== ".env.example") return "ENVIRONMENT_FILE";
  if (base === ".dev.vars" || base.startsWith(".dev.vars.")) return "ENVIRONMENT_FILE";
  if (base.startsWith(".npmrc") && normalized !== ".npmrc" && base !== ".npmrc.example") {
    return "PACKAGE_CREDENTIAL_FILE";
  }
  if (prohibitedRootDirectoryNames.has(segments[0])) {
    return "RUNTIME_OR_GENERATED_DIRECTORY";
  }
  if (
    prohibitedDirectoryNames.has(base) ||
    segments.some((entry) => prohibitedDirectoryNames.has(entry))
  ) {
    return "RUNTIME_OR_GENERATED_DIRECTORY";
  }
  if (prohibitedBaseNames.has(base)) return "SENSITIVE_RUNTIME_FILE";
  if (
    (segments.includes("config") || segments.includes("configuration")) &&
    /(?:^|[-_.])prod(?:uction)?(?:[-_.]|$)/u.test(base)
  ) {
    return "PRODUCTION_CONFIGURATION";
  }
  if (/(?:^|[-_.])backups?(?:[-_.]|$)/u.test(base) && /\.(?:7z|gz|tar|tgz|zip)$/u.test(base)) {
    return "BACKUP_ARCHIVE";
  }
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/u.test(base)) return "SSH_IDENTITY_FILE";
  if (/^(?:credentials?|client[_-]?secret|service[_-]?account).+\.json$/u.test(base)) {
    return "CREDENTIAL_DOCUMENT";
  }
  if (prohibitedExtensions.some((extension) => lower.endsWith(extension))) {
    return "SECRET_DATABASE_OR_RUNTIME_EXTENSION";
  }
  if (/(?:^|[-_.])(?:generated[-_.]?)?(?:audio|screenshot)(?:[-_.]|$)/u.test(base)) {
    const sourceDocument = /\.(?:cjs|cts|js|json|md|mjs|mts|ts|tsx)$/u.test(base);
    if (!sourceDocument) {
      return "GENERATED_MEDIA_FILE";
    }
  }
  return null;
}

export function findProhibitedRepositoryPaths(paths) {
  return paths
    .map(normalizeRepositoryPath)
    .filter((entry) => prohibitedRepositoryPathReason(entry) !== null)
    .sort();
}
