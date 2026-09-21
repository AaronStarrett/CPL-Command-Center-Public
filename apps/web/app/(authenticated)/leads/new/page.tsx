import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { Card, CardContent, CardHeader, CardTitle, PageHeader } from "@bea/ui";
import type { Metadata } from "next";

import { LeadCreateForm } from "@/components/lead-create-form";
import { requirePermission } from "@/lib/auth/authorization";
import { displayContactName } from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Create Lead" };
export const dynamic = "force-dynamic";

export default async function NewLeadPage() {
  const session = await requirePermission(PERMISSIONS.LEADS_MANAGE, "lead-create");
  const runtime = await getServerRuntime();
  const companyDecision = await runtime.authorization.authorizeUser(
    session.personaId,
    PERMISSIONS.COMPANIES_VIEW,
  );
  const contactDecision = await runtime.authorization.authorizeUser(
    session.personaId,
    PERMISSIONS.CONTACTS_VIEW,
  );
  const [companies, contacts, reviewers] = await Promise.all([
    companyDecision.allowed ? runtime.phase1.listCompanies({ limit: 250 }) : Promise.resolve([]),
    contactDecision.allowed ? runtime.phase1.listContacts({ limit: 250 }) : Promise.resolve([]),
    runtime.leads.listReviewerCandidates(),
  ]);

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Lead intake"
        title="Create lead"
        description="Capture a manual, referral, or in-person inquiry. Incomplete party information is allowed. Website, Outlook, and telephone connectors are not connected."
      />
      <Card>
        <CardHeader>
          <CardTitle>Intake details</CardTitle>
        </CardHeader>
        <CardContent>
          <LeadCreateForm
            companies={companies.map((company) => ({ id: company.id, label: company.name }))}
            contacts={contacts.map((contact) => ({
              id: contact.id,
              label: displayContactName(contact),
              companyId: contact.companyId,
            }))}
            canViewContacts={contactDecision.allowed}
            reviewers={reviewers.map((reviewer) => ({
              id: reviewer.id,
              label: reviewer.title
                ? `${reviewer.displayName} · ${reviewer.title}`
                : reviewer.displayName,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
