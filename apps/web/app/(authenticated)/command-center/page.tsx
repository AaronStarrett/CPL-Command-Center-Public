import { PERMISSIONS } from "@bea/security";
import type { Metadata } from "next";

import { CommandCenterExperience } from "@/components/command-center-experience";
import { requirePermission } from "@/lib/auth/authorization";

export const metadata: Metadata = { title: "Command Center" };
export const dynamic = "force-dynamic";

export default async function CommandCenterPage() {
  await requirePermission(PERMISSIONS.HOME_VIEW, "command-center");
  return <CommandCenterExperience />;
}
