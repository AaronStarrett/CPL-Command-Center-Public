import { getServerRuntime } from "@bea/database";
import type { Phase1SearchResult } from "@bea/domain";
import { PERMISSIONS, type Permission } from "@bea/security";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  FormField,
  Input,
  Link,
  PageHeader,
  Table,
  TableFoundation,
} from "@bea/ui";
import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/authorization";
import { safeInternalHref } from "@/lib/safe-return-path";

export const metadata: Metadata = { title: "Search" };
export const dynamic = "force-dynamic";

const resultPermissions: Readonly<Record<Phase1SearchResult["type"], Permission>> = {
  company: PERMISSIONS.COMPANIES_VIEW,
  contact: PERMISSIONS.CONTACTS_VIEW,
  task: PERMISSIONS.TASKS_VIEW,
  lead: PERMISSIONS.LEADS_VIEW,
  integration: PERMISSIONS.INTEGRATIONS_VIEW,
  "workflow-run": PERMISSIONS.WORKFLOW_VIEW,
};

function resultHref(result: Phase1SearchResult): string {
  return safeInternalHref(result.href) ?? "/search";
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission(PERMISSIONS.SEARCH_VIEW, "search");
  const runtime = await getServerRuntime();
  const query = await searchParams;
  const text = typeof query.q === "string" ? query.q.trim().slice(0, 120) : "";
  const permissionEntries = Object.entries(resultPermissions) as Array<
    [Phase1SearchResult["type"], Permission]
  >;
  const decisions = await Promise.all(
    permissionEntries.map(([, permission]) =>
      runtime.authorization.authorizeUser(session.personaId, permission),
    ),
  );
  const allowedTypes = permissionEntries
    .filter((_, index) => decisions[index]?.allowed)
    .map(([type]) => type);
  const taskReadScope = await runtime.authorization.taskReadScopeForUser(session.personaId);
  const results =
    text.length >= 2 && allowedTypes.length
      ? await runtime.phase1.searchKeyword(text, {
          limit: 50,
          types: allowedTypes,
          ...(taskReadScope !== "all" && allowedTypes.includes("task")
            ? { taskAssigneeUserId: session.personaId }
            : {}),
        })
      : [];

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Permission-filtered discovery"
        title="Search"
        description="Search only the Phase 1 record types your current role may access."
        actions={text.length >= 2 ? <Badge tone="info">{results.length} results</Badge> : null}
      />
      <form action="/search" className="bea-search-page-form" role="search">
        <FormField label="Search records" htmlFor="search-page-query">
          <Input
            id="search-page-query"
            name="q"
            type="search"
            defaultValue={text}
            minLength={2}
            maxLength={120}
            required
          />
        </FormField>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      {text && text.length < 2 ? (
        <Alert tone="warning" title="More detail needed">
          Enter at least two characters to search.
        </Alert>
      ) : null}
      {text.length >= 2 ? (
        results.length ? (
          <TableFoundation>
            <Table>
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">Result</th>
                  <th scope="col">Context</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr key={`${result.type}:${result.id}`}>
                    <td>
                      <Badge>{result.type}</Badge>
                    </td>
                    <td>
                      <Link href={resultHref(result)}>{result.title}</Link>
                    </td>
                    <td>{result.subtitle}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        ) : (
          <EmptyState
            title="No permitted results"
            description="No accessible Phase 1 records match this search."
          />
        )
      ) : (
        <EmptyState
          title="Search the Command Center"
          description="Enter a company, contact, task, integration, or workflow term."
        />
      )}
    </div>
  );
}
