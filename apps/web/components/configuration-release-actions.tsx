"use client";

import { Alert, Button } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

async function postConfiguration(body: Record<string, unknown>) {
  const response = await fetch("/api/configuration", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as {
    error?: { message?: string };
    release?: { id: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? "Configuration action failed.");
  }
  return payload;
}

export function ConfigurationReleaseActions({
  releaseId,
  status,
  canDraft,
  canValidate,
  canPublish,
  canActivate,
  canArchive,
}: {
  releaseId: string;
  status: string;
  canDraft: boolean;
  canValidate: boolean;
  canPublish: boolean;
  canActivate: boolean;
  canArchive: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  async function run(action: string) {
    setBusy(action);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await postConfiguration({ action, releaseId });
      setMessage(
        action === "clone"
          ? "Cloned into a new draft. Published history is unchanged."
          : `Configuration ${action} completed.`,
      );
      if (action === "clone" && result.release?.id) {
        router.push(`/configuration/releases/${result.release.id}`);
        return;
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Configuration action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bea-stack">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {message ? <Alert tone="info">{message}</Alert> : null}
      <div className="bea-cluster">
        {canDraft ? (
          <Button
            type="button"
            variant="secondary"
            data-testid="configuration-clone"
            disabled={Boolean(busy) || status === "draft"}
            onClick={() => void run("clone")}
          >
            {busy === "clone" ? "Cloning…" : "Clone into new draft"}
          </Button>
        ) : null}
        {canValidate ? (
          <Button
            type="button"
            data-testid="configuration-validate"
            disabled={Boolean(busy)}
            onClick={() => void run("validate")}
          >
            {busy === "validate" ? "Validating…" : "Validate"}
          </Button>
        ) : null}
        {canPublish ? (
          <Button
            type="button"
            data-testid="configuration-publish"
            disabled={Boolean(busy) || status !== "validated"}
            onClick={() => void run("publish")}
          >
            {busy === "publish" ? "Publishing…" : "Publish"}
          </Button>
        ) : null}
        {canActivate ? (
          <>
            <Button
              type="button"
              data-testid="configuration-activate"
              disabled={Boolean(busy) || (status !== "published" && status !== "superseded")}
              onClick={() => void run("activate")}
            >
              {busy === "activate" ? "Activating…" : "Activate"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              data-testid="configuration-rollback"
              disabled={Boolean(busy) || (status !== "published" && status !== "superseded")}
              onClick={() => void run("rollback")}
            >
              {busy === "rollback" ? "Rolling back…" : "Roll back activation here"}
            </Button>
          </>
        ) : null}
        {canArchive ? (
          <Button
            type="button"
            variant="danger"
            data-testid="configuration-archive"
            disabled={Boolean(busy) || status === "active"}
            onClick={() => void run("archive")}
          >
            {busy === "archive" ? "Archiving…" : "Archive"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
