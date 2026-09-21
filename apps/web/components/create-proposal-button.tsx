"use client";

import type { ServiceCatalogVersion } from "@bea/domain";
import { Alert, Button, FormField } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function CreateProposalButton({
  leadId,
  catalogs,
  defaultCatalogVersionId = "",
}: {
  leadId: string;
  catalogs: readonly Pick<
    ServiceCatalogVersion,
    "id" | "catalogKey" | "versionNumber" | "status" | "synthetic"
  >[];
  defaultCatalogVersionId?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [catalogVersionId, setCatalogVersionId] = useState(defaultCatalogVersionId);

  async function create() {
    if (catalogs.length > 1 && !catalogVersionId) {
      setError("Select an active synthetic catalog before creating a proposal.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-from-lead",
          leadId,
          catalogVersionId: catalogVersionId || undefined,
        }),
      });
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      const body = (await response.json()) as {
        error?: { message?: string };
        record?: { proposal?: { id?: string } };
      };
      if (!response.ok || !body.record?.proposal?.id) {
        throw new Error(body.error?.message ?? "The proposal could not be created.");
      }
      router.push(`/proposals/${body.record.proposal.id}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The proposal could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bea-stack">
      {catalogs.length > 1 ? (
        <FormField label="Active synthetic catalog" htmlFor="create-proposal-catalog">
          <select
            id="create-proposal-catalog"
            className="bea-input"
            value={catalogVersionId}
            onChange={(event) => setCatalogVersionId(event.currentTarget.value)}
            data-testid="create-proposal-catalog"
          >
            {defaultCatalogVersionId ? null : <option value="">Select catalog</option>}
            {catalogs.map((catalog) => (
              <option key={catalog.id} value={catalog.id}>
                {catalog.catalogKey} v{catalog.versionNumber} ({catalog.status})
              </option>
            ))}
          </select>
        </FormField>
      ) : null}
      <Button type="button" data-testid="create-proposal" busy={busy} onClick={() => void create()}>
        Create proposal
      </Button>
      {error ? (
        <Alert tone="danger" title="Proposal creation failed">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}
