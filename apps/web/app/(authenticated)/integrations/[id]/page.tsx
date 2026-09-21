import { PERMISSIONS } from "@bea/security";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  HealthIndicator,
  PageHeader,
} from "@bea/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { IntegrationSimulator } from "@/components/integration-simulator";
import { OpenAiAdministrationPanel } from "@/components/openai-administration-panel";
import { requirePermission } from "@/lib/auth/authorization";
import { getFoundationRuntime } from "@/lib/foundation-runtime";
import { getIntegrationHealth } from "@/lib/integrations";
import { formatDateTime } from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Integration Detail" };
export const dynamic = "force-dynamic";

export default async function IntegrationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePermission(PERMISSIONS.INTEGRATIONS_VIEW, "integration-detail");
  const runtime = await getFoundationRuntime();
  const { id } = await params;
  const [health, manageDecision, settingsDecision] = await Promise.all([
    getIntegrationHealth(id),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.INTEGRATIONS_MANAGE),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.SETTINGS_MANAGE),
  ]);
  if (!health) notFound();
  const healthState =
    health.connectionStatus === "connected"
      ? "healthy"
      : health.connectionStatus === "simulated" || health.mode === "mock"
        ? "simulated"
        : health.connectionStatus === "degraded"
          ? "degraded"
          : "unavailable";

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Integration center"
        title={health.displayName}
        description="Provider health and configuration evidence from the registered adapter."
        actions={<Badge tone="info">{health.requirementStatus}</Badge>}
      />
      <Card>
        <CardHeader>
          <CardTitle>Provider status</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="bea-meta-list">
            <div>
              <dt>Provider type</dt>
              <dd>
                <span className="bea-code">{health.providerType}</span>
              </dd>
            </div>
            <div>
              <dt>Health</dt>
              <dd>
                <HealthIndicator label={health.connectionStatus} state={healthState} />
              </dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>
                <Badge tone="info">{health.mode}</Badge>
              </dd>
            </div>
            <div>
              <dt>Configuration</dt>
              <dd>{health.configurationCompleteness}%</dd>
            </div>
            <div>
              <dt>Checked</dt>
              <dd>{formatDateTime(health.checkedAt)}</dd>
            </div>
            <div>
              <dt>Required permissions</dt>
              <dd>{health.requiredPermissions.join("; ")}</dd>
            </div>
            <div>
              <dt>External identifier</dt>
              <dd>{health.externalIdentifier ?? "Not configured"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      {health.providerType === "ai" && manageDecision.allowed && settingsDecision.allowed ? (
        <OpenAiAdministrationPanel />
      ) : null}
      {runtime.environment.runtimeMode !== "production" &&
      manageDecision.allowed &&
      health.providerType !== "ai" ? (
        <Card>
          <CardHeader>
            <CardTitle>Controlled simulation</CardTitle>
          </CardHeader>
          <CardContent>
            <IntegrationSimulator
              providerType={health.providerType}
              displayName={health.displayName}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
