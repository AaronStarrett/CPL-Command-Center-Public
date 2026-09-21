"use client";

import {
  QUANTITY_SCALE_NUMBER,
  quantityToScaled,
  scaledToQuantityString,
  toSafeIntegerNumber,
  type Proposal,
  type ProposalLineDraft,
  type ServiceCatalogItemDefinition,
} from "@bea/domain";
import { Alert, Button, FormField } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

export function ProposalBuilderForm({
  proposal,
  lines,
  items,
  canEdit,
}: {
  proposal: Proposal;
  lines: readonly ProposalLineDraft[];
  items: readonly ServiceCatalogItemDefinition[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const selected = useMemo(() => new Map(lines.map((line) => [line.serviceKey, line])), [lines]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [scopeText, setScopeText] = useState(proposal.scopeText);
  const [assumptions, setAssumptions] = useState(proposal.assumptions.join("\n"));
  const [exclusions, setExclusions] = useState(proposal.exclusions.join("\n"));
  const [deliverables, setDeliverables] = useState(proposal.deliverables.join("\n"));
  const [quantities, setQuantities] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const item of items) {
      const existing = selected.get(item.serviceKey);
      initial[item.serviceKey] = existing
        ? scaledToQuantityString(BigInt(existing.quantityScaled))
        : scaledToQuantityString(BigInt(item.minimumQuantityScaled));
    }
    return initial;
  });
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const item of items) initial[item.serviceKey] = selected.has(item.serviceKey);
    return initial;
  });

  if (!canEdit) return null;

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const nextLines = items
        .filter((item) => checked[item.serviceKey])
        .map((item) => ({
          serviceKey: item.serviceKey,
          quantityScaled: toSafeIntegerNumber(
            quantityToScaled(quantities[item.serviceKey] ?? "1"),
            `${item.serviceKey} quantity`,
          ),
        }));
      const response = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update-draft",
          expectedVersion: proposal.version,
          scopeText,
          assumptions: assumptions
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
          exclusions: exclusions
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
          deliverables: deliverables
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
          lines: nextLines,
        }),
      });
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "The draft could not be saved.");
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The draft could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="bea-stack"
      data-testid="proposal-builder"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset className="bea-stack">
        <legend>Synthetic services</legend>
        {items.map((item) => (
          <label key={item.serviceKey} className="bea-cluster">
            <input
              type="checkbox"
              checked={Boolean(checked[item.serviceKey])}
              onChange={(event) => {
                const nextChecked = event.currentTarget.checked;
                setChecked((current) => ({
                  ...current,
                  [item.serviceKey]: nextChecked,
                }));
              }}
              data-testid={`proposal-service-${item.serviceKey}`}
            />
            <span>
              {item.displayName} · {item.pricingModel} · {item.defaultRateMinor} cents /{" "}
              {item.unitOfMeasure}
            </span>
            <input
              className="bea-input"
              type="number"
              min={Number(item.minimumQuantityScaled) / QUANTITY_SCALE_NUMBER}
              max={Number(item.maximumQuantityScaled) / QUANTITY_SCALE_NUMBER}
              step={0.0001}
              value={quantities[item.serviceKey] ?? "1"}
              onChange={(event) => {
                const nextQuantity = event.currentTarget.value;
                setQuantities((current) => ({
                  ...current,
                  [item.serviceKey]: nextQuantity,
                }));
              }}
              data-testid={`proposal-qty-${item.serviceKey}`}
            />
          </label>
        ))}
      </fieldset>
      <FormField label="Scope of services" htmlFor="proposal-scope">
        <textarea
          id="proposal-scope"
          className="bea-input bea-textarea"
          value={scopeText}
          onChange={(event) => setScopeText(event.currentTarget.value)}
          data-testid="proposal-scope"
        />
      </FormField>
      <FormField label="Deliverables (one per line)" htmlFor="proposal-deliverables">
        <textarea
          id="proposal-deliverables"
          className="bea-input bea-textarea"
          value={deliverables}
          onChange={(event) => setDeliverables(event.currentTarget.value)}
        />
      </FormField>
      <FormField label="Assumptions (one per line)" htmlFor="proposal-assumptions">
        <textarea
          id="proposal-assumptions"
          className="bea-input bea-textarea"
          value={assumptions}
          onChange={(event) => setAssumptions(event.currentTarget.value)}
        />
      </FormField>
      <FormField label="Exclusions (one per line)" htmlFor="proposal-exclusions">
        <textarea
          id="proposal-exclusions"
          className="bea-input bea-textarea"
          value={exclusions}
          onChange={(event) => setExclusions(event.currentTarget.value)}
        />
      </FormField>
      <Button type="submit" busy={busy} data-testid="proposal-save-draft">
        Save draft
      </Button>
      {error ? (
        <Alert tone="danger" title="Draft save failed">
          {error}
        </Alert>
      ) : null}
    </form>
  );
}
