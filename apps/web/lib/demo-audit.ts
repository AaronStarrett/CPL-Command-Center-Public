import "server-only";

import { getServerRuntime } from "@bea/database";
import type { AuditEventInput, AuditLog, AuditSink } from "@bea/domain";

export const demoAuditSink: AuditSink = {
  async record(input: AuditEventInput): Promise<AuditLog> {
    const runtime = await getServerRuntime();
    return runtime.repository.record(input);
  },
};

export async function recentDemoAuditEvents(limit = 20): Promise<readonly AuditLog[]> {
  const runtime = await getServerRuntime();
  return runtime.repository.listAuditLogs(limit);
}
