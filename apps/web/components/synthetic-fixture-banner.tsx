"use client";

import { Alert, Badge } from "@bea/ui";
import { OPERATIONS_SYNTHETIC_DISCLOSURE } from "@/lib/operations-presentation";

export function SyntheticFixtureBanner({
  synthetic,
  title = "Synthetic fixture",
}: {
  synthetic: boolean;
  title?: string;
}) {
  if (!synthetic) return null;
  return (
    <Alert tone="info" title={title} data-testid="synthetic-disclosure">
      {OPERATIONS_SYNTHETIC_DISCLOSURE} Live Microsoft 365 delivery is NOT CONNECTED. BEA production
      report template mapping is NOT CONFIGURED. Local-test delivery is not client delivery.
    </Alert>
  );
}

export function SyntheticFixtureBadge({ synthetic }: { synthetic: boolean }) {
  if (!synthetic) return null;
  return (
    <Badge tone="warning" data-testid="synthetic-badge">
      SYNTHETIC FIXTURE
    </Badge>
  );
}
