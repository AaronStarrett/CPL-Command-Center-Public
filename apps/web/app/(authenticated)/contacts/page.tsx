import { getServerRuntime } from "@bea/database";
import type { ContactStatus } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import {
  Badge,
  Button,
  EmptyState,
  FormField,
  Input,
  Link,
  PageHeader,
  Select,
  Table,
  TableFoundation,
} from "@bea/ui";
import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/authorization";
import { displayContactName, safeText, statusTone } from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Contacts" };
export const dynamic = "force-dynamic";

const contactStatuses = ["active", "inactive"] as const;

function queryValue(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission(PERMISSIONS.CONTACTS_VIEW, "contacts");
  const runtime = await getServerRuntime();
  const query = await searchParams;
  const text = queryValue(query.q);
  const requestedStatus = queryValue(query.status);
  const status = contactStatuses.includes(requestedStatus as ContactStatus)
    ? (requestedStatus as ContactStatus)
    : undefined;
  const companyDecision = await runtime.authorization.authorizeUser(
    session.personaId,
    PERMISSIONS.COMPANIES_VIEW,
  );
  const [contacts, companies] = await Promise.all([
    runtime.phase1.listContacts({
      limit: 100,
      ...(text ? { query: text } : {}),
      ...(status ? { status } : {}),
    }),
    companyDecision.allowed ? runtime.phase1.listCompanies({ limit: 250 }) : Promise.resolve([]),
  ]);
  const companyNames = new Map(companies.map((company) => [company.id, company.name]));

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Phase 1 records"
        title="Contacts"
        description="Find people and open the business context your role is permitted to see."
        actions={<Badge tone="info">{contacts.length} shown</Badge>}
      />
      <form action="/contacts" className="bea-filter-bar">
        <FormField label="Name, title, or email" htmlFor="contact-query">
          <Input id="contact-query" name="q" type="search" defaultValue={text} />
        </FormField>
        <FormField label="Status" htmlFor="contact-status">
          <Select id="contact-status" name="status" defaultValue={status ?? ""}>
            <option value="">All statuses</option>
            {contactStatuses.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </FormField>
        <Button type="submit" variant="secondary">
          Apply filters
        </Button>
      </form>
      {contacts.length ? (
        <TableFoundation>
          <Table>
            <thead>
              <tr>
                <th scope="col">Contact</th>
                <th scope="col">Title</th>
                {companyDecision.allowed ? <th scope="col">Company</th> : null}
                <th scope="col">Email</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => (
                <tr key={contact.id}>
                  <td>
                    <Link href={`/contacts/${encodeURIComponent(contact.id)}`}>
                      {displayContactName(contact)}
                    </Link>
                  </td>
                  <td>{safeText(contact.jobTitle, "—")}</td>
                  {companyDecision.allowed ? (
                    <td>
                      {contact.companyId ? (
                        <Link href={`/companies/${encodeURIComponent(contact.companyId)}`}>
                          {companyNames.get(contact.companyId) ?? "Company record"}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  ) : null}
                  <td>{safeText(contact.email, "—")}</td>
                  <td>
                    <Badge tone={statusTone(contact.status)}>{contact.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableFoundation>
      ) : (
        <EmptyState
          title="No contacts found"
          description="No contact records match the current filters."
        />
      )}
    </div>
  );
}
