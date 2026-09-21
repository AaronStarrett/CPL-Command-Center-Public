import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { Card, CardContent, CardHeader, CardTitle, PageHeader } from "@bea/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LeadEditForm } from "@/components/lead-edit-form";
import { requirePermission } from "@/lib/auth/authorization";
import { displayContactName } from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Edit Lead Intake" };
export const dynamic = "force-dynamic";

export default async function EditLeadPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission(PERMISSIONS.LEADS_MANAGE, "lead-edit");
  const runtime = await getServerRuntime();
  const { id } = await params;
  const record = await runtime.leads.getLead(id);
  if (!record) notFound();
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
        eyebrow={record.lead.reference}
        title="Edit intake"
        description="Update permitted intake fields. Status changes use the review actions on the command record."
      />
      <Card>
        <CardHeader>
          <CardTitle>{record.lead.opportunityName}</CardTitle>
        </CardHeader>
        <CardContent>
          <LeadEditForm
            lead={record.lead}
            parties={record.parties}
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
