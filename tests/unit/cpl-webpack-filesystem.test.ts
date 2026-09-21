import { lstat, readFile, readFileSync, readlink, stat } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  DirectoryReadCompatibilityPlugin,
  normalizeDirectoryReadErrors,
  normalizeNonLinkErrors,
} from "../../apps/web/lib/webpack-directory-read";
import nextConfig from "../../apps/web/next.config";

type InputFileSystem = Parameters<typeof normalizeDirectoryReadErrors>[0];
type LinkFileSystem = Parameters<typeof normalizeNonLinkErrors>[0];

it("transpiles all web workspace dependencies when exFAT installs physical source copies", () => {
  const visited = new Set<string>();
  function visit(manifestUrl: URL) {
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (!name.startsWith("@bea/") || visited.has(name)) continue;
      visited.add(name);
      visit(
        new URL("../../packages/" + name.slice("@bea/".length) + "/package.json", import.meta.url),
      );
    }
  }
  visit(new URL("../../apps/web/package.json", import.meta.url));
  expect(visited.size).toBeGreaterThan(0);
  for (const name of visited) {
    expect(nextConfig.transpilePackages, name).toContain(name);
    expect(nextConfig.serverExternalPackages ?? [], name).not.toContain(name);
  }
});

describe("webpack Windows directory read compatibility", () => {
  it("normalizes EINVAL only after confirming that the path is a directory", async () => {
    const originalError = Object.assign(new Error("invalid argument"), { code: "EINVAL" });
    const fileSystem = {
      readFile: vi.fn<InputFileSystem["readFile"]>((_path, callback) => callback(originalError)),
      stat: vi.fn<InputFileSystem["stat"]>((_path, callback) =>
        callback(null, { isDirectory: () => true }),
      ),
    };
    normalizeDirectoryReadErrors(fileSystem);
    const result = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      fileSystem.readFile("directory", (error: NodeJS.ErrnoException | null) => resolve(error));
    });
    expect(result?.code).toBe("EISDIR");
    expect(originalError.code).toBe("EINVAL");
    expect(fileSystem.stat).toHaveBeenCalledTimes(1);
  });

  it.each(["file", "stat-error"])("retains the original EINVAL for %s", async (kind) => {
    const originalError = Object.assign(new Error("invalid argument"), { code: "EINVAL" });
    const fileSystem = {
      readFile: vi.fn<InputFileSystem["readFile"]>((_path, callback) => callback(originalError)),
      stat: vi.fn<InputFileSystem["stat"]>((_path, callback) =>
        callback(kind === "stat-error" ? new Error("unavailable") : null, {
          isDirectory: () => false,
        }),
      ),
    };
    normalizeDirectoryReadErrors(fileSystem);
    const result = await new Promise((resolve) => fileSystem.readFile("file", resolve));
    expect(result).toBe(originalError);
  });

  it("preserves successful file content and unrelated read failures without stat calls", () => {
    const data = Buffer.from("source-content");
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    const fileSystem = {
      readFile: vi.fn<InputFileSystem["readFile"]>((path, callback) =>
        callback(path === "source" ? null : error, data),
      ),
      stat: vi.fn<InputFileSystem["stat"]>(),
    };
    normalizeDirectoryReadErrors(fileSystem);
    const callback = vi.fn();
    fileSystem.readFile("source", callback);
    expect(callback).toHaveBeenLastCalledWith(null, data);
    fileSystem.readFile("denied", callback);
    expect(callback).toHaveBeenLastCalledWith(error, data);
    expect(fileSystem.stat).not.toHaveBeenCalled();
  });

  it("does not wrap a shared compiler filesystem more than once", () => {
    const fileSystem = { readFile: vi.fn(), stat: vi.fn() };
    normalizeDirectoryReadErrors(fileSystem);
    const normalized = fileSystem.readFile;
    normalizeDirectoryReadErrors(fileSystem);
    expect(fileSystem.readFile).toBe(normalized);
  });

  it("adapts cache reads without replacing the shared intermediate filesystem methods", () => {
    const sharedFileSystem = { readFile: vi.fn(), stat: vi.fn() };
    const originalReadFile = sharedFileSystem.readFile;
    const compiler = {
      inputFileSystem: { readFile: vi.fn(), stat: vi.fn() },
      intermediateFileSystem: sharedFileSystem,
    };
    new DirectoryReadCompatibilityPlugin().apply(compiler);
    expect(compiler.intermediateFileSystem).not.toBe(sharedFileSystem);
    expect(compiler.intermediateFileSystem.readFile).not.toBe(originalReadFile);
    expect(sharedFileSystem.readFile).toBe(originalReadFile);
  });

  it("lets the real filesystem identify the checkout directory for webpack hashing", async () => {
    const fileSystem = { readFile, stat };
    normalizeDirectoryReadErrors(fileSystem);
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      fileSystem.readFile(process.cwd(), (error) => resolve(error));
    });
    expect(error?.code).toBe("EISDIR");
  });
});

describe("webpack Windows readlink compatibility", () => {
  it.each(["file", "directory"])(
    "normalizes EISDIR after lstat verifies a regular %s",
    async (kind) => {
      const error = Object.assign(new Error("readlink failed"), { code: "EISDIR" });
      const fileSystem = {
        readlink: vi.fn<LinkFileSystem["readlink"]>((_path, callback) => callback(error)),
        lstat: vi.fn<LinkFileSystem["lstat"]>((_path, callback) =>
          callback(null, {
            isSymbolicLink: () => false,
            isFile: () => kind === "file",
            isDirectory: () => kind === "directory",
          }),
        ),
      };
      normalizeNonLinkErrors(fileSystem);
      const result = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
        fileSystem.readlink("path", resolve),
      );
      expect(result?.code).toBe("EINVAL");
      expect(error.code).toBe("EISDIR");
    },
  );

  it.each(["symbolic-link", "stat-error", "special-file"])(
    "preserves the original failure for %s",
    async (kind) => {
      const error = Object.assign(new Error("readlink failed"), { code: "EISDIR" });
      const fileSystem = {
        readlink: vi.fn<LinkFileSystem["readlink"]>((_path, callback) => callback(error)),
        lstat: vi.fn<LinkFileSystem["lstat"]>((_path, callback) =>
          callback(kind === "stat-error" ? new Error("unavailable") : null, {
            isSymbolicLink: () => kind === "symbolic-link",
            isFile: () => false,
            isDirectory: () => false,
          }),
        ),
      };
      normalizeNonLinkErrors(fileSystem);
      const result = await new Promise((resolve) => fileSystem.readlink("path", resolve));
      expect(result).toBe(error);
    },
  );

  it("preserves successful link targets and unrelated errors without lstat", () => {
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    const fileSystem = {
      readlink: vi.fn<LinkFileSystem["readlink"]>((path, callback) =>
        callback(path === "link" ? null : error, "target"),
      ),
      lstat: vi.fn<LinkFileSystem["lstat"]>(),
    };
    normalizeNonLinkErrors(fileSystem);
    const callback = vi.fn();
    fileSystem.readlink("link", callback);
    expect(callback).toHaveBeenLastCalledWith(null, "target");
    fileSystem.readlink("denied", callback);
    expect(callback).toHaveBeenLastCalledWith(error, "target");
    expect(fileSystem.lstat).not.toHaveBeenCalled();
  });

  it.each([
    process.cwd(),
    new URL("../../apps/web/app/api/auth/recover/route.ts", import.meta.url),
  ])("identifies real non-link checkout paths: %s", async (path) => {
    const fileSystem = { readlink, lstat };
    normalizeNonLinkErrors(fileSystem);
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      fileSystem.readlink(path, (error) => resolve(error)),
    );
    expect(error?.code).toBe("EINVAL");
  });
});
