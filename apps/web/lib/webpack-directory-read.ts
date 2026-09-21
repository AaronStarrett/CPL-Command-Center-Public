import type { PathLike } from "node:fs";

type ReadCallback = (error: NodeJS.ErrnoException | null, data?: Buffer) => void;

interface LinkFileSystem {
  readlink(
    path: PathLike,
    callback: (error: NodeJS.ErrnoException | null, target?: string | Buffer) => void,
  ): void;
  lstat(
    path: PathLike,
    callback: (
      error: NodeJS.ErrnoException | null,
      stats?: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean },
    ) => void,
  ): void;
}

interface InputFileSystem {
  readlink?: LinkFileSystem["readlink"];
  lstat?: LinkFileSystem["lstat"];
  readFile(path: PathLike, callback: ReadCallback): void;
  stat(
    path: PathLike,
    callback: (error: NodeJS.ErrnoException | null, stats?: { isDirectory(): boolean }) => void,
  ): void;
}

const normalizedFileSystems = new WeakSet<InputFileSystem>();
const normalizedLinkFileSystems = new WeakSet<LinkFileSystem>();

/** exFAT also reports EISDIR for readlink on ordinary files and directories. */
export function normalizeNonLinkErrors(fileSystem: LinkFileSystem): void {
  if (normalizedLinkFileSystems.has(fileSystem)) return;
  const originalReadlink = fileSystem.readlink.bind(fileSystem);
  fileSystem.readlink = (path, callback) => {
    originalReadlink(path, (error, target) => {
      if (error?.code !== "EISDIR") {
        callback(error, target);
        return;
      }
      // lstat is essential: stat would follow a real symbolic link and could
      // incorrectly hide a failure on that link by inspecting its target.
      fileSystem.lstat(path, (statError, stats) => {
        if (
          statError ||
          !stats ||
          stats.isSymbolicLink() ||
          (!stats.isFile() && !stats.isDirectory())
        ) {
          callback(error);
          return;
        }
        const nonLinkError = new Error("Path is not a symbolic link.") as NodeJS.ErrnoException;
        nonLinkError.code = "EINVAL";
        callback(nonLinkError);
      });
    });
  };
  normalizedLinkFileSystems.add(fileSystem);
}

/**
 * Node on Windows/exFAT reports EINVAL when readFile encounters a directory.
 * Webpack's content-hash cache recognizes EISDIR instead. Confirm the path's
 * type before translating only that error; file failures must remain failures.
 */
export function normalizeDirectoryReadErrors(fileSystem: InputFileSystem): void {
  if (normalizedFileSystems.has(fileSystem)) return;
  const originalReadFile = fileSystem.readFile.bind(fileSystem);
  fileSystem.readFile = (path, callback) => {
    originalReadFile(path, (error, data) => {
      if (error?.code !== "EINVAL") {
        callback(error, data);
        return;
      }
      fileSystem.stat(path, (statError, stats) => {
        if (statError || !stats?.isDirectory()) {
          callback(error);
          return;
        }
        const directoryError = new Error(
          "Cannot read a directory as a file.",
        ) as NodeJS.ErrnoException;
        directoryError.code = "EISDIR";
        callback(directoryError);
      });
    });
  };
  normalizedFileSystems.add(fileSystem);
}

export class DirectoryReadCompatibilityPlugin {
  apply(compiler: {
    inputFileSystem: InputFileSystem;
    intermediateFileSystem: InputFileSystem;
  }): void {
    normalizeDirectoryReadErrors(compiler.inputFileSystem);
    if (compiler.inputFileSystem.readlink && compiler.inputFileSystem.lstat)
      normalizeNonLinkErrors(compiler.inputFileSystem as LinkFileSystem);
    // Persistent cache snapshots use the intermediate filesystem, which is
    // otherwise the shared Node fs module. Keep the adapter compiler-local.
    const intermediate = Object.create(compiler.intermediateFileSystem) as InputFileSystem;
    normalizeDirectoryReadErrors(intermediate);
    if (intermediate.readlink && intermediate.lstat)
      normalizeNonLinkErrors(intermediate as LinkFileSystem);
    compiler.intermediateFileSystem = intermediate;
  }
}
