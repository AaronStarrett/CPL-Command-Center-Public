import { getServerRuntime } from "@bea/database";
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from "@bea/ui";
import type { Metadata } from "next";

import { requireSession } from "@/lib/auth/authorization";
import { createRuntimePresentation } from "@/lib/production-presentation";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const [session, runtime] = await Promise.all([requireSession(), getServerRuntime()]);
  const presentation = createRuntimePresentation(
    runtime.environment,
    process.env.BEA_DEPLOYMENT_PROFILE,
  );
  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow={presentation.accountEyebrow}
        title="Account and session"
        description={presentation.accountDescription}
      />
      <Card>
        <CardHeader>
          <CardTitle>{session.displayName}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="bea-meta-list">
            <div>
              <dt>{presentation.accountIdentifierLabel}</dt>
              <dd>
                <span className="bea-code">{session.personaId}</span>
              </dd>
            </div>
            <div>
              <dt>Title</dt>
              <dd>{session.title}</dd>
            </div>
            <div>
              <dt>{presentation.accountEmailLabel}</dt>
              <dd>{session.email}</dd>
            </div>
            <div>
              <dt>Role IDs</dt>
              <dd className="bea-cluster">
                {session.roleIds.map((role) => (
                  <Badge key={role}>{role}</Badge>
                ))}
              </dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>
                <time dateTime={session.createdAt}>
                  {new Date(session.createdAt).toLocaleString("en-US")}
                </time>
              </dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>
                <time dateTime={session.expiresAt}>
                  {new Date(session.expiresAt).toLocaleString("en-US")}
                </time>
              </dd>
            </div>
            <div>
              <dt>Cookie visibility</dt>
              <dd>HttpOnly; token not exposed to client JavaScript</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
