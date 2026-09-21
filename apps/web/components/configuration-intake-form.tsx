"use client";

import { Alert, Button, FormField, Input, Select, Textarea } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

const STATUSES = [
  "unknown",
  "assumed_for_demo",
  "awaiting_bea_confirmation",
  "confirmed",
  "configured",
  "tested",
  "approved",
] as const;

export function ConfigurationIntakeForm({
  items,
  canEdit,
}: {
  items: readonly {
    id: string;
    questionKey: string;
    sectionKey: string;
    prompt: string;
    status: string;
    answer: string | null;
    notes: string | null;
    version: number;
  }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? "");
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const [status, setStatus] = useState(selected?.status ?? "unknown");
  const [answer, setAnswer] = useState(selected?.answer ?? "");
  const [notes, setNotes] = useState(selected?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  function choose(id: string) {
    const next = items.find((item) => item.id === id);
    setSelectedId(id);
    setStatus(next?.status ?? "unknown");
    setAnswer(next?.answer ?? "");
    setNotes(next?.notes ?? "");
  }

  async function save() {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const response = await fetch("/api/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update-intake",
          itemId: selected.id,
          status,
          answer,
          notes,
          expectedVersion: selected.version,
        }),
      });
      const payload = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        setError(payload.error?.message ?? "Intake update failed.");
        return;
      }
      setMessage("Intake item saved. Synthetic defaults are not treated as BEA confirmation.");
      router.refresh();
    } catch {
      setError("Intake update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadPacket() {
    const response = await fetch("/api/configuration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "export-intake" }),
    });
    const payload = (await response.json()) as {
      packet?: { markdown?: string; json?: unknown };
      error?: { message?: string };
    };
    if (!response.ok) {
      setError(payload.error?.message ?? "Export failed.");
      return;
    }
    const blob = new Blob([payload.packet?.markdown ?? ""], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "BEA-configuration-intake-packet.md";
    link.click();
    URL.revokeObjectURL(url);
  }

  if (!selected) return <p>No intake questions are registered.</p>;

  return (
    <div className="bea-stack">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {message ? <Alert tone="info">{message}</Alert> : null}
      <FormField label="Question" htmlFor="intake-item">
        <Select
          id="intake-item"
          value={selected.id}
          onChange={(event) => choose(event.target.value)}
        >
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.sectionKey}: {item.prompt}
            </option>
          ))}
        </Select>
      </FormField>
      <p data-testid="intake-prompt">{selected.prompt}</p>
      <FormField label="Status" htmlFor="intake-status">
        <Select
          id="intake-status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          disabled={!canEdit}
        >
          {STATUSES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Answer" htmlFor="intake-answer">
        <Input
          id="intake-answer"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          disabled={!canEdit}
        />
      </FormField>
      <FormField label="Notes" htmlFor="intake-notes">
        <Textarea
          id="intake-notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          disabled={!canEdit}
          rows={4}
        />
      </FormField>
      {canEdit ? (
        <Button type="button" data-testid="intake-save" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save intake item"}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        data-testid="intake-export"
        onClick={() => void downloadPacket()}
      >
        Export meeting packet
      </Button>
    </div>
  );
}
