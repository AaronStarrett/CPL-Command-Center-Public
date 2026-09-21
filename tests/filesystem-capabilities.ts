import { spawnSync } from "node:child_process";
import { join, parse, resolve } from "node:path";

const formats = new Map<string, string>();

/** Skip physical evidence only for a positively identified unsupported volume. */
export function nativeWindowsFilesystemMissing(
  capability: "persistent ACLs" | "reparse points",
  target: string,
): boolean {
  if (process.platform !== "win32") return false;
  const root = parse(resolve(target)).root;
  let format = formats.get(root);
  if (!format) {
    const result = spawnSync(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[IO.DriveInfo]::new([Console]::In.ReadToEnd()).DriveFormat",
      ],
      { input: root, encoding: "utf8", windowsHide: true, timeout: 10_000 },
    );
    if (result.status !== 0 || result.error) {
      throw new Error("Could not verify the test volume's native filesystem capabilities.");
    }
    format = result.stdout.trim();
    if (!format) throw new Error("The test volume filesystem format was unavailable.");
    formats.set(root, format);
  }
  const unavailable = /^(?:exFAT|FAT|FAT32)$/iu.test(format);
  if (unavailable) {
    console.warn(`Physical ${capability} evidence NOT RUN: ${root} uses ${format}.`);
  }
  return unavailable;
}
