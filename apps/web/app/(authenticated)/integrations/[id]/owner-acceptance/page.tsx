import { PERMISSIONS } from "@bea/security";
import { Alert, Badge, PageHeader } from "@bea/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { OwnerLiveAcceptanceCenter } from "@/components/owner-live-acceptance-center";
import { requirePermission } from "@/lib/auth/authorization";
import { getFoundationRuntime } from "@/lib/foundation-runtime";

export const metadata: Metadata = { title: "Owner Live Acceptance Center" };
export const dynamic = "force-dynamic";

export default async function OwnerLiveAcceptancePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (id !== "ai") notFound();

  const session = await requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE, "owner-acceptance");
  const runtime = await getFoundationRuntime();
  const settingsDecision = await runtime.authorization.authorizeUser(
    session.personaId,
    PERMISSIONS.SETTINGS_MANAGE,
  );
  if (!settingsDecision.allowed) {
    return (
      <div className="bea-stack bea-stack--large">
        <PageHeader
          eyebrow="Owner live acceptance"
          title="Owner Live Acceptance Center"
          description="OpenAI setup and Phase 2.1 live checks are restricted to Owners and Integration Administrators."
        />
        <Alert tone="warning" title="Settings permission required">
          The current identity can view integrations but cannot change OpenAI or record live
          acceptance.
        </Alert>
      </div>
    );
  }

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Phase 2.1 owner live acceptance"
        title="Owner Live Acceptance Center"
        description="Configure OpenAI through the existing protected administration panel, then confirm only what you personally heard and saw."
        actions={<Badge tone="warning">NOT RUN until you confirm live observations</Badge>}
      />
      <OwnerLiveAcceptanceCenter />
    </div>
  );
}
