import {
  lstat,
  mkdirSync,
  mkdtempSync,
  readFile,
  readFileSync,
  readlink,
  stat,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Script } from "node:vm";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  DirectoryReadCompatibilityPlugin,
  normalizeDirectoryReadErrors,
  normalizeNonLinkErrors,
} from "../../apps/web/lib/webpack-directory-read";
import nextConfig from "../../apps/web/next.config";

type InputFileSystem = Parameters<typeof normalizeDirectoryReadErrors>[0];
type LinkFileSystem = Parameters<typeof normalizeNonLinkErrors>[0];

it.each([false, true])(
  "retains cache settings and exempts only @bea copies (server=%s)",
  (isServer) => {
    const cache = { type: "filesystem", version: "existing-cache" };
    const managedPaths = [/node_modules/u];
    const immutablePaths = ["/immutable"];
    const existing = "/existing-unmanaged";
    const config = nextConfig.webpack!(
      {
        cache,
        snapshot: { managedPaths, immutablePaths, unmanagedPaths: [existing] },
        plugins: [],
        resolve: {},
        externals: [],
      },
      { isServer } as never,
    );
    expect(config.cache).toBe(cache);
    expect(config.snapshot.managedPaths).toBe(managedPaths);
    expect(config.snapshot.immutablePaths).toBe(immutablePaths);
    expect(config.snapshot.unmanagedPaths[0]).toBe(existing);
    const exclusion = config.snapshot.unmanagedPaths[1] as RegExp;
    for (const name of [
      "D:\\repo\\node_modules\\@bea\\security\\src\\hosted.ts",
      "/repo/node_modules/@bea/database/src/hosted.ts",
      "/repo/apps/web/node_modules/@bea/domain/src/index.ts",
    ])
      expect(exclusion.test(name), name).toBe(true);
    for (const name of [
      "/repo/node_modules/next/index.js",
      "/repo/node_modules/@bea-other/security/index.js",
      "/repo/packages/security/src/hosted.ts",
    ])
      expect(exclusion.test(name), name).toBe(false);
  },
);

it("rebuilds changed physical workspace exports with the same package version and persistent cache", async () => {
  // Fixture compilations must never replace the real hosted dependency graphs.
  vi.stubEnv("CPL_HOSTED_BUILD", "false");
  onTestFinished(() => vi.unstubAllEnvs());
  const parent = path.resolve(".data", "hosting", "webpack-cache-tests");
  mkdirSync(parent, { recursive: true });
  const fixture = mkdtempSync(path.join(parent, "fixture-"));
  onTestFinished(async () => {
    // Cleanup is limited to this newly created, checked fixture directory.
    expect(path.dirname(fixture)).toBe(parent);
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  type Compiler = {
    run(
      callback: (
        error: Error | null,
        stats?: {
          hasErrors(): boolean;
          hasWarnings(): boolean;
          toString(): string;
        },
      ) => void,
    ): void;
    close(callback: (error?: Error | null) => void): void;
  };
  const { webpack } = createRequire(import.meta.url)("next/dist/compiled/webpack/webpack.js") as {
    webpack(configuration: Record<string, unknown>): Compiler;
  };
  async function build(root: string, unmanaged: boolean) {
    const config = nextConfig.webpack!(
      {
        mode: "production",
        target: "node",
        context: root,
        entry: "./entry.js",
        output: {
          path: path.join(root, "output"),
          filename: "bundle.cjs",
          library: { type: "commonjs2" },
        },
        cache: {
          type: "filesystem",
          cacheDirectory: path.join(root, "cache"),
          buildDependencies: { fixture: [path.join(root, "package.json")] },
        },
        snapshot: { managedPaths: [/^(.+?[\\/]node_modules[\\])/] },
        plugins: [],
        resolve: {},
        externals: [],
        optimization: { minimize: false },
        infrastructureLogging: { level: "error" },
      },
      { isServer: true } as never,
    );
    // The control reproduces Next's previous managed-package assumption.
    if (!unmanaged) config.snapshot.unmanagedPaths = [];
    const compiler = webpack(config);
    try {
      await new Promise<void>((resolve, reject) =>
        compiler.run((error, stats) => {
          if (error) return reject(error);
          if (!stats || stats.hasErrors() || stats.hasWarnings())
            return reject(new Error(stats?.toString() ?? "Missing webpack stats."));
          resolve();
        }),
      );
    } finally {
      // A new compiler can only reuse this persisted cache after close flushes it.
      await new Promise<void>((resolve, reject) =>
        compiler.close((error) => (error ? reject(error) : resolve())),
      );
    }
    const module = { exports: {} as { default: Record<string, string> } };
    new Script(readFileSync(path.join(root, "output", "bundle.cjs"), "utf8")).runInNewContext({
      module,
    });
    return module.exports.default;
  }
  for (const unmanaged of [false, true]) {
    const root = path.join(fixture, unmanaged ? "unmanaged" : "control");
    const packageDirectory = path.join(root, "node_modules", "@bea", "cache-fixture");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "cache-fixture", private: true }),
    );
    writeFileSync(
      path.join(root, "entry.js"),
      'import * as values from "@bea/cache-fixture"; export default values;\n',
    );
    const manifest = JSON.stringify({
      name: "@bea/cache-fixture",
      version: "1.0.0",
      main: "index.js",
    });
    writeFileSync(path.join(packageDirectory, "package.json"), manifest);
    const source = path.join(packageDirectory, "index.js");
    writeFileSync(source, 'export const value = "before";\n');
    expect((await build(root, unmanaged)).value).toBe("before");
    writeFileSync(source, 'export const value = "after"; export const added = "new-export";\n');
    const rebuilt = await build(root, unmanaged);
    expect(readFileSync(path.join(packageDirectory, "package.json"), "utf8")).toBe(manifest);
    expect(rebuilt.value).toBe(unmanaged ? "after" : "before");
    expect(rebuilt.added).toBe(unmanaged ? "new-export" : undefined);
  }
}, 60_000);

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
