import { getServerRuntime } from "@bea/database";
import type { CompanyStatus } from "@bea/domain";
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
import { safeText, statusTone } from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Companies" };
export const dynamic = "force-dynamic";

const companyStatuses = ["active", "inactive", "prospect"] as const;

function queryValue(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission(PERMISSIONS.COMPANIES_VIEW, "companies");
  const runtime = await getServerRuntime();
  const query = await searchParams;
  const text = queryValue(query.q);
  const requestedStatus = queryValue(query.status);
  const status = companyStatuses.includes(requestedStatus as CompanyStatus)
    ? (requestedStatus as CompanyStatus)
    : undefined;
  const companies = await runtime.phase1.listCompanies({
    limit: 100,
    ...(text ? { query: text } : {}),
    ...(status ? { status } : {}),
  });

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Phase 1 records"
        title="Companies"
        description="Search and inspect the organizations stored in the Command Center."
        actions={<Badge tone="info">{companies.length} shown</Badge>}
      />
      <form action="/companies" className="bea-filter-bar">
        <FormField label="Company name or industry" htmlFor="company-query">
          <Input id="company-query" name="q" type="search" defaultValue={text} />
        </FormField>
        <FormField label="Status" htmlFor="company-status">
          <Select id="company-status" name="status" defaultValue={status ?? ""}>
            <option value="">All statuses</option>
            {companyStatuses.map((option) => (
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
      {companies.length ? (
        <TableFoundation>
          <Table>
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col">Industry</th>
                <th scope="col">Status</th>
                <th scope="col">Phone</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((company) => (
                <tr key={company.id}>
                  <td>
                    <Link href={`/companies/${encodeURIComponent(company.id)}`}>
                      {company.name}
                    </Link>
                  </td>
                  <td>{safeText(company.industry, "—")}</td>
                  <td>
                    <Badge tone={statusTone(company.status)}>{company.status}</Badge>
                  </td>
                  <td>{safeText(company.phone, "—")}</td>
                  <td>
                    <time dateTime={company.updatedAt}>
                      {new Date(company.updatedAt).toLocaleDateString("en-US")}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableFoundation>
      ) : (
        <EmptyState
          title="No companies found"
          description="No company records match the current filters."
        />
      )}
    </div>
  );
}
