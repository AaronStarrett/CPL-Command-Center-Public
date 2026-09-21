import assert from "node:assert/strict";
import test from "node:test";
import { INSTALL_ARGUMENTS, requireSuccessfulCommand } from "../../scripts/cpl-install.mjs";

test("SSD installer pins frozen physical dependency layout without lifecycle scripts", () => {
  for (const flag of [
    "--frozen-lockfile",
    "--ignore-scripts",
    "--config.symlink=false",
    "--config.package-import-method=copy",
  ])
    assert.ok(INSTALL_ARGUMENTS.includes(flag));
  assert.equal(
    INSTALL_ARGUMENTS[INSTALL_ARGUMENTS.indexOf("--store-dir") + 1],
    ".data/tooling/pnpm-store",
  );
});

test("installer fails closed for errors, signals and missing status", () => {
  assert.doesNotThrow(() => requireSuccessfulCommand({ status: 0 }, "fixture"));
  for (const result of [
    { status: null },
    { status: 1 },
    { status: 0, signal: "SIGTERM" },
    { status: 0, error: new Error("fixture") },
  ])
    assert.throws(() => requireSuccessfulCommand(result, "fixture"), /incomplete/);
});
