import { describe, expect, it } from "vitest";

import {
  AUTHORIZED_REPOSITORY,
  FORBIDDEN_REPOSITORIES,
  REPOSITORY_ID,
  assertPathBoundary,
  assertRepositoryBoundary,
  isPathWithin,
  targetForEnvironment,
} from "../../scripts/repository-boundary.mjs";

// Pure path-policy tests do not claim that a synthetic path is a verified checkout.
const target = AUTHORIZED_REPOSITORY;

describe("repository boundary guard", () => {
  it("accepts the exact authorized path and its children in the pure path policy", () => {
    expect(assertPathBoundary({ cwd: target, target }).target).toBe(target);
    expect(
      isPathWithin(
        assertPathBoundary({ cwd: target + "/packages/database", target }).current,
        target,
      ),
    ).toBe(true);
  });

  it("rejects unrelated directories and prefix lookalikes", () => {
    for (const cwd of ["C:/Users/Example/Desktop", target + "-other"]) {
      expect(() => assertPathBoundary({ cwd, target })).toThrow(/outside the authorized checkout/u);
    }
  });

  it("rejects every protected CPL repository", () => {
    for (const forbidden of FORBIDDEN_REPOSITORIES) {
      expect(() => assertPathBoundary({ cwd: forbidden + "/packages", target })).toThrow(
        /protected CPL/u,
      );
    }
  });

  it("rejects the protected personal repository for any Windows account before resolution", () => {
    const resolvePath = () => {
      throw new Error("Protected paths must not be read.");
    };
    for (const personal of [
      "C:/Users/Example/OneDrive/Documents/ChatGPT/CPL Command Center",
      "d:\\USERS\\AlternateOwner\\OneDrive\\Documents\\ChatGPT\\CPL Command Center\\packages",
    ]) {
      expect(() => assertPathBoundary({ cwd: personal, target, resolvePath })).toThrow(
        /protected CPL/u,
      );
      expect(() => assertPathBoundary({ cwd: target, target: personal, resolvePath })).toThrow(
        /protected CPL/u,
      );
    }
  });

  it("rejects resolved paths into another account's protected personal repository", () => {
    const personal = "D:/Users/AnotherOwner/OneDrive/Documents/ChatGPT/CPL Command Center";
    const cwd = target + "/packages";
    for (const redirected of [cwd, target]) {
      expect(() =>
        assertPathBoundary({
          cwd,
          target,
          resolvePath: (candidate) => (candidate === redirected ? personal : candidate),
        }),
      ).toThrow(/protected CPL/u);
    }
  });

  it("rejects arbitrary targets even when target and cwd match", () => {
    const unrelated = "D:/Unrelated/CPL-Command-Center";
    expect(() => assertPathBoundary({ cwd: unrelated, target: unrelated })).toThrow(
      /not an authorized checkout/u,
    );
  });

  it("rejects misleading redirected paths through an explicit test resolver", () => {
    expect(() =>
      assertPathBoundary({ cwd: target, target, resolvePath: () => "D:/Other/Checkout" }),
    ).toThrow(/redirected/u);
  });

  it("does not let CI authorize arbitrary or protected checkout roots", () => {
    expect(() =>
      targetForEnvironment({ CI: "true", BEA_REPOSITORY_ROOT: "C:/BoundaryFixtures/Repo" }),
    ).toThrow(/arbitrary checkout/u);
    expect(targetForEnvironment({ CI: "false", BEA_REPOSITORY_ROOT: target })).toBe(target);
  });

  it("requires real local identity evidence independently of the path-policy seam", () => {
    const result = assertRepositoryBoundary();
    expect(result.repositoryId).toBe(REPOSITORY_ID);
    expect(result.identity).toBe("local-marker-and-git-origin-verified");
    expect(result.protectedRepositoryEntered).toBe(false);
  });
});
