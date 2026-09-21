"use client";

import {
  LEAD_PARTY_ROLES,
  LEAD_SOURCE_LABELS,
  type Lead,
  type LeadParty,
  type LeadPartyRole,
  type LeadSourceType,
} from "@bea/domain";
import { Alert, Button, FormField, Input, Select } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { datetimeLocalValue, leadPartyRoleLabel } from "@/lib/lead-presentation";

interface RecordOption {
  readonly id: string;
  readonly label: string;
}

interface ContactOption extends RecordOption {
  readonly companyId: string | null;
}

interface PartyDraft {
  companyId: string;
  contactId: string;
  unmatchedCompanyName: string;
  unmatchedContactName: string;
  unmatchedEmail: string;
  unmatchedPhone: string;
}

function partyDraft(parties: readonly LeadParty[], role: LeadPartyRole): PartyDraft {
  const party = parties.find((entry) => entry.role === role);
  return {
    companyId: party?.companyId ?? "",
    contactId: party?.contactId ?? "",
    unmatchedCompanyName: party?.unmatchedCompanyName ?? "",
    unmatchedContactName: party?.unmatchedContactName ?? "",
    unmatchedEmail: party?.unmatchedEmail ?? "",
    unmatchedPhone: party?.unmatchedPhone ?? "",
  };
}

function contactsForParty(
  contacts: readonly ContactOption[],
  companyId: string,
  selectedContactId: string,
): readonly ContactOption[] {
  return contacts.filter(
    (contact) =>
      contact.id === selectedContactId ||
      !companyId ||
      !contact.companyId ||
      contact.companyId === companyId,
  );
}

function isoFromDatetimeLocal(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function LeadEditForm({
  lead,
  parties,
  companies,
  contacts = [],
  canViewContacts = false,
  reviewers,
}: {
  lead: Lead;
  parties: readonly LeadParty[];
  companies: readonly RecordOption[];
  contacts?: readonly ContactOption[];
  canViewContacts?: boolean;
  reviewers: readonly RecordOption[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [partyState, setPartyState] = useState<Record<LeadPartyRole, PartyDraft>>(
    () =>
      Object.fromEntries(
        LEAD_PARTY_ROLES.map((role) => [role, partyDraft(parties, role)]),
      ) as Record<LeadPartyRole, PartyDraft>,
  );

  function updateParty(role: LeadPartyRole, field: keyof PartyDraft, value: string) {
    setPartyState((current) => ({
      ...current,
      [role]: { ...current[role], [field]: value },
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/leads/${encodeURIComponent(lead.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: lead.version,
          sourceType: data.get("sourceType"),
          sourceDetails: data.get("sourceDetails"),
          receivedAt: isoFromDatetimeLocal(data.get("receivedAt")),
          opportunityName: data.get("opportunityName"),
          requestSummary: data.get("requestSummary"),
          requestedService: data.get("requestedService"),
          siteName: data.get("siteName"),
          siteAddressLine1: data.get("siteAddressLine1"),
          siteAddressLine2: data.get("siteAddressLine2"),
          siteCity: data.get("siteCity"),
          siteRegion: data.get("siteRegion"),
          sitePostalCode: data.get("sitePostalCode"),
          siteCountry: data.get("siteCountry"),
          desiredDeadlineAt: isoFromDatetimeLocal(data.get("desiredDeadlineAt")),
          requestedVisitAt: isoFromDatetimeLocal(data.get("requestedVisitAt")),
          reviewerUserId: data.get("reviewerUserId"),
          parties: LEAD_PARTY_ROLES.map((role) => ({
            role,
            companyId: partyState[role].companyId || null,
            contactId: partyState[role].contactId || null,
            unmatchedCompanyName: partyState[role].unmatchedCompanyName || null,
            unmatchedContactName: partyState[role].unmatchedContactName || null,
            unmatchedEmail: partyState[role].unmatchedEmail || null,
            unmatchedPhone: partyState[role].unmatchedPhone || null,
          })),
        }),
      });
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "The lead could not be updated.");
      }
      router.push(`/leads/${encodeURIComponent(lead.id)}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The lead could not be updated.");
      setBusy(false);
    }
  }

  return (
    <form className="bea-record-form" onSubmit={(event) => void submit(event)}>
      <div className="bea-form-grid">
        <FormField label="Intake source" htmlFor="lead-edit-source" required>
          <Select id="lead-edit-source" name="sourceType" required defaultValue={lead.sourceType}>
            {(Object.keys(LEAD_SOURCE_LABELS) as LeadSourceType[]).map((source) => (
              <option key={source} value={source}>
                {LEAD_SOURCE_LABELS[source]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Date and time received" htmlFor="lead-edit-received" required>
          <Input
            id="lead-edit-received"
            name="receivedAt"
            type="datetime-local"
            required
            defaultValue={datetimeLocalValue(lead.receivedAt)}
          />
        </FormField>
      </div>
      <FormField label="Source details or referral notes" htmlFor="lead-edit-details">
        <textarea
          id="lead-edit-details"
          name="sourceDetails"
          className="bea-input bea-textarea"
          maxLength={4000}
          defaultValue={lead.sourceDetails ?? ""}
        />
      </FormField>
      <FormField label="Opportunity or project name" htmlFor="lead-edit-opportunity" required>
        <Input
          id="lead-edit-opportunity"
          name="opportunityName"
          required
          maxLength={240}
          defaultValue={lead.opportunityName}
        />
      </FormField>
      <FormField label="Request summary" htmlFor="lead-edit-summary" required>
        <textarea
          id="lead-edit-summary"
          name="requestSummary"
          className="bea-input bea-textarea"
          required
          maxLength={4000}
          defaultValue={lead.requestSummary}
        />
      </FormField>
      <FormField label="Requested service" htmlFor="lead-edit-service">
        <Input
          id="lead-edit-service"
          name="requestedService"
          maxLength={240}
          defaultValue={lead.requestedService ?? ""}
        />
      </FormField>
      <fieldset className="bea-lead-fieldset">
        <legend>Site / project location</legend>
        <FormField label="Site or project name" htmlFor="lead-edit-site">
          <Input
            id="lead-edit-site"
            name="siteName"
            maxLength={240}
            defaultValue={lead.siteName ?? ""}
          />
        </FormField>
        <div className="bea-form-grid">
          <FormField label="Address line 1" htmlFor="lead-edit-line1">
            <Input
              id="lead-edit-line1"
              name="siteAddressLine1"
              maxLength={240}
              defaultValue={lead.siteAddressLine1 ?? ""}
            />
          </FormField>
          <FormField label="Address line 2" htmlFor="lead-edit-line2">
            <Input
              id="lead-edit-line2"
              name="siteAddressLine2"
              maxLength={240}
              defaultValue={lead.siteAddressLine2 ?? ""}
            />
          </FormField>
        </div>
        <div className="bea-form-grid">
          <FormField label="City" htmlFor="lead-edit-city">
            <Input
              id="lead-edit-city"
              name="siteCity"
              maxLength={120}
              defaultValue={lead.siteCity ?? ""}
            />
          </FormField>
          <FormField label="Region" htmlFor="lead-edit-region">
            <Input
              id="lead-edit-region"
              name="siteRegion"
              maxLength={120}
              defaultValue={lead.siteRegion ?? ""}
            />
          </FormField>
          <FormField label="Postal code" htmlFor="lead-edit-postal">
            <Input
              id="lead-edit-postal"
              name="sitePostalCode"
              maxLength={32}
              defaultValue={lead.sitePostalCode ?? ""}
            />
          </FormField>
          <FormField label="Country" htmlFor="lead-edit-country">
            <Input
              id="lead-edit-country"
              name="siteCountry"
              maxLength={120}
              defaultValue={lead.siteCountry ?? ""}
            />
          </FormField>
        </div>
      </fieldset>
      <div className="bea-form-grid">
        <FormField label="Desired deadline" htmlFor="lead-edit-deadline">
          <Input
            id="lead-edit-deadline"
            name="desiredDeadlineAt"
            type="datetime-local"
            defaultValue={datetimeLocalValue(lead.desiredDeadlineAt)}
          />
        </FormField>
        <FormField label="Requested visit" htmlFor="lead-edit-visit">
          <Input
            id="lead-edit-visit"
            name="requestedVisitAt"
            type="datetime-local"
            defaultValue={datetimeLocalValue(lead.requestedVisitAt)}
          />
        </FormField>
      </div>
      <FormField label="Reviewer" htmlFor="lead-edit-reviewer">
        <Select
          id="lead-edit-reviewer"
          name="reviewerUserId"
          defaultValue={lead.reviewerUserId ?? ""}
        >
          <option value="">Unassigned</option>
          {reviewers.map((reviewer) => (
            <option key={reviewer.id} value={reviewer.id}>
              {reviewer.label}
            </option>
          ))}
        </Select>
      </FormField>
      <fieldset className="bea-lead-fieldset">
        <legend>Companies, contacts, and business roles</legend>
        <p className="bea-field-message">
          Incomplete intake is allowed. Linked contacts are shown only when the current role can
          view contacts.
        </p>
        {LEAD_PARTY_ROLES.map((role) => (
          <div key={role} className="bea-lead-party-card">
            <h3>{leadPartyRoleLabel(role)}</h3>
            <div className="bea-form-grid">
              <FormField label="Linked company" htmlFor={`lead-edit-company-${role}`}>
                <Select
                  id={`lead-edit-company-${role}`}
                  value={partyState[role].companyId}
                  onChange={(event) => updateParty(role, "companyId", event.currentTarget.value)}
                >
                  <option value="">Not linked yet</option>
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.label}
                    </option>
                  ))}
                </Select>
              </FormField>
              {canViewContacts ? (
                <FormField label="Linked contact" htmlFor={`lead-edit-contact-${role}`}>
                  <Select
                    id={`lead-edit-contact-${role}`}
                    value={partyState[role].contactId}
                    onChange={(event) => updateParty(role, "contactId", event.currentTarget.value)}
                  >
                    <option value="">Not linked yet</option>
                    {contactsForParty(
                      contacts,
                      partyState[role].companyId,
                      partyState[role].contactId,
                    ).map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.label}
                      </option>
                    ))}
                  </Select>
                </FormField>
              ) : null}
              <FormField label="Unmatched company name" htmlFor={`lead-edit-company-name-${role}`}>
                <Input
                  id={`lead-edit-company-name-${role}`}
                  value={partyState[role].unmatchedCompanyName}
                  onChange={(event) =>
                    updateParty(role, "unmatchedCompanyName", event.currentTarget.value)
                  }
                  maxLength={240}
                />
              </FormField>
            </div>
            <div className="bea-form-grid">
              <FormField label="Person name" htmlFor={`lead-edit-person-${role}`}>
                <Input
                  id={`lead-edit-person-${role}`}
                  value={partyState[role].unmatchedContactName}
                  onChange={(event) =>
                    updateParty(role, "unmatchedContactName", event.currentTarget.value)
                  }
                  maxLength={240}
                />
              </FormField>
              <FormField label="Email" htmlFor={`lead-edit-email-${role}`}>
                <Input
                  id={`lead-edit-email-${role}`}
                  type="email"
                  value={partyState[role].unmatchedEmail}
                  onChange={(event) =>
                    updateParty(role, "unmatchedEmail", event.currentTarget.value)
                  }
                  maxLength={240}
                />
              </FormField>
              <FormField label="Phone" htmlFor={`lead-edit-phone-${role}`}>
                <Input
                  id={`lead-edit-phone-${role}`}
                  value={partyState[role].unmatchedPhone}
                  onChange={(event) =>
                    updateParty(role, "unmatchedPhone", event.currentTarget.value)
                  }
                  maxLength={64}
                />
              </FormField>
            </div>
          </div>
        ))}
      </fieldset>
      {error ? (
        <Alert tone="danger" title="Lead not updated">
          {error}
        </Alert>
      ) : null}
      <div className="bea-record-actions">
        <Button type="submit" busy={busy}>
          Save intake
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => router.push(`/leads/${lead.id}`)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
