import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { Card, CardContent, CardHeader, CardTitle, PageHeader } from "@bea/ui";
import type { Metadata } from "next";

import { ConfigurationIntakeForm } from "@/components/configuration-intake-form";
import { SyntheticFixtureBanner } from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";

export const metadata: Metadata = { title: "Thursday configuration intake" };
export const dynamic = "force-dynamic";

export default async function ConfigurationIntakePage() {
  const session = await requirePermission(PERMISSIONS.CONFIGURATION_VIEW, "configuration-intake");
  const runtime = await getServerRuntime();
  const [items, packet, canDraft] = await Promise.all([
    runtime.configuration.repository.listIntakeItems(),
    runtime.configuration.exportIntake(),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.CONFIGURATION_DRAFT),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Configuration Studio"
        title="Thursday intake"
        description="Every unanswered BEA production question for the 3 September 2026 owner meeting. Synthetic defaults are not confirmation."
      />
      <SyntheticFixtureBanner synthetic />
      <Card>
        <CardHeader>
          <CardTitle>Meeting packet</CardTitle>
        </CardHeader>
        <CardContent>
          <ConfigurationIntakeForm items={items} canEdit={canDraft.allowed} />
          <pre className="bea-code-block" data-testid="intake-markdown">
            {packet.markdown}
          </pre>
        </CardContent>
      </Card>
    </>
  );
}
