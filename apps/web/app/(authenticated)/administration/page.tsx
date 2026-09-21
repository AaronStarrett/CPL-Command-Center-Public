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
  PageHeader,
  Table,
  TableFoundation,
} from "@bea/ui";
import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/authorization";
import { ExecutiveProfileAdministrationPanel } from "@/components/executive-profile-administration";
import { recentDemoAuditEvents } from "@/lib/demo-audit";
import { readExecutiveProfileAdministration } from "@/lib/executive-profile-administration";
import { getFoundationSnapshot } from "@/lib/foundation";
import { createRuntimePresentation } from "@/lib/production-presentation";

export const metadata: Metadata = { title: "Administration" };
export const dynamic = "force-dynamic";

export default async function AdministrationPage() {
  const session = await requirePermission(PERMISSIONS.ADMINISTRATION_VIEW, "administration");
  const runtime = await getServerRuntime();
  const presentation = createRuntimePresentation(
    runtime.environment,
    process.env.BEA_DEPLOYMENT_PROFILE,
  );
  const [snapshot, roleGrants, auditDecision, profileDecision] = await Promise.all([
    getFoundationSnapshot(),
    runtime.repository.listRoleGrantSummaries(),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.AUDIT_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.EXECUTIVE_PROFILE_VIEW),
  ]);
  const auditEvents = auditDecision.allowed ? await recentDemoAuditEvents(20) : [];
  const executiveProfile = profileDecision.allowed
    ? await readExecutiveProfileAdministration(runtime)
    : null;

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Restricted system view"
        title="Administration"
        description="Focused system controls, authorization evidence, and owner-approved Executive Profile administration."
        actions={<Badge tone="warning">{presentation.administrationBadge}</Badge>}
      />
      <Alert tone="info" title="Scoped administration boundary">
        Executive Profile and assistant-profile version controls are implemented for authorized
        Owners. User management and unrelated connector configuration remain outside this phase.
      </Alert>
      {executiveProfile ? <ExecutiveProfileAdministrationPanel initial={executiveProfile} /> : null}
      <div className="bea-system-grid">
        <Card>
          <CardHeader>
            <CardTitle>Runtime facts</CardTitle>
            <CardDescription>Values observed by this server process.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="bea-meta-list">
              <div>
                <dt>Application mode</dt>
                <dd>{snapshot.appMode}</dd>
              </div>
              <div>
                <dt>Node environment</dt>
                <dd>{snapshot.environment}</dd>
              </div>
              <div>
                <dt>{presentation.authenticationLabel}</dt>
                <dd>{snapshot.demoAuth}</dd>
              </div>
              <div>
                <dt>Session persistence</dt>
                <dd>Opaque tokens; {snapshot.sessionStore} repository</dd>
              </div>
              <div>
                <dt>Configured TTL</dt>
                <dd>{runtime.environment.sessionTtlMinutes} minutes</dd>
              </div>
              <div>
                <dt>Provider registry</dt>
                <dd>
                  {presentation.production
                    ? `${snapshot.integrationHealth.total} checked / ${snapshot.integrationHealth.connected} connected`
                    : `${snapshot.integrationHealth.total} checked / ${snapshot.integrationHealth.simulated} simulated`}
                </dd>
              </div>
              <div>
                <dt>External connections</dt>
                <dd>{snapshot.liveConnections}</dd>
              </div>
              <div>
                <dt>Worker health</dt>
                <dd>{snapshot.workerHealth.status}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Control health</CardTitle>
            <CardDescription>
              {presentation.production
                ? "Current protected application control boundaries."
                : "Phase 0 control boundaries, not production certification."}
            </CardDescription>
          </CardHeader>
          <CardContent className="bea-stack">
            <HealthIndicator label="SQL-backed role checks" state="healthy" />
            <HealthIndicator label="HttpOnly session cookie" state="healthy" />
            <HealthIndicator
              label="Integration providers"
              state={
                presentation.production
                  ? snapshot.integrationHealth.connected > 0
                    ? "healthy"
                    : "degraded"
                  : "simulated"
              }
            />
            <HealthIndicator
              label={presentation.production ? "Authenticated session" : "Production identity"}
              state={presentation.production ? "healthy" : "unavailable"}
            />
            <HealthIndicator
              label="Live integrations"
              state={snapshot.integrationHealth.connected > 0 ? "healthy" : "unavailable"}
            />
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Current role grants</CardTitle>
          <CardDescription>
            Counts are queried from active SQL role-permission grants; stable permission constants
            are defined by <span className="bea-code">@bea/security</span>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table>
              <thead>
                <tr>
                  <th scope="col">Role ID</th>
                  <th scope="col">Permission count</th>
                  <th scope="col">Current session</th>
                </tr>
              </thead>
              <tbody>
                {roleGrants.map((roleGrant) => (
                  <tr key={roleGrant.roleId}>
                    <td>
                      <span className="bea-code">{roleGrant.roleId}</span>
                      <br />
                      <span>{roleGrant.roleName}</span>
                    </td>
                    <td>{roleGrant.permissionCount}</td>
                    <td>
                      {session.roleIds.includes(roleGrant.roleId) ? (
                        <Badge tone="success">Assigned</Badge>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{presentation.auditTitle}</CardTitle>
          <CardDescription>{presentation.auditDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          {auditDecision.allowed ? (
            <TableFoundation>
              <Table>
                <thead>
                  <tr>
                    <th scope="col">Timestamp</th>
                    <th scope="col">Event</th>
                    <th scope="col">Action</th>
                    <th scope="col">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEvents.map((event) => (
                    <tr key={event.id}>
                      <td>
                        <time dateTime={event.createdAt}>
                          {new Date(event.createdAt).toLocaleString("en-US")}
                        </time>
                      </td>
                      <td>{event.eventType}</td>
                      <td>{event.action}</td>
                      <td>
                        <Badge
                          tone={
                            event.outcome === "succeeded"
                              ? "success"
                              : event.outcome === "denied"
                                ? "danger"
                                : "warning"
                          }
                        >
                          {event.outcome}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableFoundation>
          ) : (
            <p>Audit detail requires the separate audit.view permission.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
