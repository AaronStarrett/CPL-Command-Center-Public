import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { Card, CardContent, CardHeader, CardTitle, PageHeader } from "@bea/ui";
import type { Metadata } from "next";

import { TaskCreateForm } from "@/components/task-create-form";
import { requirePermission } from "@/lib/auth/authorization";

export const metadata: Metadata = { title: "Create Task" };
export const dynamic = "force-dynamic";

export default async function NewTaskPage() {
  const session = await requirePermission(PERMISSIONS.TASKS_MANAGE, "task-create");
  const runtime = await getServerRuntime();
  const [companyDecision, contactDecision] = await Promise.all([
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.COMPANIES_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.CONTACTS_VIEW),
  ]);
  const companies = companyDecision.allowed
    ? await runtime.phase1.listCompanies({ limit: 250 })
    : [];

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Controlled record change"
        title="Create task"
        description="Create a normal Phase 1 task assigned to the current account."
      />
      <Card>
        <CardHeader>
          <CardTitle>Task details</CardTitle>
        </CardHeader>
        <CardContent>
          <TaskCreateForm
            companies={companies.map((company) => ({ id: company.id, label: company.name }))}
            contactsEnabled={companyDecision.allowed && contactDecision.allowed}
          />
        </CardContent>
      </Card>
    </div>
  );
}
