import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRepositoryBoundary } from "./repository-boundary.mjs";
import { createSafeEnvironment, prepareDirectories } from "./cpl-local.mjs";
import { synchronizeWorkspaceCopies } from "./cpl-workspace-copies.mjs";
import { assertUnredirectedPath, verifyExport } from "./publication-export.mjs";
import { prohibitedRepositoryPathReason } from "./repository-data-policy.mjs";
import { writeHostingNotices } from "./hosting-notices.mjs";
import { prepareHostedWorkspaceAsset } from "./hosting-static-shell.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicOrigin = "https://github.com/AaronStarrett/CPL-Command-Center-Public.git";
const publicId = 1380072423;
const pins = Object.freeze({ "@opennextjs/cloudflare": "1.20.6", wrangler: "4.136.1" });
const git = (arguments_) =>
  execFileSync(
    "git",
    ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "-C", root, ...arguments_],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  ).trim();

export function parseHostingArguments(arguments_) {
  const [action, target = "web", ...options] = arguments_;
  if (
    !["build", "dry-run", "preview", "deploy"].includes(action) ||
    !["web", "jobs"].includes(target)
  )
    throw new Error(
      "Usage: cloudflare-hosting.mjs <build|dry-run|preview|deploy> <web|jobs> [--commit <published-sha>]",
    );
  if (
    options.length &&
    (options.length !== 2 || options[0] !== "--commit" || !/^[a-f0-9]{40}$/u.test(options[1]))
  )
    throw new Error("A full public commit SHA is required after --commit.");
  if (action === "deploy" && options.length !== 2)
    throw new Error("Deployment requires --commit with the reviewed, published commit.");
  if (action === "build" && target === "jobs")
    throw new Error("Use dry-run jobs to build and inspect the standalone scheduler bundle.");
  return { action, target, commit: options[1] };
}

export function assertPublishedDeployment({ identity, commit, head, dirty, remoteHead, origin }) {
  if (
    identity !== publicId ||
    !/^[a-f0-9]{40}$/u.test(commit ?? "") ||
    head !== commit ||
    dirty ||
    remoteHead !== commit ||
    origin !== publicOrigin
  )
    throw new Error(
      "Deployment requires the clean reviewed public checkout at the exact published main commit.",
    );
}

export function bundledEnvironmentFile(name, action = "build") {
  return (
    (/^\.env(?:\.|$)/u.test(name) && name !== ".env.example") ||
    (action === "build" && /^\.dev\.vars(?:\.|$)/u.test(name))
  );
}

function sourceFingerprint() {
  const files = [
    ...new Set(
      git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean),
    ),
  ]
    .filter((file) => !prohibitedRepositoryPathReason(file))
    .sort();
  const hash = createHash("sha256");
  for (const file of files)
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(path.join(root, file)))
      .update("\0");
  return hash.digest("hex");
}

function artifactFingerprint(directory) {
  const hash = createHash("sha256");
  function visit(relative) {
    const location = path.join(directory, relative);
    const information = lstatSync(location);
    if (information.isSymbolicLink()) throw new Error("Linked hosting output is not accepted.");
    if (information.isDirectory()) {
      for (const child of readdirSync(location).sort()) visit(path.join(relative, child));
    } else if (information.isFile()) {
      hash
        .update(relative.replaceAll("\\", "/"))
        .update("\0")
        .update(readFileSync(location))
        .update("\0");
    } else throw new Error("Unsupported hosting output type.");
  }
  visit("");
  return hash.digest("hex");
}

function executable(packageName) {
  const directory = path.join(root, "node_modules", packageName);
  const metadata = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
  if (metadata.version !== pins[packageName])
    throw new Error(`Unexpected ${packageName} version; install the frozen lockfile.`);
  const command = packageName === "wrangler" ? "wrangler" : "opennextjs-cloudflare";
  return path.join(directory, metadata.bin[command]);
}

export function hostingEnvironment(repositoryRoot, source = process.env) {
  const environment = createSafeEnvironment(repositoryRoot, source);
  const inheritedPath = environment.Path ?? environment.PATH ?? "";
  delete environment.Path;
  delete environment.PATH;
  environment[process.platform === "win32" ? "Path" : "PATH"] =
    path.dirname(process.execPath) + path.delimiter + inheritedPath;
  return {
    ...environment,
    NODE_ENV: "production",
    CPL_HOSTED_BUILD: "true",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: path.join(repositoryRoot, ".data", "hosting", "wrangler.log"),
    XDG_CONFIG_HOME: path.join(repositoryRoot, ".data", "hosting", "config"),
    WRANGLER_HOME: path.join(repositoryRoot, ".data", "hosting", "config", ".wrangler"),
  };
}

export function staticCacheEnvironment(repositoryRoot, source = process.env) {
  // OpenNext's local cache command initializes an empty platform proxy before
  // copying static files. This non-secret loopback placeholder satisfies its
  // Hyperdrive metadata check; no application or database query runs there.
  // Keep it confined to that child, outside build, preview and deployment.
  return {
    ...hostingEnvironment(repositoryRoot, source),
    WRANGLER_WRITE_LOGS: "false",
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_CPL_WEB_DB:
      "postgresql://cpl_build:unused@127.0.0.1:1/cpl_build",
  };
}

export function runCloudflareHosting(arguments_ = process.argv.slice(2)) {
  const options = parseHostingArguments(arguments_);
  const boundary = assertRepositoryBoundary({ cwd: root, target: root });
  prepareDirectories(root);
  // The authorized Windows SSD uses verified physical workspace copies.
  // Refresh these before fingerprinting so recent hosted contracts are compiled.
  if (process.platform === "win32") synchronizeWorkspaceCopies();
  const evidenceDirectory = path.join(root, ".data", "hosting");
  assertUnredirectedPath(evidenceDirectory, root);
  mkdirSync(evidenceDirectory, { recursive: true });
  const environment = hostingEnvironment(root);
  const head = git(["rev-parse", "HEAD"]);
  const fingerprint = sourceFingerprint();
  const cwd = path.join(root, "apps", options.target === "web" ? "web" : "worker");
  // OpenNext independently embeds root/app .env files in next-env.mjs, even
  // when the Next launcher suppresses dotenv. Never permit that secret path.
  for (const directory of [root, cwd]) {
    if (readdirSync(directory).some((name) => bundledEnvironmentFile(name, options.action)))
      throw new Error(
        "Hosting builds refuse local environment secret files in the repository or app. Keep credentials in the approved external secret file/provider bindings.",
      );
  }
  const evidenceFile = path.join(evidenceDirectory, `${options.target}-dry-run.json`);
  const nextBuildFile = path.join(evidenceDirectory, "web-build.json");
  const nextOutput = path.join(root, "apps", "web", ".open-next");
  const bundleDirectory = path.join(evidenceDirectory, "bundles", options.target);
  for (const directory of [
    nextOutput,
    bundleDirectory,
    environment.WRANGLER_HOME,
    path.join(cwd, ".wrangler"),
    path.join(evidenceDirectory, "local-state", options.target),
    path.join(evidenceDirectory, "attempts"),
  ])
    assertUnredirectedPath(directory, root);
  if (options.target === "web" && options.action !== "build") {
    const built = existsSync(nextBuildFile)
      ? JSON.parse(readFileSync(nextBuildFile, "utf8"))
      : null;
    if (
      !built ||
      built.status !== "PASS" ||
      built.sourceFingerprint !== fingerprint ||
      built.commit !== head ||
      built.artifactFingerprint !== artifactFingerprint(nextOutput)
    )
      throw new Error(
        "The OpenNext build must match this source and its generated output before preview, dry-run, or deployment.",
      );
  }
  if (options.action === "deploy") {
    const remoteHead = git(["ls-remote", "--heads", publicOrigin, "refs/heads/main"]).split(
      /\s+/u,
    )[0];
    assertPublishedDeployment({
      identity: boundary.repositoryId,
      commit: options.commit,
      head,
      dirty: git(["status", "--porcelain"]) !== "",
      remoteHead,
      origin: git(["remote", "get-url", "origin"]),
    });
    verifyExport(root);
    const previous = existsSync(evidenceFile)
      ? JSON.parse(readFileSync(evidenceFile, "utf8"))
      : null;
    if (
      !previous ||
      previous.sourceFingerprint !== fingerprint ||
      previous.commit !== head ||
      previous.status !== "PASS" ||
      previous.artifactFingerprint !== artifactFingerprint(bundleDirectory)
    )
      throw new Error(
        "Build/dry-run evidence must match this exact public source before deployment.",
      );
    for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
      if (process.env[key]) environment[key] = process.env[key];
  }
  const cli = executable(options.action === "build" ? "@opennextjs/cloudflare" : "wrangler");
  let cliArguments;
  if (options.action === "build") cliArguments = ["build"];
  else if (options.action === "preview")
    cliArguments = [
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      options.target === "web" ? "3401" : "3402",
      "--persist-to",
      path.join(evidenceDirectory, "local-state", options.target),
      ...(options.target === "jobs" ? ["--test-scheduled"] : []),
    ];
  else
    cliArguments = [
      "deploy",
      ...(options.action === "dry-run"
        ? ["--dry-run", "--outdir", bundleDirectory]
        : ["--var", `CPL_PUBLIC_COMMIT:${head}`]),
    ];
  const startedAt = new Date().toISOString();
  let result = spawnSync(process.execPath, [cli, ...cliArguments], {
    cwd,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
  let staticCachePrepared = false;
  let staticWorkspace = null;
  let thirdPartyNotices = null;
  if (options.action === "build" && result.status === 0) {
    // The adapter creates cache files separately from its assets. Its official
    // local population step copies SSG cache entries into Workers Static Assets;
    // no remote cache service is required. Hash the completed output afterward.
    result = spawnSync(process.execPath, [cli, "populateCache", "local"], {
      cwd,
      env: staticCacheEnvironment(root, environment),
      stdio: "inherit",
      windowsHide: true,
    });
    staticCachePrepared = result.status === 0;
  }
  if (options.action === "build" && result.status === 0) {
    try {
      staticWorkspace = prepareHostedWorkspaceAsset(root);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Workspace preparation failed.");
      result = { ...result, status: 1, error: { code: "HOSTED_STATIC_WORKSPACE_INVALID" } };
    }
  }
  if (options.action === "build" && result.status === 0) {
    const metafiles = [];
    // Final Wrangler graphs cover the copied adapter runtime and the independent
    // scheduler. These are local dry-runs; ordinary release dry-runs still follow.
    for (const target of ["web", "jobs"]) {
      const directory = path.join(root, "apps", target === "web" ? "web" : "worker");
      const output = path.join(evidenceDirectory, "notice-inputs", target);
      assertUnredirectedPath(output, root);
      mkdirSync(output, { recursive: true });
      const file = path.join(output, "metafile.json");
      result = spawnSync(
        process.execPath,
        [executable("wrangler"), "deploy", "--dry-run", "--outdir", output, "--metafile", file],
        {
          cwd: directory,
          env: environment,
          stdio: "inherit",
          windowsHide: true,
        },
      );
      if (result.status !== 0) break;
      metafiles.push({ file, directory });
    }
    if (result.status === 0) {
      metafiles.push({
        file: path.join(
          nextOutput,
          "server-functions",
          "default",
          "apps",
          "web",
          "handler.mjs.meta.json",
        ),
        directory: cwd,
      });
      try {
        thirdPartyNotices = writeHostingNotices({
          repositoryRoot: root,
          webpackDirectory: path.join(cwd, ".next", "cpl-dependency-inputs"),
          metafiles,
          outputDirectory: path.join(nextOutput, "assets"),
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Hosted notice preparation failed.");
        result = { ...result, status: 1, error: { code: "HOSTED_NOTICE_REVIEW_REQUIRED" } };
      }
    }
  }
  const finalFingerprint = sourceFingerprint();
  const sourceUnchanged = finalFingerprint === fingerprint;
  const success = result.status === 0 && sourceUnchanged;
  const evidence = {
    status: success ? "PASS" : "FAIL",
    action: options.action,
    target: options.target,
    startedAt,
    finishedAt: new Date().toISOString(),
    commit: head,
    sourceFingerprint: fingerprint,
    finalSourceFingerprint: finalFingerprint,
    sourceUnchanged,
    toolStatus: result.status === 0 ? "PASS" : "FAIL",
    ...(options.action === "build"
      ? { staticCachePrepared, staticWorkspace, thirdPartyNotices }
      : {}),
    publicMapping: boundary.repositoryId === publicId,
    node: process.version,
    adapter: pins["@opennextjs/cloudflare"],
    wrangler: pins.wrangler,
    runtimeAcceptance: "NOT ESTABLISHED BY BUILD",
    exitCode: result.status,
    errorCode: result.error?.code ?? null,
  };
  if (success && ["build", "dry-run"].includes(options.action))
    evidence.artifactFingerprint = artifactFingerprint(
      options.action === "build" ? nextOutput : bundleDirectory,
    );
  const evidenceBytes = JSON.stringify(evidence, null, 2) + "\n";
  const attemptsDirectory = path.join(evidenceDirectory, "attempts");
  mkdirSync(attemptsDirectory, { recursive: true });
  writeFileSync(
    path.join(
      attemptsDirectory,
      `${startedAt.replaceAll(":", "-")}-${options.target}-${options.action}.json`,
    ),
    evidenceBytes,
  );
  writeFileSync(
    path.join(evidenceDirectory, `${options.target}-${options.action}.json`),
    evidenceBytes,
  );
  if (!success)
    throw new Error(
      "Cloudflare command failed or source changed during verification; inspect SSD-local evidence.",
    );
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(runCloudflareHosting()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Cloudflare hosting command failed.");
    process.exitCode = 1;
  }
}
