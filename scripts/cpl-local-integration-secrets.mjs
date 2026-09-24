import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WindowsDpapiCurrentUserProtector } from "./phase134/production-secrets.mjs";
import { assertRepositoryBoundary, REPOSITORY_ID } from "./repository-boundary.mjs";

/** Called only by the owning Windows launcher after the exact synthetic cluster
 * marker is checked. Material is protected for the current Windows user, outside
 * source, and passed only to the local web/worker processes. Never a live grant. */
export function loadLocalIntegrationMaterial({ root, cacheRoot }) {
  assertRepositoryBoundary({ cwd: root, target: root });
  const base = path.join(cacheRoot, "local-development");
  const marker = path.join(base, "owner.json");
  const file = path.join(base, "integration-fixture.dpapi");
  if (process.platform !== "win32" || !/^D:[\\/]/iu.test(base))
    throw new Error("CPL_LOCAL_INTEGRATION_STORAGE_REFUSED");
  for (const candidate of [base, marker, ...(existsSync(file) ? [file] : [])]) {
    if (
      lstatSync(candidate).isSymbolicLink() ||
      realpathSync.native(candidate).toLowerCase() !== path.resolve(candidate).toLowerCase()
    )
      throw new Error("CPL_LOCAL_INTEGRATION_STORAGE_REFUSED");
  }
  const owner = JSON.parse(readFileSync(marker, "utf8"));
  if (
    owner.repositoryId !== REPOSITORY_ID ||
    owner.root !== root ||
    owner.purpose !== "synthetic-local-development" ||
    owner.port !== 55433
  )
    throw new Error("CPL_LOCAL_INTEGRATION_STORAGE_REFUSED");
  const protector = new WindowsDpapiCurrentUserProtector();
  let material;
  try {
    if (existsSync(file)) {
      material = JSON.parse(protector.unprotect(readFileSync(file, "utf8").trim()));
    } else {
      const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      material = {
        version: 1,
        createdAt: new Date().toISOString(),
        purpose: "synthetic-local-integration-fixture",
        repositoryId: REPOSITORY_ID,
        keyVersion: "local-fixture-v1",
        envelopeKey: randomBytes(32).toString("base64url"),
        fixtureSecret: randomBytes(32).toString("base64url"),
        privateJwk: pair.privateKey.export({ format: "jwk" }),
        publicJwk: pair.publicKey.export({ format: "jwk" }),
      };
      writeFileSync(file, protector.protect(JSON.stringify(material)), { flag: "wx", mode: 0o600 });
    }
    if (
      material.version !== 1 ||
      !Number.isFinite(Date.parse(material.createdAt)) ||
      material.purpose !== "synthetic-local-integration-fixture" ||
      material.repositoryId !== REPOSITORY_ID ||
      material.keyVersion !== "local-fixture-v1" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(material.envelopeKey ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/u.test(material.fixtureSecret ?? "") ||
      material.privateJwk?.kty !== "RSA" ||
      !material.privateJwk.d ||
      material.publicJwk?.kty !== "RSA" ||
      material.publicJwk.d ||
      material.privateJwk.n !== material.publicJwk.n ||
      material.privateJwk.e !== material.publicJwk.e
    )
      throw new Error("Invalid local fixture material");
    return JSON.stringify(material);
  } catch {
    // No key, decrypted payload, provider body or DPAPI error is logged.
    throw new Error("CPL_LOCAL_INTEGRATION_MATERIAL_UNAVAILABLE");
  }
}
