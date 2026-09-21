import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  REQUIRED_DEPLOYMENT_FILES,
  validateDeploymentScaffolding,
} from "../../scripts/validate-deployment-scaffolding.mjs";

const repositoryRoot = new URL("../../", import.meta.url);
const repositoryPath = fileURLToPath(repositoryRoot);

function deploymentFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "bea-phase135-deployment-"));
  for (const relativePath of REQUIRED_DEPLOYMENT_FILES) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(repositoryPath, relativePath), destination);
  }
  return root;
}

describe("Phase 1.3.5 provider-neutral deployment scaffolding", () => {
  it("passes semantic validation without mandatory Azure infrastructure", () => {
    const result = validateDeploymentScaffolding(repositoryRoot);
    expect(result).toMatchObject({
      code: "BEA_DEPLOYMENT_SCAFFOLDING_OK",
      ok: true,
      providerNeutral: true,
    });
    expect(result.findings).toEqual([]);
  });

  it("keeps optional auth and destructive R2 lifecycle disabled", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../infra/deployment/manifest.example.json", import.meta.url),
        "utf8",
      ),
    );
    const r2 = JSON.parse(
      readFileSync(new URL("../../infra/r2/r2.example.json", import.meta.url), "utf8"),
    );
    const supabase = readFileSync(
      new URL("../../infra/supabase/config.example.toml", import.meta.url),
      "utf8",
    );
    expect(manifest.providers.auth).not.toBe("supabase-auth");
    expect(manifest.providers.optionalAuthAdapter).toBe("supabase-auth");
    expect(manifest.runtime.adapterImplemented).toBe(false);
    expect(r2.lifecycle.every((rule) => rule.enabled === false)).toBe(true);
    expect(supabase.replaceAll("\r\n", "\n")).toContain("[auth]\nenabled = false");
  });

  it("returns structured findings for malformed required JSON", () => {
    const root = deploymentFixture();
    try {
      writeFileSync(path.join(root, "infra/deployment/manifest.example.json"), "{");
      const result = validateDeploymentScaffolding(root);
      expect(result.ok).toBe(false);
      expect(result.findings).toContain("invalid-json:infra/deployment/manifest.example.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires every runtime-facing variable in the actual JSON Schema", () => {
    const root = deploymentFixture();
    try {
      const schemaPath = path.join(root, "infra/deployment/environment.schema.json");
      const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
      schema.required = schema.required.filter((key) => key !== "WORKER_QUEUE_ADAPTER");
      writeFileSync(schemaPath, JSON.stringify(schema));
      const result = validateDeploymentScaffolding(root);
      expect(result.findings).toContain("runtime-variables-not-schema-required");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not accept safety directives hidden in Docker comments", () => {
    const root = deploymentFixture();
    try {
      const dockerfile = path.join(root, "infra/docker/Dockerfile.web");
      writeFileSync(
        dockerfile,
        readFileSync(dockerfile, "utf8").replace("USER node", "# USER node"),
      );
      const result = validateDeploymentScaffolding(root);
      expect(result.findings).toContain("container-runs-as-root:infra/docker/Dockerfile.web");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates only the final runtime stage and its health command", () => {
    const root = deploymentFixture();
    try {
      const dockerfile = path.join(root, "infra/docker/Dockerfile.web");
      const original = readFileSync(dockerfile, "utf8").replaceAll("\r\n", "\n");
      writeFileSync(
        dockerfile,
        original
          .replace("USER node\nCMD", "USER root\nCMD")
          .replace(
            'CMD node -e "const p=process.env.PORT||3000;',
            '# process.env.PORT||3000\n  CMD node -e "const p=3000;',
          ),
      );
      const result = validateDeploymentScaffolding(root);
      expect(result.findings).toContain("container-runs-as-root:infra/docker/Dockerfile.web");
      expect(result.findings).toContain("web-port-hardcoded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
