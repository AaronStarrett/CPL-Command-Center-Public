"use client";

import type { ServiceCatalogVersion } from "@bea/domain";
import { Alert, Button } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function CatalogLifecycleActions({
  version,
  canManage,
  canPublish,
}: {
  version: Pick<
    ServiceCatalogVersion,
    "id" | "status" | "synthetic" | "catalogKey" | "versionNumber"
  >;
  canManage: boolean;
  canPublish: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function post(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, catalogVersionId: version.id, ...extra }),
      });
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "The catalog action could not be completed.");
      }
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The catalog action could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bea-cluster">
      {canManage ? (
        <>
          <Button
            type="button"
            variant="secondary"
            busy={busy}
            onClick={() => void post("validate")}
          >
            Validate
          </Button>
          <Button type="button" variant="secondary" busy={busy} onClick={() => void post("clone")}>
            Clone draft
          </Button>
        </>
      ) : null}
      {canPublish ? (
        <>
          <Button
            type="button"
            variant="secondary"
            busy={busy}
            onClick={() => void post("publish")}
          >
            Publish
          </Button>
          <Button
            type="button"
            busy={busy}
            onClick={() => void post("activate")}
            data-testid={`catalog-activate-${version.id}`}
          >
            Activate
          </Button>
        </>
      ) : null}
      {error ? (
        <Alert tone="danger" title="Catalog action failed">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}
