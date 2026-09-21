import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { installBuildReadlinkCompatibility } from "../../scripts/next-build-filesystem.mjs";

const root = path.resolve(".");
const candidate = path.join(root, ".next", "server", "entry.js");
const stats = (kind) => ({
  isFile: () => kind === "file",
  isDirectory: () => kind === "directory",
  isSymbolicLink: () => kind === "link",
});
const failure = (code = "EISDIR") => Object.assign(new Error("filesystem failure"), { code });

for (const kind of ["file", "directory"]) {
  test("Windows build normalizes proven ordinary " + kind, async () => {
    const originalError = failure();
    const fileSystem = {
      readlink: async () => {
        throw originalError;
      },
      lstat: async () => stats(kind),
    };
    const original = fileSystem.readlink;
    const restore = installBuildReadlinkCompatibility({
      command: "build",
      platform: "win32",
      fileSystem,
      root,
    });
    await assert.rejects(
      fileSystem.readlink(candidate),
      (error) => error.code === "EINVAL" && error.cause === originalError,
    );
    restore();
    assert.equal(fileSystem.readlink, original);
  });
}

for (const scenario of ["link", "unknown", "stat-failure", "outside", "access-denied"]) {
  test("preserves real filesystem failure: " + scenario, async () => {
    const error = failure(scenario === "access-denied" ? "EACCES" : "EISDIR");
    let inspections = 0;
    const fileSystem = {
      readlink: async () => {
        throw error;
      },
      lstat: async () => {
        inspections += 1;
        if (scenario === "stat-failure") throw failure("EACCES");
        return stats(scenario === "outside" || scenario === "access-denied" ? "file" : scenario);
      },
    };
    installBuildReadlinkCompatibility({ command: "build", platform: "win32", fileSystem, root });
    await assert.rejects(
      fileSystem.readlink(scenario === "outside" ? path.resolve(root, "..", "outside") : candidate),
      (actual) => actual === error,
    );
    if (scenario === "outside" || scenario === "access-denied") assert.equal(inspections, 0);
  });
}

test("valid link target and options pass through unchanged", async () => {
  const fileSystem = {
    readlink: async (value, options) => {
      assert.equal(value, candidate);
      assert.deepEqual(options, { encoding: "buffer" });
      return Buffer.from("target");
    },
    lstat: async () => {
      throw new Error("must not inspect successful links");
    },
  };
  installBuildReadlinkCompatibility({ command: "build", platform: "win32", fileSystem, root });
  assert.deepEqual(
    await fileSystem.readlink(candidate, { encoding: "buffer" }),
    Buffer.from("target"),
  );
});

for (const [command, platform] of [
  ["dev", "win32"],
  ["start", "win32"],
  ["build", "linux"],
]) {
  test("does not patch " + command + " on " + platform, () => {
    const fileSystem = { readlink: async () => "target" };
    const original = fileSystem.readlink;
    installBuildReadlinkCompatibility({ command, platform, fileSystem, root });
    assert.equal(fileSystem.readlink, original);
  });
}
