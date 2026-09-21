import { PERMISSIONS } from "@bea/security";
import type { Metadata } from "next";

import { AutomationFlowCanvas } from "@/components/automation-flow-canvas";
import { requirePermission } from "@/lib/auth/authorization";

export const metadata: Metadata = { title: "Automation Flow" };
export const dynamic = "force-dynamic";

export default async function AutomationFlowPage() {
  await requirePermission(PERMISSIONS.HOME_VIEW, "automation-flow");
  return <AutomationFlowCanvas />;
}
