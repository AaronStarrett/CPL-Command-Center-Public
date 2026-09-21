import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  primeNextEnvironment,
  resolveNextEnvironmentModule,
  runNextWithoutRepositoryEnv,
  safeNextLaunchDiagnostic,
} from "../../scripts/next-no-env.mjs";

const require = createRequire(import.meta.url);
const nodeFs = require("node:fs");
const cleanupDirectories = [];
const testPath = fileURLToPath(import.meta.url);
const expectedRepositoryRoot = path.resolve(path.dirname(testPath), "..", "..");

function successfulLaunchOptions(overrides = {}) {
  return {
    environment: { BEA_DISABLE_ENV_FILE: "true" },
    assertBoundary() {},
    createWebRequire() {
      return {
        resolve() {
          return path.join(tmpdir(), "next-cli.js");
        },
      };
    },
    primeEnvironment() {
      return { remove() {} };
    },
    async importNextCli() {},
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0).reverse()) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Next authoritative env-file preload", () => {
  it("primes the same @next/env singleton against an empty directory before repository loading", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bea-next-env-test-"));
    cleanupDirectories.push(root);
    const safeDirectory = path.join(root, "empty");
    const projectDirectory = path.join(root, "project");
    nodeFs.mkdirSync(safeDirectory);
    nodeFs.mkdirSync(projectDirectory);
    const sentinelFile = path.join(projectDirectory, ".env.local");
    const sentinelName = "BEA_NEXT_ENV_SENTINEL";
    writeFileSync(sentinelFile, `${sentinelName}=must-not-load\n`, "utf8");

    const environmentModule = resolveNextEnvironmentModule();
    environmentModule.resetEnv();
    delete process.env[sentinelName];
    const originalStatSync = nodeFs.statSync;
    let sentinelTouches = 0;
    nodeFs.statSync = function guardedStatSync(candidate, ...args) {
      if (path.resolve(String(candidate)) === path.resolve(sentinelFile)) {
        sentinelTouches += 1;
        throw Object.assign(new Error("sentinel env path touched"), { code: "EACCES" });
      }
      return originalStatSync.call(this, candidate, ...args);
    };
    try {
      primeNextEnvironment({ environmentModule, safeDirectory });
      const second = environmentModule.loadEnvConfig(projectDirectory, false, console, false);
      expect(second.loadedEnvFiles).toEqual([]);
      expect(sentinelTouches).toBe(0);
      expect(process.env[sentinelName]).toBeUndefined();
    } finally {
      nodeFs.statSync = originalStatSync;
      environmentModule.resetEnv();
      delete process.env[sentinelName];
    }
  });

  it.each([
    ["an omitted repository-root variable", { BEA_DISABLE_ENV_FILE: "true", CI: "true" }],
    [
      "a misleading repository-root variable",
      {
        BEA_DISABLE_ENV_FILE: "true",
        BEA_REPOSITORY_ROOT: "D:\\not-the-hosted-checkout",
        CI: "true",
      },
    ],
  ])("uses the launcher-derived repository root with %s", async (_label, environment) => {
    let boundaryTarget;

    await runNextWithoutRepositoryEnv(
      ["typegen"],
      successfulLaunchOptions({
        environment,
        assertBoundary({ target }) {
          boundaryTarget = target;
        },
      }),
    );

    expect(boundaryTarget).toBe(expectedRepositoryRoot);
  });

  it.each([
    [
      "boundary",
      "PERMISSION_DENIED",
      {
        assertBoundary() {
          throw Object.assign(new Error("sensitive boundary path"), { code: "EPERM" });
        },
      },
    ],
    [
      "resolve-next-cli",
      "MODULE_NOT_FOUND",
      {
        createWebRequire() {
          throw Object.assign(new TypeError("sensitive module path"), {
            code: "ERR_MODULE_NOT_FOUND",
          });
        },
      },
    ],
    [
      "prime-next-environment",
      "ACCESS_DENIED",
      {
        primeEnvironment() {
          throw Object.assign(new Error("sensitive temporary path"), { code: "EACCES" });
        },
      },
    ],
    [
      "import-next-cli",
      "MODULE_NOT_FOUND",
      {
        async importNextCli() {
          throw Object.assign(new TypeError("sensitive import path"), {
            code: "ERR_MODULE_NOT_FOUND",
          });
        },
      },
    ],
    [
      "cleanup-next-environment",
      "RESOURCE_BUSY",
      {
        primeEnvironment() {
          return {
            remove() {
              throw Object.assign(new Error("sensitive cleanup path"), { code: "EBUSY" });
            },
          };
        },
      },
    ],
  ])(
    "reports the %s launcher stage without sensitive failure details",
    async (stage, category, overrides) => {
      let failure;
      try {
        await runNextWithoutRepositoryEnv([], successfulLaunchOptions(overrides));
      } catch (error) {
        failure = error;
      }

      const diagnostic = safeNextLaunchDiagnostic(failure);
      expect(Object.keys(diagnostic)).toEqual(["code", "message", "stage", "category"]);
      expect(diagnostic.stage).toBe(stage);
      expect(diagnostic.category).toBe(category);
      expect(JSON.stringify(diagnostic)).not.toContain("sensitive");
      expect(diagnostic).not.toHaveProperty("errorName");
      expect(diagnostic).not.toHaveProperty("errorCode");
      expect(diagnostic).not.toHaveProperty("path");
      expect(diagnostic).not.toHaveProperty("stack");
    },
  );

  it("normalizes untrusted error metadata instead of printing it", async () => {
    const untrusted = Object.assign(new Error("C:\\private\\secret.env"), {
      code: "ERR_BAD C:\\private\\secret.env",
      name: "Error C:\\private\\secret.env",
      path: "C:\\private\\secret.env",
    });
    let failure;
    try {
      await runNextWithoutRepositoryEnv(
        [],
        successfulLaunchOptions({
          async importNextCli() {
            throw untrusted;
          },
        }),
      );
    } catch (error) {
      failure = error;
    }

    expect(safeNextLaunchDiagnostic(failure)).toEqual({
      code: "BEA_NEXT_LAUNCH_FAILED",
      message: "Next launch failed safely.",
      stage: "import-next-cli",
      category: "UNCLASSIFIED",
    });
  });

  it("preserves successful launch ordering and cleans the primed environment once", async () => {
    const stages = [];
    const result = await runNextWithoutRepositoryEnv(
      ["typegen"],
      successfulLaunchOptions({
        assertBoundary() {
          stages.push("boundary");
        },
        createWebRequire() {
          stages.push("create-require");
          return {
            resolve() {
              stages.push("resolve-next");
              return path.join(tmpdir(), "next-cli.js");
            },
          };
        },
        primeEnvironment() {
          stages.push("prime-environment");
          return {
            remove() {
              stages.push("cleanup-environment");
            },
          };
        },
        async importNextCli() {
          stages.push("import-next");
        },
      }),
    );

    expect(result).toEqual(["typegen"]);
    expect(stages).toEqual([
      "boundary",
      "create-require",
      "resolve-next",
      "prime-environment",
      "import-next",
      "cleanup-environment",
    ]);
  });

  it("preserves the primary import stage when cleanup also fails", async () => {
    let failure;
    try {
      await runNextWithoutRepositoryEnv(
        [],
        successfulLaunchOptions({
          primeEnvironment() {
            return {
              remove() {
                throw Object.assign(new Error("secondary sensitive cleanup path"), {
                  code: "EBUSY",
                });
              },
            };
          },
          async importNextCli() {
            throw Object.assign(new Error("primary sensitive import path"), {
              code: "ERR_MODULE_NOT_FOUND",
            });
          },
        }),
      );
    } catch (error) {
      failure = error;
    }

    expect(safeNextLaunchDiagnostic(failure)).toEqual({
      code: "BEA_NEXT_LAUNCH_FAILED",
      message: "Next launch failed safely.",
      stage: "import-next-cli",
      category: "MODULE_NOT_FOUND",
    });
  });
});
