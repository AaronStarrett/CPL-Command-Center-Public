import assert from "node:assert/strict";
import path from "node:path";
import { statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createPrecommitEnvironment,
  runPrecommitStep,
  runPrecommitVerification,
} from "../../scripts/pre-commit-verify.mjs";
import { createControlServer, runtimePaths, startLocal } from "../../scripts/cpl-local.mjs";
import { REPOSITORY_ID } from "../../scripts/repository-boundary.mjs";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const windows = process.platform === "win32";
const storageKeys = [
  "TEMP",
  "TMP",
  "TMPDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "HOME",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "COREPACK_HOME",
  "PNPM_HOME",
  "npm_config_cache",
  "npm_config_store_dir",
  "PLAYWRIGHT_BROWSERS_PATH",
];
const hostile = Object.fromEntries(storageKeys.map((key) => [key, "C:\\untrusted-cache"]));
hostile.BEA_REPOSITORY_ROOT = "C:\\untrusted-checkout";
hostile.CPL_REPOSITORY_ROOT = "C:\\untrusted-checkout";
hostile.OPENAI_API_KEY = "synthetic-key";
hostile.NODE_OPTIONS = "--import=untrusted-loader";

test(
  "Windows precommit overrides inherited C storage paths and checkout identity",
  { skip: !windows },
  () => {
    const environment = createPrecommitEnvironment(hostile);
    const paths = runtimePaths(root);
    for (const key of storageKeys) {
      assert.ok(environment[key].startsWith("D:\\Cyber Pirate Labs\\"), key);
      assert.equal(environment[key].includes("untrusted"), false, key);
    }
    assert.equal(environment.TEMP, paths.temp);
    assert.equal(
      environment.npm_config_store_dir,
      path.join(root, ".data", "tooling", "pnpm-store"),
    );
    assert.equal(environment.BEA_REPOSITORY_ROOT, root);
    assert.equal(environment.CPL_REPOSITORY_ROOT, root);
    assert.equal(environment.APP_MODE, "demo");
    assert.equal(environment.NODE_ENV, "test");
    assert.equal(environment.BEA_RUNTIME_MODE, "development");
    assert.equal(environment.BEA_DISABLE_ENV_FILE, "true");
    assert.equal(environment.OPENAI_API_KEY, "");
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.Path.split(path.delimiter)[0], path.dirname(process.execPath));
    assert.equal(environment.PATH, undefined);
  },
);

test("explicit step environment cannot bypass SSD storage overrides", { skip: !windows }, () => {
  let observed;
  runPrecommitStep("storage-contract", process.execPath, ["--version"], {
    environment: hostile,
    spawnSync: (_command, _args, options) => {
      observed = options.env;
      return { status: 0 };
    },
  });
  assert.equal(observed.TEMP, runtimePaths(root).temp);
  assert.equal(observed.BEA_REPOSITORY_ROOT, root);
});

test(
  "precommit and duplicate Start refuse an active launcher before dependency mutation",
  { skip: !windows },
  async () => {
    const control = createControlServer({
      pipe: runtimePaths(root).pipe,
      token: "a".repeat(64),
      status: () => ({ repositoryId: REPOSITORY_ID, root }),
      stop: async () => {},
    });
    await control.listen();
    try {
      const manifestPath = path.join(root, ".data", "cpl-local", "workspace-copies.json");
      const before = statSync(manifestPath).mtimeMs;
      await assert.rejects(
        runPrecommitVerification({ environment: hostile }),
        /launcher is active/u,
      );
      await assert.rejects(startLocal(), /already owns this checkout/u);
      assert.equal(statSync(manifestPath).mtimeMs, before);
    } finally {
      await new Promise((resolve) => control.server.close(resolve));
    }
  },
);
