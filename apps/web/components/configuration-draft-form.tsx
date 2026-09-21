"use client";

import { Alert, Button, FormField, Input } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ConfigurationDraftForm({ canDraft }: { canDraft: boolean }) {
  const router = useRouter();
  const [familyKey, setFamilyKey] = useState("synthetic-lab-family");
  const [displayName, setDisplayName] = useState("Synthetic lab draft");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (!canDraft) return null;

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-draft",
          familyKey,
          displayName,
          serviceContextKey: familyKey,
          description:
            "Draft operational configuration. Synthetic unless BEA production materials are mapped.",
          synthetic: true,
        }),
      });
      const payload = (await response.json()) as {
        error?: { message?: string };
        release?: { id: string };
      };
      if (!response.ok) {
        setError(payload.error?.message ?? "Draft creation failed.");
        return;
      }
      if (payload.release?.id) router.push(`/configuration/releases/${payload.release.id}`);
    } catch {
      setError("Draft creation failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bea-stack">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <FormField label="Family key" htmlFor="draft-family">
        <Input
          id="draft-family"
          value={familyKey}
          onChange={(event) => setFamilyKey(event.target.value)}
        />
      </FormField>
      <FormField label="Display name" htmlFor="draft-name">
        <Input
          id="draft-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </FormField>
      <Button
        type="button"
        data-testid="configuration-create-draft"
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy ? "Creating…" : "Create draft"}
      </Button>
    </div>
  );
}
