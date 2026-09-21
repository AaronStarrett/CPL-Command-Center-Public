import { AccessDenied, Badge, PageHeader } from "@bea/ui";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Access denied" };

export default async function AccessDeniedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const resource =
    typeof query.resource === "string"
      ? query.resource.replace(/[^a-z0-9-]/giu, " ")
      : "requested area";

  return (
    <div className="bea-stack bea-stack--large" data-testid="access-denied">
      <PageHeader
        eyebrow="Authorization boundary"
        title="Access denied"
        actions={<Badge tone="danger">Denied</Badge>}
      />
      <AccessDenied
        description={`Your current account does not have the server-side permission required for ${resource}.`}
      />
    </div>
  );
}
