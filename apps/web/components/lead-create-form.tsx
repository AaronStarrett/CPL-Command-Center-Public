"use client";

import {
  LEAD_PARTY_ROLES,
  LEAD_SOURCE_LABELS,
  type LeadPartyRole,
  type LeadSourceType,
} from "@bea/domain";
import { Alert, Button, FormField, Input, Select } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { leadPartyRoleLabel } from "@/lib/lead-presentation";

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

const emptyParty = (): PartyDraft => ({
  companyId: "",
  contactId: "",
  unmatchedCompanyName: "",
  unmatchedContactName: "",
  unmatchedEmail: "",
  unmatchedPhone: "",
});

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

export function LeadCreateForm({
  companies,
  contacts = [],
  canViewContacts = false,
  reviewers,
}: {
  companies: readonly RecordOption[];
  contacts?: readonly ContactOption[];
  canViewContacts?: boolean;
  reviewers: readonly RecordOption[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [parties, setParties] = useState<Record<LeadPartyRole, PartyDraft>>(
    () =>
      Object.fromEntries(LEAD_PARTY_ROLES.map((role) => [role, emptyParty()])) as Record<
        LeadPartyRole,
        PartyDraft
      >,
  );

  function updateParty(role: LeadPartyRole, field: keyof PartyDraft, value: string) {
    setParties((current) => ({
      ...current,
      [role]: { ...current[role], [field]: value },
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    const payload = {
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
      siteCountry: data.get("siteCountry") || "US",
      desiredDeadlineAt: isoFromDatetimeLocal(data.get("desiredDeadlineAt")),
      requestedVisitAt: isoFromDatetimeLocal(data.get("requestedVisitAt")),
      reviewerUserId: data.get("reviewerUserId"),
      parties: LEAD_PARTY_ROLES.map((role) => ({
        role,
        companyId: parties[role].companyId || null,
        contactId: parties[role].contactId || null,
        unmatchedCompanyName: parties[role].unmatchedCompanyName || null,
        unmatchedContactName: parties[role].unmatchedContactName || null,
        unmatchedEmail: parties[role].unmatchedEmail || null,
        unmatchedPhone: parties[role].unmatchedPhone || null,
      })),
    };
    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      const body = (await response.json()) as {
        lead?: { lead?: { id?: string } };
        error?: { message?: string };
      };
      const id = body.lead?.lead?.id;
      if (!response.ok || !id) {
        throw new Error(body.error?.message ?? "The lead could not be created.");
      }
      router.push(`/leads/${encodeURIComponent(id)}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The lead could not be created.");
      setBusy(false);
    }
  }

  return (
    <form className="bea-record-form" onSubmit={(event) => void submit(event)} noValidate>
      <div className="bea-form-grid">
        <FormField
          label="Intake source"
          htmlFor="lead-source-type"
          required
          hint="Manual, referral, and in-person intake write into the same lead record."
        >
          <Select id="lead-source-type" name="sourceType" required defaultValue="manual">
            {(Object.keys(LEAD_SOURCE_LABELS) as LeadSourceType[]).map((source) => (
              <option key={source} value={source}>
                {LEAD_SOURCE_LABELS[source]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Date and time received" htmlFor="lead-received-at" required>
          <Input id="lead-received-at" name="receivedAt" type="datetime-local" required />
        </FormField>
      </div>
      <FormField
        label="Source details or referral notes"
        htmlFor="lead-source-details"
        hint="Required later for referral review readiness. Optional for manual and in-person intake."
      >
        <textarea
          id="lead-source-details"
          name="sourceDetails"
          className="bea-input bea-textarea"
          maxLength={4000}
        />
      </FormField>
      <FormField label="Opportunity or project name" htmlFor="lead-opportunity" required>
        <Input id="lead-opportunity" name="opportunityName" required maxLength={240} />
      </FormField>
      <FormField label="Request summary" htmlFor="lead-summary" required>
        <textarea
          id="lead-summary"
          name="requestSummary"
          className="bea-input bea-textarea"
          required
          maxLength={4000}
        />
      </FormField>
      <FormField
        label="Requested service"
        htmlFor="lead-service"
        hint="Controlled free text until the Service Catalog exists. Required before ready-for-proposal."
      >
        <Input id="lead-service" name="requestedService" maxLength={240} />
      </FormField>
      <fieldset className="bea-lead-fieldset">
        <legend>Site / project location</legend>
        <p className="bea-field-message">Optional until later proposal and visit planning.</p>
        <FormField label="Site or project name" htmlFor="lead-site-name">
          <Input id="lead-site-name" name="siteName" maxLength={240} />
        </FormField>
        <div className="bea-form-grid">
          <FormField label="Address line 1" htmlFor="lead-site-line1">
            <Input id="lead-site-line1" name="siteAddressLine1" maxLength={240} />
          </FormField>
          <FormField label="Address line 2" htmlFor="lead-site-line2">
            <Input id="lead-site-line2" name="siteAddressLine2" maxLength={240} />
          </FormField>
        </div>
        <div className="bea-form-grid">
          <FormField label="City" htmlFor="lead-site-city">
            <Input id="lead-site-city" name="siteCity" maxLength={120} />
          </FormField>
          <FormField label="Region" htmlFor="lead-site-region">
            <Input id="lead-site-region" name="siteRegion" maxLength={120} />
          </FormField>
          <FormField label="Postal code" htmlFor="lead-site-postal">
            <Input id="lead-site-postal" name="sitePostalCode" maxLength={32} />
          </FormField>
          <FormField label="Country" htmlFor="lead-site-country">
            <Input id="lead-site-country" name="siteCountry" maxLength={120} defaultValue="US" />
          </FormField>
        </div>
      </fieldset>
      <div className="bea-form-grid">
        <FormField label="Desired deadline" htmlFor="lead-deadline" hint="Optional.">
          <Input id="lead-deadline" name="desiredDeadlineAt" type="datetime-local" />
        </FormField>
        <FormField
          label="Requested visit"
          htmlFor="lead-visit"
          hint="Optional. Not a scheduling gate."
        >
          <Input id="lead-visit" name="requestedVisitAt" type="datetime-local" />
        </FormField>
      </div>
      <FormField
        label="Reviewer"
        htmlFor="lead-reviewer"
        hint="Optional. Assignment uses role permissions, not a person’s name."
      >
        <Select id="lead-reviewer" name="reviewerUserId" defaultValue="">
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
          Incomplete intake is allowed. Do not conflate the requester, client company, approval
          authority, or billing contact. Canonical company and contact records may be linked when
          known.
        </p>
        {LEAD_PARTY_ROLES.map((role) => (
          <div key={role} className="bea-lead-party-card">
            <h3>{leadPartyRoleLabel(role)}</h3>
            <div className="bea-form-grid">
              <FormField label="Linked company" htmlFor={`lead-party-company-${role}`}>
                <Select
                  id={`lead-party-company-${role}`}
                  value={parties[role].companyId}
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
                <FormField label="Linked contact" htmlFor={`lead-party-contact-${role}`}>
                  <Select
                    id={`lead-party-contact-${role}`}
                    value={parties[role].contactId}
                    onChange={(event) => updateParty(role, "contactId", event.currentTarget.value)}
                  >
                    <option value="">Not linked yet</option>
                    {contactsForParty(
                      contacts,
                      parties[role].companyId,
                      parties[role].contactId,
                    ).map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.label}
                      </option>
                    ))}
                  </Select>
                </FormField>
              ) : null}
              <FormField label="Unmatched company name" htmlFor={`lead-party-company-name-${role}`}>
                <Input
                  id={`lead-party-company-name-${role}`}
                  value={parties[role].unmatchedCompanyName}
                  onChange={(event) =>
                    updateParty(role, "unmatchedCompanyName", event.currentTarget.value)
                  }
                  maxLength={240}
                />
              </FormField>
            </div>
            <div className="bea-form-grid">
              <FormField label="Person name" htmlFor={`lead-party-person-${role}`}>
                <Input
                  id={`lead-party-person-${role}`}
                  value={parties[role].unmatchedContactName}
                  onChange={(event) =>
                    updateParty(role, "unmatchedContactName", event.currentTarget.value)
                  }
                  maxLength={240}
                />
              </FormField>
              <FormField label="Email" htmlFor={`lead-party-email-${role}`}>
                <Input
                  id={`lead-party-email-${role}`}
                  type="email"
                  value={parties[role].unmatchedEmail}
                  onChange={(event) =>
                    updateParty(role, "unmatchedEmail", event.currentTarget.value)
                  }
                  maxLength={240}
                />
              </FormField>
              <FormField label="Phone" htmlFor={`lead-party-phone-${role}`}>
                <Input
                  id={`lead-party-phone-${role}`}
                  value={parties[role].unmatchedPhone}
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
        <Alert tone="danger" title="Lead not created">
          {error}
        </Alert>
      ) : null}
      <div className="bea-record-actions">
        <Button type="submit" busy={busy}>
          Create lead
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => router.push("/leads")}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
