"use client";

import { Alert, Button, FormField, Input, Select } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

interface RecordOption {
  readonly id: string;
  readonly label: string;
}

type ContactLoadState = "idle" | "loading" | "ready" | "empty" | "error";
type TaskRelationshipField = "companyId" | "contactId";

interface TaskApiError {
  readonly message?: string;
  readonly field?: TaskRelationshipField;
}

export function TaskCreateForm({
  companies,
  contactsEnabled,
  leadId,
  defaultTitle,
}: {
  companies: readonly RecordOption[];
  contactsEnabled: boolean;
  leadId?: string;
  defaultTitle?: string;
}) {
  const router = useRouter();
  const contactRequest = useRef<AbortController | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<TaskRelationshipField, string>>>(
    {},
  );
  const [companyId, setCompanyId] = useState("");
  const [contactId, setContactId] = useState("");
  const [contacts, setContacts] = useState<readonly RecordOption[]>([]);
  const [contactLoadState, setContactLoadState] = useState<ContactLoadState>("idle");

  useEffect(
    () => () => {
      contactRequest.current?.abort();
    },
    [],
  );

  async function loadContacts(selectedCompanyId: string, controller: AbortController) {
    try {
      const response = await fetch(
        `/api/companies/${encodeURIComponent(selectedCompanyId)}/contacts`,
        { headers: { Accept: "application/json" }, signal: controller.signal },
      );
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      const body = (await response.json()) as {
        companyId?: string;
        contacts?: readonly RecordOption[];
        error?: { message?: string };
      };
      if (
        !response.ok ||
        body.companyId !== selectedCompanyId ||
        !Array.isArray(body.contacts) ||
        body.contacts.some(
          (contact) =>
            !contact || typeof contact.id !== "string" || typeof contact.label !== "string",
        )
      ) {
        throw new Error(body.error?.message ?? "Contacts are unavailable for this company.");
      }
      if (controller.signal.aborted) return;
      setContacts(body.contacts);
      setContactLoadState(body.contacts.length > 0 ? "ready" : "empty");
    } catch {
      if (controller.signal.aborted) return;
      setContacts([]);
      setContactLoadState("error");
      setFieldErrors((current) => ({
        ...current,
        contactId: "Contacts are unavailable for this company.",
      }));
    }
  }

  function changeCompany(event: ChangeEvent<HTMLSelectElement>) {
    const selectedCompanyId = event.currentTarget.value;
    contactRequest.current?.abort();
    setCompanyId(selectedCompanyId);
    setContactId("");
    setContacts([]);
    setError(undefined);
    setFieldErrors({});
    if (!selectedCompanyId || !contactsEnabled) {
      setContactLoadState("idle");
      return;
    }
    const controller = new AbortController();
    contactRequest.current = controller;
    setContactLoadState("loading");
    void loadContacts(selectedCompanyId, controller);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setFieldErrors({});
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: data.get("title"),
          description: data.get("description"),
          priority: data.get("priority"),
          dueAt: data.get("dueAt"),
          companyId,
          contactId,
          ...(leadId ? { leadId } : {}),
        }),
      });
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      const body = (await response.json()) as {
        task?: { id?: string };
        error?: TaskApiError;
      };
      if (!response.ok || !body.task?.id) {
        const message = body.error?.message ?? "The task could not be created.";
        if (body.error?.field === "companyId" || body.error?.field === "contactId") {
          setFieldErrors({ [body.error.field]: message });
          setBusy(false);
          return;
        }
        throw new Error(message);
      }
      router.push(`/tasks/${encodeURIComponent(body.task.id)}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The task could not be created.");
      setBusy(false);
    }
  }

  let contactPlaceholder = "Select a company first";
  if (contactLoadState === "loading") contactPlaceholder = "Loading contacts…";
  if (contactLoadState === "ready") contactPlaceholder = "No linked contact";
  if (contactLoadState === "empty") contactPlaceholder = "No contacts available for this company";
  if (contactLoadState === "error") contactPlaceholder = "Contacts unavailable";

  let contactStatus = "Select a company to load its contacts.";
  if (contactLoadState === "loading") contactStatus = "Loading contacts for the selected company.";
  if (contactLoadState === "ready") {
    contactStatus = `${contacts.length} ${contacts.length === 1 ? "contact" : "contacts"} available.`;
  }
  if (contactLoadState === "empty") contactStatus = "No contacts are available for this company.";
  if (contactLoadState === "error") contactStatus = "Contacts could not be loaded.";

  return (
    <form className="bea-record-form" onSubmit={(event) => void submit(event)}>
      <FormField label="Title" htmlFor="task-title" required>
        <Input id="task-title" name="title" required maxLength={160} defaultValue={defaultTitle} />
      </FormField>
      <FormField label="Description" htmlFor="task-description">
        <textarea
          id="task-description"
          name="description"
          className="bea-input bea-textarea"
          maxLength={4000}
        />
      </FormField>
      <div className="bea-form-grid">
        <FormField label="Priority" htmlFor="task-priority" required>
          <Select id="task-priority" name="priority" defaultValue="normal" required>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </Select>
        </FormField>
        <FormField label="Due date and time" htmlFor="task-due-at">
          <Input id="task-due-at" name="dueAt" type="datetime-local" />
        </FormField>
      </div>
      <FormField label="Company" htmlFor="task-company" error={fieldErrors.companyId}>
        <Select
          id="task-company"
          name="companyId"
          value={companyId}
          disabled={busy}
          onChange={changeCompany}
        >
          <option value="">No linked company</option>
          {companies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.label}
            </option>
          ))}
        </Select>
      </FormField>
      {contactsEnabled ? (
        <div
          className="bea-task-contact-region"
          data-contact-state={contactLoadState}
          data-testid="task-contact-region"
        >
          <FormField
            label="Contact"
            htmlFor="task-contact"
            error={fieldErrors.contactId}
            hint="Contacts are loaded only for the selected company."
          >
            <Select
              id="task-contact"
              name="contactId"
              value={contactId}
              disabled={
                busy ||
                !companyId ||
                contactLoadState === "idle" ||
                contactLoadState === "loading" ||
                contactLoadState === "empty" ||
                contactLoadState === "error"
              }
              onChange={(event) => {
                setContactId(event.currentTarget.value);
                setFieldErrors((current) => ({ ...current, contactId: undefined }));
              }}
            >
              <option value="">{contactPlaceholder}</option>
              {contacts.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.label}
                </option>
              ))}
            </Select>
          </FormField>
          <p
            key={contactLoadState}
            className="bea-task-contact-status"
            role="status"
            aria-live="polite"
          >
            {contactStatus}
          </p>
        </div>
      ) : null}
      <Alert tone="info" title="Assignment">
        The new task will be assigned to the current signed-in persona.
      </Alert>
      {error ? (
        <Alert tone="danger" title="Task not created">
          {error}
        </Alert>
      ) : null}
      <div className="bea-record-actions">
        <Button type="submit" busy={busy}>
          Create task
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => router.push("/tasks")}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
