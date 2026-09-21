import { PERMISSIONS } from "@bea/security";
import type { Metadata } from "next";

import { AiCommandWorkspace } from "@/components/ai-command-workspace";
import styles from "@/components/ai-command.module.css";
import { requirePermission } from "@/lib/auth/authorization";
import { getAiCommandSnapshot } from "@/lib/ai-command";

export const metadata: Metadata = { title: "AI Command" };
export const dynamic = "force-dynamic";

export default async function AiCommandPage({
  searchParams,
}: {
  searchParams: Promise<{ conversation?: string | string[] }>;
}) {
  const session = await requirePermission(PERMISSIONS.AI_COMMAND_VIEW, "ai-command");
  const requested = (await searchParams).conversation;
  const conversationId = Array.isArray(requested) ? requested[0] : requested;
  const snapshot = await getAiCommandSnapshot(session.personaId, conversationId);
  const browserMediaTestMode =
    process.env.APP_MODE === "demo" &&
    process.env.BEA_DISABLE_ENV_FILE === "true" &&
    process.env.BEA_BROWSER_MEDIA_TEST_MODE === "true" &&
    process.env.BEA_BROWSER_MEDIA_TEST_AUTHORITY === "phase1-2-gate30";

  return (
    <div className={styles.page} data-page="ai-command">
      <AiCommandWorkspace initialSnapshot={snapshot} browserMediaTestMode={browserMediaTestMode} />
    </div>
  );
}
