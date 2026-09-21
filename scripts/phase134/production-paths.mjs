import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export const repositoryRoot = resolve(scriptDirectory, "../..");
export const PRODUCT_DIRECTORY_SEGMENTS = Object.freeze(["BEA", "CommandCenter"]);
export const TOOLCHAIN_NODE_VERSION = "24.19.0";
export const TOOLCHAIN_PNPM_VERSION = "11.19.0";

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || value.trim() === "" || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return resolve(value);
}

export function isPathContained(parent, candidate) {
  const normalizedParent = resolve(parent);
  const normalizedCandidate = resolve(candidate);
  const relationship = relative(normalizedParent, normalizedCandidate);
  return (
    relationship === "" ||
    (relationship !== ".." && !relationship.startsWith(`..${sep}`) && !isAbsolute(relationship))
  );
}

export function assertPathContained(parent, candidate, label = "Path") {
  if (!isPathContained(parent, candidate)) {
    throw new Error(`${label} must remain inside ${resolve(parent)}.`);
  }
  return resolve(candidate);
}

export function createProductionPaths(options = {}) {
  const localAppData = requireAbsolutePath(
    options.localAppData ?? options.environment?.LOCALAPPDATA ?? process.env.LOCALAPPDATA,
    "LOCALAPPDATA",
  );
  const productRoot = resolve(
    options.productRoot ?? join(localAppData, ...PRODUCT_DIRECTORY_SEGMENTS),
  );
  assertPathContained(localAppData, productRoot, "BEA product root");

  const toolchainDirectory = join(productRoot, "toolchain");
  const nodeDirectory = join(toolchainDirectory, `node-v${TOOLCHAIN_NODE_VERSION}-win-x64`);
  const configDirectory = join(productRoot, "config");
  const secretDirectory = join(productRoot, "secrets");
  const certificateDirectory = join(productRoot, "certificates");
  const runtimeDirectory = join(productRoot, "runtime");

  return Object.freeze({
    productRoot,
    repositoryRoot,
    toolchainDirectory,
    toolchainDownloadDirectory: join(toolchainDirectory, "downloads"),
    toolchainStagingDirectory: join(toolchainDirectory, "staging"),
    toolchainMetadataFile: join(toolchainDirectory, "toolchain.json"),
    nodeDirectory,
    nodeExecutable: join(nodeDirectory, "node.exe"),
    corepackExecutable: join(nodeDirectory, "corepack.cmd"),
    corepackJavaScript: join(nodeDirectory, "node_modules", "corepack", "dist", "corepack.js"),
    corepackHome: join(toolchainDirectory, "corepack-home"),
    pnpmHome: join(toolchainDirectory, "pnpm-home"),
    pnpmExecutable: join(toolchainDirectory, "bin", "pnpm.cmd"),
    configDirectory,
    configFile: join(configDirectory, "production.json"),
    setupStateFile: join(configDirectory, "setup-state.json"),
    secretDirectory,
    secretFile: join(secretDirectory, "production-secrets.dpapi.json"),
    certificateDirectory,
    certificateMetadataFile: join(certificateDirectory, "certificate.json"),
    certificatePfxFile: join(certificateDirectory, "bea-localhost.pfx"),
    certificateRootFile: join(certificateDirectory, "bea-local-root.cer"),
    runtimeDirectory,
    runtimeMetadataFile: join(runtimeDirectory, "production-process.json"),
    runtimeLockFile: join(runtimeDirectory, "production.lock"),
    buildManifestFile: join(runtimeDirectory, "build-manifest.json"),
    logDirectory: join(productRoot, "logs"),
    backupDirectory: join(productRoot, "backups"),
  });
}

export const productionPaths = createProductionPaths();
