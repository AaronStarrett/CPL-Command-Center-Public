import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertRepositoryBoundary } from "./repository-boundary.mjs";

const boundary = assertRepositoryBoundary();
const manifest = JSON.parse(
  readFileSync(path.join(boundary.target, "PUBLIC_EXPORT_MANIFEST.json"), "utf8"),
);
const assets = manifest.files.filter((file) => /\.(png|svg|ico)$/u.test(file.path));
if (assets.length === 0) throw new Error("Public asset manifest is empty.");
for (const asset of assets) {
  const actual = createHash("sha256")
    .update(readFileSync(path.join(boundary.target, asset.path)))
    .digest("hex");
  if (actual !== asset.sha256)
    throw new Error("Public source asset integrity failed: " + asset.path);
}
process.stdout.write(
  JSON.stringify({ code: "CPL_PUBLIC_SOURCE_INTEGRITY_OK", assets: assets.length, ok: true }) +
    "\n",
);
