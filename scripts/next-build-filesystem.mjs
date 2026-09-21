import path from "node:path";
import { fileURLToPath } from "node:url";

/** Next's final trace uses fs.promises directly, outside webpack's filesystem.
 * Install only in a Windows build process and only translate verified ordinary
 * paths inside this checkout. Never conceal a symbolic-link or lstat failure.
 */
export function installBuildReadlinkCompatibility({
  command,
  platform = process.platform,
  fileSystem,
  root,
}) {
  if (command !== "build" || platform !== "win32") return () => {};
  const original = fileSystem.readlink;
  const insideRoot = (value) => {
    try {
      const candidate = value instanceof URL ? fileURLToPath(value) : String(value);
      const relative = path.relative(path.resolve(root), path.resolve(candidate));
      return (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
      );
    } catch {
      return false;
    }
  };
  const adapted = async function (candidate, ...options) {
    try {
      return await original.call(fileSystem, candidate, ...options);
    } catch (error) {
      if (error?.code !== "EISDIR" || !insideRoot(candidate)) throw error;
      let stats;
      try {
        stats = await fileSystem.lstat(candidate);
      } catch {
        throw error;
      }
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) throw error;
      const nonLink = new Error("Path is not a symbolic link.", { cause: error });
      nonLink.code = "EINVAL";
      nonLink.syscall = "readlink";
      throw nonLink;
    }
  };
  fileSystem.readlink = adapted;
  return () => {
    if (fileSystem.readlink === adapted) fileSystem.readlink = original;
  };
}
