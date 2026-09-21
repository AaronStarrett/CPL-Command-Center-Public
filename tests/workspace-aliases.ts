import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

/**
 * Resolve workspace imports to one canonical module in tests. The Windows/exFAT
 * installer uses physical copies, which otherwise create duplicate Error classes
 * and process-local state alongside relative source imports.
 */
export const workspaceAliases = readdirSync(resolve(repositoryRoot, "packages")).flatMap(
  (directory) => {
    const packageRoot = resolve(repositoryRoot, "packages", directory);
    const metadata = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
    return Object.entries(metadata.exports ?? {}).flatMap(([subpath, entry]) => {
      const target = typeof entry === "string" ? entry : (entry as { default?: string }).default;
      if (!target) return [];
      const specifier = metadata.name + (subpath === "." ? "" : subpath.slice(1));
      return [
        {
          find: new RegExp("^" + specifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "$", "u"),
          replacement: resolve(packageRoot, target),
        },
      ];
    });
  },
);
