import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertUnredirectedPath } from "./publication-export.mjs";

/** Copies only Next's identity-free prerendered workspace HTML, unchanged.
 * Called after the real build/cache population and before artifact hashing. */
export function prepareHostedWorkspaceAsset(repositoryRoot) {
  const app = path.join(repositoryRoot, "apps", "web");
  const output = path.join(app, ".open-next");
  for (const directory of [path.join(app, ".next"), output])
    assertUnredirectedPath(directory, repositoryRoot);
  const buildFile = path.join(app, ".next", "BUILD_ID");
  assertUnredirectedPath(buildFile, repositoryRoot);
  const buildId = readFileSync(buildFile, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(buildId)) throw new Error("Invalid Next build ID.");
  const cacheFile = path.join(output, "cache", buildId, "workspace.cache");
  const htmlFile = path.join(app, ".next", "server", "app", "workspace.html");
  for (const file of [cacheFile, htmlFile]) assertUnredirectedPath(file, repositoryRoot);
  const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
  if (cached.type !== "app" || typeof cached.html !== "string" || !cached.html)
    throw new Error("Prerendered workspace cache is required.");
  const bytes = Buffer.from(cached.html, "utf8");
  const generated = readFileSync(htmlFile);
  if (!bytes.equals(generated)) throw new Error("Workspace HTML and cache bytes disagree.");
  const workspaceAsset = `/cdn-cgi/cpl-shell/${buildId}/workspace.html`;
  const destination = path.join(output, "assets", workspaceAsset.slice(1));
  assertUnredirectedPath(destination, repositoryRoot);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
  const descriptor = {
    buildId,
    workspaceAsset,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  writeFileSync(
    path.join(output, "cpl-shell.mjs"),
    `// Generated from the exact Next prerender. No identity or runtime data.\nexport const workspaceAsset = ${JSON.stringify(workspaceAsset)};\n`,
  );
  writeFileSync(path.join(output, "cpl-shell.json"), JSON.stringify(descriptor, null, 2) + "\n");
  return descriptor;
}
