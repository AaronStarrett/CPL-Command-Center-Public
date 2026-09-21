import "server-only";

import { getServerRuntime, type BeaServerRuntime } from "@bea/database";

export function getFoundationRuntime(): Promise<BeaServerRuntime> {
  return getServerRuntime();
}
