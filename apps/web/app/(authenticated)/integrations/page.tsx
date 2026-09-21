import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  HealthIndicator,
  Link,
  PageHeader,
} from "@bea/ui";
import type { Metadata } from "next";

import { IntegrationSimulator } from "@/components/integration-simulator";
import { requirePermission } from "@/lib/auth/authorization";
import { getIntegrationHealthSummary } from "@/lib/integrations";
import { connectorStatusLabel } from "@/lib/operations-presentation";
import {
  createRuntimePresentation,
  providerHealthPresentation,
} from "@/lib/production-presentation";

export const metadata: Metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const session = await requirePermission(PERMISSIONS.INTEGRATIONS_VIEW, "integrations");
  const runtime = await getServerRuntime();
  const [summary, manageDecision, connectors] = await Promise.all([
    getIntegrationHealthSummary(),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.INTEGRATIONS_MANAGE),
    runtime.operations.repository.listConnectorReadiness(),
  ]);
  const canManage = manageDecision.allowed;
  const presentation = createRuntimePresentation(
    runtime.environment,
    process.env.BEA_DEPLOYMENT_PROFILE,
  );

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="System boundary"
        title="Integration Center"
        description={presentation.integrationsDescription}
        actions={
          <Badge tone={summary.connected > 0 ? "success" : "info"}>
            {summary.connected > 0
              ? `${summary.connected} connected`
              : presentation.production
                ? `${summary.total} setup required`
                : `${summary.simulated} simulated`}
          </Badge>
        }
      />
      <Alert
        tone={summary.connected > 0 ? "info" : "warning"}
        title={
          summary.connected > 0
            ? "Connected providers available"
            : presentation.production
              ? "Provider setup required"
              : "No live connections"
        }
      >
        {presentation.integrationsBoundary}
      </Alert>
      <div className="bea-grid">
        {summary.providers.map((provider) => (
          <Card className="bea-integration-card" key={provider.providerType}>
            <CardHeader>
              <span className="bea-integration-card__category">{provider.providerType}</span>
              <CardTitle>
                <Link href={`/integrations/${encodeURIComponent(provider.providerType)}`}>
                  {provider.displayName}
                </Link>
              </CardTitle>
              <CardDescription>{provider.requiredPermissions.join("; ")}</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="bea-meta-list">
                <div>
                  <dt>Mode</dt>
                  <dd>
                    <Badge tone="info">{provider.mode}</Badge>
                  </dd>
                </div>
                <div>
                  <dt>Requirement</dt>
                  <dd>{provider.requirementStatus}</dd>
                </div>
                <div>
                  <dt>Configuration</dt>
                  <dd>{provider.configurationCompleteness}%</dd>
                </div>
              </dl>
            </CardContent>
            <div className="bea-integration-card__footer">
              <HealthIndicator
                label={provider.connectionStatus}
                state={providerHealthPresentation(
                  provider.connectionStatus,
                  presentation.production,
                )}
              />
              {canManage ? (
                provider.providerType === "ai" ? (
                  <>
                    <Link href="/integrations/ai">Configure OpenAI</Link>
                    <Link href="/integrations/ai/owner-acceptance">Owner Live Acceptance</Link>
                  </>
                ) : presentation.production ? (
                  <Badge>Not connected</Badge>
                ) : (
                  <IntegrationSimulator
                    providerType={provider.providerType}
                    displayName={provider.displayName}
                  />
                )
              ) : (
                <Badge>View only</Badge>
              )}
            </div>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Operational connector readiness</CardTitle>
          <CardDescription>
            Inspection-to-report connectors. Healthy is never shown unless verified. LIVE
            CONNECTION: NOT RUN.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul>
            {connectors.map((connector) => (
              <li key={connector.id}>
                {connector.displayName}: {connectorStatusLabel(connector.readinessStatus)}
                {connector.requiredAction ? ` — ${connector.requiredAction}` : ""}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
