import { PERMISSIONS, type Permission } from "@bea/security";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, PageHeader } from "@bea/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requirePermission } from "@/lib/auth/authorization";

interface DeferredFeature {
  title: string;
  description: string;
  permission: Permission;
  boundary: string;
}

const deferredFeatures: Record<string, DeferredFeature> = {
  communications: {
    title: "Communications",
    description: "Contextual email, Teams, phone, and client correspondence workflows.",
    permission: PERMISSIONS.COMMUNICATIONS_VIEW,
    boundary: "External communication workflows remain deferred.",
  },
  documents: {
    title: "Documents",
    description: "Project documents, controlled templates, evidence, and SharePoint boundaries.",
    permission: PERMISSIONS.DOCUMENTS_VIEW,
    boundary: "External document repositories remain disconnected.",
  },
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ feature: string }>;
}): Promise<Metadata> {
  const { feature } = await params;
  return { title: deferredFeatures[feature]?.title ?? "Not found" };
}

export default async function DeferredFeaturePage({
  params,
}: {
  params: Promise<{ feature: string }>;
}) {
  const { feature } = await params;
  const definition = deferredFeatures[feature];
  if (!definition) notFound();
  await requirePermission(definition.permission, feature);

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Future module"
        title={definition.title}
        description={definition.description}
        actions={<Badge tone="warning">DEFERRED</Badge>}
      />
      <Card className="bea-deferred-card">
        <CardHeader>
          <CardTitle>Intentionally outside the current Phase 1 scope</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            title={`${definition.title} is deferred`}
            description={`${definition.boundary} The route is present only to validate navigation, role boundaries, and the future information architecture.`}
          />
        </CardContent>
      </Card>
    </div>
  );
}
