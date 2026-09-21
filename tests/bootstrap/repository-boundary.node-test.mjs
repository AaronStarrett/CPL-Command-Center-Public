import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTHORIZED_REPOSITORY,
  FORBIDDEN_REPOSITORIES,
  REPOSITORY_ID,
  assertPathBoundary,
  assertRepositoryBoundary,
  isPathWithin,
  targetForEnvironment,
  validateRepositoryIdentity,
} from "../../scripts/repository-boundary.mjs";

const target = AUTHORIZED_REPOSITORY;
const publicExport = REPOSITORY_ID === 1380072423;
const validEvidence = () => ({
  target,
  gitRoot: target,
  gitDirectory: target + "/.git",
  commonDirectory: target + "/.git",
  marker: { schemaVersion: 1, repositoryId: REPOSITORY_ID, owner: "AaronStarrett" },
  originUrls: [
    publicExport
      ? "https://github.com/AaronStarrett/CPL-Command-Center-Public.git"
      : "https://github.com/AaronStarrett/BEA-Automation-Command-Center.git",
  ],
  pushUrls: [
    publicExport
      ? "https://github.com/AaronStarrett/CPL-Command-Center-Public.git"
      : "https://github.com/AaronStarrett/CPL-Command-Center.git",
  ],
});

for (const cwd of [target, target + "/packages/database", target.toLowerCase()]) {
  test("pure path policy accepts authorized Windows location: " + cwd, () => {
    assert.ok(isPathWithin(assertPathBoundary({ cwd, target }).current, target));
  });
}
for (const cloud of publicExport
  ? ["/workspace/CPL-Command-Center-Public", "/workspaces/CPL-Command-Center-Public"]
  : [
      "/workspace/BEA-Automation-Command-Center",
      "/workspace/CPL-Command-Center",
      "/workspaces/BEA-Automation-Command-Center",
      "/workspaces/CPL-Command-Center",
    ]) {
  test("pure cloud path policy requires exact allowed root: " + cloud, () => {
    assert.equal(assertPathBoundary({ cwd: cloud + "/scripts", target: cloud }).target, cloud);
    assert.equal(targetForEnvironment({ BEA_REPOSITORY_ROOT: cloud }), cloud);
  });
}
for (const cwd of ["C:/Unrelated", target + "-copy", "D:/CPL-Dev/BEA-Automation-Command-Center"]) {
  test("unrelated checkout refused: " + cwd, () => {
    assert.throws(() => assertPathBoundary({ cwd, target }), /outside the authorized checkout/u);
    assert.throws(
      () => assertRepositoryBoundary({ cwd, target }),
      /outside the authorized checkout/u,
    );
  });
}
for (const forbidden of FORBIDDEN_REPOSITORIES) {
  test("protected repository refused without filesystem reads: " + forbidden, () => {
    const resolvePath = () => assert.fail("must reject before resolving protected path");
    assert.throws(
      () => assertPathBoundary({ cwd: forbidden, target, resolvePath }),
      /protected CPL/u,
    );
    assert.throws(
      () => assertPathBoundary({ cwd: target, target: forbidden, resolvePath }),
      /protected CPL/u,
    );
  });
}
for (const personal of [
  "C:/Users/SyntheticOwner/OneDrive/Documents/ChatGPT/CPL Command Center",
  "d:\\USERS\\AnotherOwner\\OneDrive\\Documents\\ChatGPT\\CPL Command Center\\packages",
]) {
  test("any-account personal repository denied without filesystem reads: " + personal, () => {
    const resolvePath = () => assert.fail("must reject before resolving protected path");
    assert.throws(
      () => assertPathBoundary({ cwd: personal, target, resolvePath }),
      /protected CPL/u,
    );
    assert.throws(
      () => assertPathBoundary({ cwd: target, target: personal, resolvePath }),
      /protected CPL/u,
    );
  });
}

test("resolved root and child paths retain the any-account personal repository denial", () => {
  const cwd = target + "/scripts";
  const personal = "C:/Users/SyntheticOwner/OneDrive/Documents/ChatGPT/CPL Command Center";
  for (const redirected of [cwd, target]) {
    assert.throws(
      () =>
        assertPathBoundary({
          cwd,
          target,
          resolvePath: (candidate) => (candidate === redirected ? personal : candidate),
        }),
      /protected CPL/u,
    );
  }
});

for (const invalid of [
  target + "/../Other",
  "relative/path",
  "D:relative",
  "/workspace/cpl-command-center",
  "/workspace/Other",
  "/tmp/CPL-Command-Center",
]) {
  test("invalid target refused even with fake CI: " + invalid, () => {
    assert.throws(() => targetForEnvironment({ CI: "true", BEA_REPOSITORY_ROOT: invalid }));
    assert.throws(() => assertPathBoundary({ cwd: invalid, target: invalid }));
  });
}
test("traversal in cwd is refused even if it would normalize inside the checkout", () => {
  assert.throws(() => assertPathBoundary({ cwd: target + "/packages/..", target }), /traversal/u);
});
test("Linux paths remain case-sensitive", () => {
  assert.equal(
    isPathWithin("/workspace/CPL-Command-Center", "/workspace/cpl-command-center"),
    false,
  );
});
test("injected resolver rejects redirected root and nested link", () => {
  assert.throws(
    () => assertPathBoundary({ cwd: target, target, resolvePath: () => "D:/Other/Repo" }),
    /redirected/u,
  );
  const cwd = target + "/packages";
  assert.throws(
    () =>
      assertPathBoundary({ cwd, target, resolvePath: (p) => (p === cwd ? "D:/Other/Repo" : p) }),
    /redirected/u,
  );
  assert.throws(
    () =>
      assertPathBoundary({
        cwd,
        target,
        resolvePath: (p) => (p === cwd ? FORBIDDEN_REPOSITORIES[0] : p),
      }),
    /protected CPL/u,
  );
});
test("valid independently collected evidence accepts the authorized GitHub identity", () => {
  assert.doesNotThrow(() => validateRepositoryIdentity(validEvidence()));
  if (publicExport) {
    for (const name of ["BEA-Automation-Command-Center", "CPL-Command-Center"]) {
      assert.throws(
        () =>
          validateRepositoryIdentity({
            ...validEvidence(),
            originUrls: ["https://github.com/AaronStarrett/" + name + ".git"],
          }),
        /origin is not/u,
      );
    }
  }
});
for (const marker of [
  null,
  {},
  { schemaVersion: 1, repositoryId: 1, owner: "AaronStarrett" },
  { schemaVersion: 1, repositoryId: REPOSITORY_ID, owner: "DifferentOwner" },
]) {
  test("invalid stable identity marker refused: " + JSON.stringify(marker), () => {
    assert.throws(
      () => validateRepositoryIdentity({ ...validEvidence(), marker }),
      /identity marker mismatch/u,
    );
  });
}
test("nested Git root and external Git metadata refused", () => {
  assert.throws(
    () => validateRepositoryIdentity({ ...validEvidence(), gitRoot: target + "/nested" }),
    /Git root/u,
  );
  assert.throws(
    () => validateRepositoryIdentity({ ...validEvidence(), gitDirectory: "D:/Outside/.git" }),
    /Git metadata/u,
  );
  assert.throws(
    () => validateRepositoryIdentity({ ...validEvidence(), commonDirectory: "D:/Outside/.git" }),
    /Git metadata/u,
  );
});
for (const originUrls of [
  [],
  ["https://github.com/Other/CPL-Command-Center.git"],
  ["https://github.com/AaronStarrett/Cyber-Pirate-Labs.git"],
  ["https://example.com/AaronStarrett/CPL-Command-Center.git"],
  ["https://github.com/AaronStarrett/CPL-Command-Center.git", "https://example.com/other.git"],
]) {
  test("unapproved or ambiguous origin refused: " + originUrls.length + " " + originUrls[0], () => {
    assert.throws(
      () => validateRepositoryIdentity({ ...validEvidence(), originUrls }),
      /origin is not/u,
    );
    assert.throws(
      () => validateRepositoryIdentity({ ...validEvidence(), pushUrls: originUrls }),
      /origin is not/u,
    );
  });
}
test("rejected URL diagnostics never disclose embedded credentials", () => {
  const credential = "fake-sensitive-value-for-redaction-test";
  assert.throws(
    () =>
      validateRepositoryIdentity({
        ...validEvidence(),
        originUrls: ["https://" + credential + "@github.com/AaronStarrett/CPL-Command-Center.git"],
      }),
    (error) => !error.message.includes(credential),
  );
});
test("live guard gathers real checkout identity and ignores injected Git environment", () => {
  const previous = process.env.GIT_WORK_TREE;
  try {
    process.env.GIT_WORK_TREE = "D:/NeverReadThisUnrelatedPath";
    const result = assertRepositoryBoundary();
    assert.equal(result.repositoryId, REPOSITORY_ID);
    assert.equal(result.identity, "local-marker-and-git-origin-verified");
    assert.equal(result.protectedRepositoryEntered, false);
  } finally {
    if (previous === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = previous;
  }
});

test("live nested web cwd uses the authorized checkout safe.directory on exFAT", () => {
  const target = targetForEnvironment();
  const result = assertRepositoryBoundary({ cwd: target + "/apps/web", target });
  assert.equal(result.repositoryId, REPOSITORY_ID);
  assert.equal(result.gitRoot, result.target);
  assert.equal(result.identity, "local-marker-and-git-origin-verified");
});
