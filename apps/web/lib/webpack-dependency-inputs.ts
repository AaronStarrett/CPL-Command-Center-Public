import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

interface BundledModule {
  resource?: string;
  modules?: Iterable<BundledModule>;
}

interface Compilation {
  modules: Iterable<BundledModule>;
  chunkGraph: { getNumberOfModuleChunks(item: BundledModule): number };
}

/** Record emitted module provenance privately, including concatenated modules. */
export function emittedDependencyResources(compilation: Compilation): string[] {
  const resources = new Set<string>();
  function visit(item: BundledModule): void {
    if (item.resource) resources.add(item.resource.split("?")[0]);
    for (const nested of item.modules ?? []) visit(nested);
  }
  for (const item of compilation.modules) {
    if (compilation.chunkGraph.getNumberOfModuleChunks(item) > 0) visit(item);
  }
  return [...resources].sort();
}

export class HostedDependencyInputsPlugin {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  apply(compiler: {
    name?: string;
    hooks: {
      afterEmit: { tap(name: string, callback: (compilation: Compilation) => void): void };
    };
  }): void {
    compiler.hooks.afterEmit.tap("CplHostedDependencyInputs", (compilation) => {
      mkdirSync(this.directory, { recursive: true });
      const name = (compiler.name ?? "unnamed").replace(/[^a-z0-9_-]/giu, "_");
      writeFileSync(
        path.join(this.directory, `${name}.json`),
        JSON.stringify({ resources: emittedDependencyResources(compilation) }, null, 2) + "\n",
      );
    });
  }
}
