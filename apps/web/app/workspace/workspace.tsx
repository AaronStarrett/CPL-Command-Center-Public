"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { CplWorkflowLead, CplProposalDraft, CplWorkflowJob } from "@bea/database/hosted";
import { AppLogo } from "@/components/app-logo";
import styles from "./workspace.module.css";
import { CommercialWorkspace } from "./commercial-workspace";
import { ActionCenter } from "./action-center";
import type { CplActionTarget } from "@bea/domain/cpl-automation";
import type { WorkspaceRecordIntent } from "./phase4-ui";
import { uploadFieldPhoto, FieldUploadError, type FieldUploadInput } from "./field-upload";
import type { ProposalIntent } from "./commercial-ui";
import { executionConflicts } from "./commercial-ui";
import { useUnsavedNavigation } from "./commercial-navigation";
import {
  LeadWorkspace,
  type IntakeDirectory,
  type IntakePermissions,
  type LeadInput,
} from "./lead-workspace";

type Organization = { id: string; displayName: string; slug: string };
type Session = {
  authenticated: boolean;
  authenticationMode?: "local-development" | "google";
  synthetic?: boolean;
  identity?: { id: string; displayName: string; email: string };
  session?: {
    expiresAt: string;
    currentOrganizationId: string | null;
    stepUpRequired: boolean;
    hasPasskey: boolean;
  };
  csrfToken?: string;
};
type WorkspaceData = {
  organizations: Organization[];
  currentOrganizationId: string | null;
  leads: CplWorkflowLead[];
  proposals: CplProposalDraft[];
  jobs: CplWorkflowJob[];
  permissions?: IntakePermissions;
  intakeDirectory?: IntakeDirectory;
};
const noPermissions: IntakePermissions = {
  canCreateLead: false,
  canEditLead: false,
  canReviewLead: false,
  canCreateProposal: false,
  canEditProposal: false,
};
const emptyDirectory: IntakeDirectory = { customers: [], contacts: [], sites: [], members: [] };
const emptyData: WorkspaceData = {
  organizations: [],
  currentOrganizationId: null,
  leads: [],
  proposals: [],
  jobs: [],
};
const messages: Record<string, string> = {
  CPL_HOSTED_NOT_CONFIGURED:
    "Sign-in is awaiting deployment configuration. Please contact the workspace owner.",
  CPL_HOSTED_AUTH_NOT_CONFIGURED:
    "Sign-in is awaiting deployment configuration. Please contact the workspace owner.",
  CPL_ACCESS_DENIED: "Your session or permission could not be verified. Sign in again to continue.",
  CPL_AUTHENTICATION_REQUIRED: "Your session expired. Sign in again to continue.",
  CPL_CSRF_REJECTED: "Your sign-in state changed. Refresh and try again.",
  CPL_PLATFORM_MFA_REQUIRED: "Verify your passkey before changing organization settings.",
  CPL_PROPOSAL_VERSION_CONFLICT:
    "This draft changed in another session. Refresh before editing again.",
  CPL_RECENT_MFA_REQUIRED: "Verify your passkey before changing organization settings.",
  CPL_PROPOSAL_NOT_READY:
    "This version is still being prepared. Refresh its status after background preparation finishes.",
  CPL_VERSION_CONFLICT:
    "This record changed in another session. Refresh and review the latest version before saving again.",
  CPL_INVALID_INPUT: "Check the required fields and try again.",
  CPL_FRESH_AUTHENTICATION_REQUIRED: "Sign out and sign in again to enroll your first passkey.",
  CPL_ORGANIZATION_CONTEXT_CHANGED:
    "The selected organization changed in another tab. Review the current organization before entering records again.",
  CPL_ORGANIZATION_SLUG_TAKEN: "That organization address is already in use. Choose another.",
  CPL_LEAD_VERSION_CONFLICT:
    "This lead changed in another session. Your entries are kept. Refresh, then review the latest version before saving again.",
  CPL_LEAD_NOT_READY:
    "Resolve the lead’s missing information and conflicts before marking it ready for proposal.",
  CPL_LEAD_REVIEW_REQUIRED: "A reviewer must mark the lead ready before a proposal can be created.",
  CPL_DUPLICATE_REVIEW_CONFLICT:
    "The possible duplicate changed. Refresh the lead and review the match again.",
  CPL_REFERENCE_CONFLICT:
    "The selected contact or site belongs to a different customer. Review the linked records.",
  CPL_ASSIGNEE_UNAVAILABLE:
    "That member is no longer available. Refresh and choose an active member.",
  CPL_RECORD_NOT_FOUND:
    "This record is not available in the current organization. Refresh the workspace.",
  CPL_PROPOSAL_EXISTS:
    "This lead already has a proposal. Open it, or explicitly choose to create an additional proposal.",
  CPL_APPROVAL_REQUIRED: "Approve the saved proposal version before continuing this handoff.",
  CPL_AWARD_REQUIRED: "Record an award before creating the linked project.",
  CPL_INVALID_STATE:
    "This action is not available in the proposal’s current state. Refresh saved state and review the latest version.",
  CPL_COMMERCIAL_VERSION_CONFLICT:
    "The proposal changed in another session. Your entries are kept. Refresh saved state and review the latest version before saving.",
  CPL_BRANDING_REQUIRED:
    "Configure the company’s artifact branding before submitting the proposal for approval.",
  CPL_MODULE_DISABLED: "This workflow is not enabled for the current company.",
  CPL_PROPOSAL_ALREADY_EXISTS:
    "This lead already has a structured proposal. Open it, or explicitly choose to create an additional proposal.",
  CPL_COMMERCIAL_NOT_READY:
    "Complete the saved scope, pricing and company artifact branding before review. Your current entries are kept.",
  CPL_COMMERCIAL_STATE_CONFLICT:
    "The proposal’s state changed. Refresh saved state before attempting another action.",
  CPL_AWARD_TOTAL_MISMATCH:
    "The award amount and currency must match the approved proposal. Open and approve a revision to change the agreed price.",
  CPL_APPROVED_VERSION_REQUIRED: "This action requires the currently approved proposal version.",
  CPL_PROPOSAL_NOT_APPROVED: "Approve the saved proposal before creating its final customer PDF.",
  CPL_PROPOSAL_PDF_UNSUPPORTED_CHARACTER:
    "The PDF renderer cannot represent a character in this version. Review the document text before trying again.",
  CPL_PROPOSAL_PDF_LOGO_INVALID:
    "The saved company logo could not be rendered. Review the approved document’s logo before retrying.",
  CPL_SESSION_REQUIRED: "Your session expired. Sign in again to continue.",
};

class WorkspaceRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly conflicts: ReturnType<typeof executionConflicts> = [],
  ) {
    super(message);
  }
}

async function workspaceRequest<T>(
  path: string,
  body?: unknown,
  mutationHeaders?: Record<string, string>,
  method?: "POST" | "PATCH",
  readHeaders?: Record<string, string>,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : (method ?? "POST"),
    cache: "no-store",
    credentials: "same-origin",
    headers: body === undefined ? readHeaders : mutationHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw new WorkspaceRequestError(
      typeof value.code === "string" ? value.code : "CPL_REQUEST_FAILED",
      messages[value.code] ??
        (response.status === 503
          ? "The workspace is temporarily unavailable. Try again shortly."
          : "The request could not be completed. Refresh and try again."),
      value.code === "CPL_EXECUTION_SCHEDULE_CONFLICT" ? executionConflicts(value.conflicts) : [],
    );
  return value as T;
}

export function Workspace() {
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<WorkspaceData>(emptyData);
  const [view, setView] = useState<"actions" | "leads" | "commercial" | "proposals" | "settings">(
    "actions",
  );
  const [commercialIntent, setCommercialIntent] = useState<ProposalIntent | undefined>();
  const [recordIntent, setRecordIntent] = useState<WorkspaceRecordIntent | undefined>();
  const recordNonce = useRef(0);
  const [commercialDirty, setCommercialDirty] = useState(false);
  const commercialNavigation = useUnsavedNavigation(commercialDirty);
  const [leadId, setLeadId] = useState("");
  const [proposalId, setProposalId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createOrganization, setCreateOrganization] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const refreshGeneration = useRef(0);
  const displayedOrganization = useRef<string | null>(null);
  const createAttempts = useRef<Record<string, { payload: string; key: string }>>({});
  const organization = data.organizations.find((item) => item.id === data.currentOrganizationId);
  const selectedProposal = data.proposals.find((item) => item.id === proposalId);
  const proposalLead = data.leads.find((item) => item.id === leadId);
  const localDevelopment =
    session?.authenticationMode === "local-development" && session.synthetic === true;
  const permissions = data.permissions ?? noPermissions;
  const cancelRefresh = useCallback(() => {
    refreshGeneration.current++;
  }, []);

  const resetRecords = useCallback(() => {
    setLeadId("");
    setProposalId("");
    setEditing(false);
    setEditVersion(null);
    setDraftTitle("");
    setDraftContent("");
    setCommercialIntent(undefined);
    setRecordIntent(undefined);
    setCommercialDirty(false);
    createAttempts.current = {};
  }, []);

  const request = useCallback(
    <T,>(path: string, body?: unknown, method?: "POST" | "PATCH"): Promise<T> =>
      workspaceRequest<T>(
        path,
        body,
        {
          "Content-Type": "application/json",
          "X-CPL-CSRF": session?.csrfToken ?? "",
          "X-CPL-Organization": data.currentOrganizationId ?? "",
        },
        method,
      ),
    [session?.csrfToken, data.currentOrganizationId],
  );
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    // Reads do not depend on mutation headers; loading them must not restart this effect.
    const signedIn = await workspaceRequest<Session>("/api/auth/session");
    const workspace = signedIn.authenticated
      ? await workspaceRequest<WorkspaceData>("/api/cpl/workspace")
      : emptyData;
    if (generation === refreshGeneration.current) {
      if (workspace.currentOrganizationId !== displayedOrganization.current) resetRecords();
      displayedOrganization.current = workspace.currentOrganizationId;
      setSession(signedIn);
      setData(workspace);
    }
  }, [resetRecords]);
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(refresh)
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : "Workspace unavailable.");
      });
    return () => {
      active = false;
      cancelRefresh();
    };
  }, [refresh, cancelRefresh]);
  function createKey(kind: string, input: unknown) {
    const payload = JSON.stringify({ organizationId: data.currentOrganizationId, input });
    const previous = createAttempts.current[kind];
    if (previous?.payload === payload) return previous.key;
    const key = crypto.randomUUID();
    createAttempts.current[kind] = { payload, key };
    return key;
  }
  function clearSession(descriptor?: Session) {
    setSession((previous) => ({
      authenticated: false,
      authenticationMode: descriptor?.authenticationMode ?? previous?.authenticationMode,
      synthetic: descriptor?.synthetic ?? previous?.synthetic,
    }));
    setData(emptyData);
    displayedOrganization.current = null;
    resetRecords();
    setCreateOrganization(false);
    setView("actions");
  }
  async function action(operation: () => Promise<void>) {
    if (busy) return false;
    refreshGeneration.current++;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      return true;
    } catch (e) {
      if (e instanceof WorkspaceRequestError && e.code === "CPL_ORGANIZATION_CONTEXT_CHANGED") {
        resetRecords();
        await refresh().catch(() => undefined);
      }
      if (
        e instanceof WorkspaceRequestError &&
        ["CPL_CSRF_REJECTED", "CPL_AUTHENTICATION_REQUIRED"].includes(e.code)
      ) {
        // A denial may mean expired cookies. Check once without retrying the mutation.
        const current = await workspaceRequest<Session>("/api/auth/session").catch(() => null);
        if (current?.authenticated === false) {
          clearSession(current);
          setError(messages.CPL_AUTHENTICATION_REQUIRED!);
          return false;
        }
      }
      setError(e instanceof Error ? e.message : "The request could not be completed.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function passkey() {
    if (localDevelopment) {
      await developmentSignIn();
      return;
    }
    await action(async () => {
      if (session?.session?.hasPasskey) {
        const ceremony = await request<{
          ceremonyToken: string;
          options: PublicKeyCredentialRequestOptionsJSON;
        }>("/api/auth/passkeys/authenticate/options", {});
        const response = await startAuthentication({ optionsJSON: ceremony.options });
        await request("/api/auth/passkeys/authenticate/verify", {
          ceremonyToken: ceremony.ceremonyToken,
          response,
        });
      } else {
        const ceremony = await request<{
          ceremonyToken: string;
          options: PublicKeyCredentialCreationOptionsJSON;
        }>("/api/auth/passkeys/register/options", {});
        const response = await startRegistration({ optionsJSON: ceremony.options });
        await request("/api/auth/passkeys/register/verify", {
          ceremonyToken: ceremony.ceremonyToken,
          response,
        });
      }
      await refresh();
      setNotice(
        session?.session?.hasPasskey
          ? "Your identity has been verified for organization setup."
          : "Passkey saved. Use Verify passkey to confirm your identity before organization setup.",
      );
    });
  }
  async function developmentSignIn() {
    await action(async () => {
      await workspaceRequest("/api/auth/local/sign-in", {}, { "Content-Type": "application/json" });
      await refresh();
      setNotice("Development sign-in ready. This workspace uses a synthetic local identity.");
    });
  }
  async function saveOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    await action(async () => {
      await request("/api/cpl/organizations", {
        displayName: fields.get("displayName"),
        slug: fields.get("slug"),
      });
      setCreateOrganization(false);
      resetRecords();
      await refresh();
      setNotice("Your empty organization is ready. Intake and manual proposals are enabled.");
    });
  }
  async function saveLead(input: LeadInput, id?: string) {
    let lead: CplWorkflowLead | null = null;
    const succeeded = await action(async () => {
      lead = await request<CplWorkflowLead>(
        id ? `/api/cpl/leads/${id}` : "/api/cpl/leads",
        id
          ? input
          : {
              ...input,
              idempotencyKey: createKey("lead", input),
            },
        id ? "PATCH" : "POST",
      );
      delete createAttempts.current.lead;
      await refresh();
      setLeadId(lead.id);
      setNotice(
        id
          ? "Lead changes saved. Review the updated readiness and source evidence."
          : "Lead saved to your organization.",
      );
    });
    return succeeded ? lead : null;
  }
  async function preserveEvidence(id: string, input: LeadInput) {
    let lead: CplWorkflowLead | null = null;
    const succeeded = await action(async () => {
      lead = await request<CplWorkflowLead>(`/api/cpl/leads/${id}/evidence`, {
        ...input,
        idempotencyKey: createKey(`evidence:${id}`, input),
      });
      delete createAttempts.current[`evidence:${id}`];
      await refresh();
      setNotice("Source evidence preserved with the lead.");
    });
    return succeeded ? lead : null;
  }
  async function saveDirectory(input: LeadInput) {
    return action(async () => {
      await request("/api/cpl/directory", {
        ...input,
        idempotencyKey: createKey("directory", input),
      });
      delete createAttempts.current.directory;
      await refresh();
      setNotice("Company directory record saved. You can now select it in the lead.");
    });
  }
  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await action(async () => {
      const input = { leadId, title: draftTitle, content: draftContent };
      const result = await request<CplProposalDraft>(
        editing && selectedProposal
          ? `/api/cpl/proposals/${selectedProposal.id}`
          : "/api/cpl/proposals",
        editing && selectedProposal
          ? { title: draftTitle, content: draftContent, expectedVersion: editVersion }
          : {
              ...input,
              idempotencyKey: createKey("proposal", input),
            },
      );
      delete createAttempts.current.proposal;
      await refresh();
      setProposalId(result.id);
      setEditing(false);
      setEditVersion(null);
      setDraftTitle("");
      setDraftContent("");
      setNotice(
        "Draft saved. Background preparation has started. Use Refresh status to check progress.",
      );
    });
  }
  async function commercialRequest<T>(path: string, body?: unknown): Promise<T> {
    try {
      return await workspaceRequest<T>(
        path,
        body,
        {
          "Content-Type": "application/json",
          "X-CPL-CSRF": session?.csrfToken ?? "",
          "X-CPL-Organization": data.currentOrganizationId ?? "",
        },
        "POST",
        { "X-CPL-Organization": data.currentOrganizationId ?? "" },
      );
    } catch (caught) {
      if (
        caught instanceof WorkspaceRequestError &&
        caught.code === "CPL_ORGANIZATION_CONTEXT_CHANGED"
      ) {
        resetRecords();
        await refresh().catch(() => undefined);
      }
      if (
        caught instanceof WorkspaceRequestError &&
        ["CPL_CSRF_REJECTED", "CPL_AUTHENTICATION_REQUIRED", "CPL_SESSION_REQUIRED"].includes(
          caught.code,
        )
      ) {
        const current = await workspaceRequest<Session>("/api/auth/session").catch(() => null);
        if (current?.authenticated === false) clearSession(current);
      }
      throw caught;
    }
  }
  function openLead(id: string) {
    void action(async () => {
      const lead = await commercialRequest<CplWorkflowLead>(`/api/cpl/leads/${id}`);
      if (lead.id !== id || lead.organizationId !== data.currentOrganizationId)
        throw new WorkspaceRequestError(
          "CPL_ORGANIZATION_CONTEXT_CHANGED",
          messages.CPL_ORGANIZATION_CONTEXT_CHANGED!,
        );
      setData((previous) => ({
        ...previous,
        leads: [lead, ...previous.leads.filter((item) => item.id !== id)],
      }));
      setCommercialDirty(false);
      setCommercialIntent(undefined);
      setRecordIntent(undefined);
      setLeadId(id);
      setView("leads");
    });
  }
  function openActionTarget(target: CplActionTarget) {
    // ActionCenter invokes this only after its own unsaved-work decision.
    if (target.kind === "lead") {
      openLead(target.id);
      return;
    }
    if (target.kind === "execution") return;
    if (["visit", "report", "package"].includes(target.kind) && !target.projectId) {
      setError("This action is missing its project reference. Refresh the Action Center.");
      return;
    }
    setCommercialDirty(false);
    setCommercialIntent(undefined);
    setRecordIntent({ ...target, kind: target.kind, nonce: ++recordNonce.current });
    setView("commercial");
  }
  async function fieldUpload<T>(input: FieldUploadInput): Promise<T> {
    try {
      return await uploadFieldPhoto<T>(input, {
        organizationId: data.currentOrganizationId ?? "",
        csrfToken: session?.csrfToken ?? "",
      });
    } catch (caught) {
      if (caught instanceof FieldUploadError) {
        if (caught.code === "CPL_ORGANIZATION_CONTEXT_CHANGED") {
          resetRecords();
          await refresh().catch(() => undefined);
        }
        if (
          ["CPL_CSRF_REJECTED", "CPL_AUTHENTICATION_REQUIRED", "CPL_SESSION_REQUIRED"].includes(
            caught.code,
          )
        ) {
          const current = await workspaceRequest<Session>("/api/auth/session").catch(() => null);
          if (current?.authenticated === false) clearSession(current);
        }
      }
      throw caught;
    }
  }
  return (
    <>
      {commercialNavigation.dialog}
      <header className={styles.header}>
        <div className={styles.brand}>
          <AppLogo priority />
          <div>
            <strong>Command Center</strong>
            <span>Cyber Pirate Labs</span>
          </div>
        </div>
        {session?.authenticated ? (
          <button
            disabled={busy}
            onClick={() => {
              commercialNavigation.navigate(
                () =>
                  void action(async () => {
                    await request("/api/auth/logout", {});
                    clearSession();
                  }),
              );
            }}
          >
            Sign out
          </button>
        ) : (
          <span className={styles.badge}>Company workspace</span>
        )}
      </header>
      {session ? (
        <div className={styles.developmentBanner}>
          <strong>{localDevelopment ? "DEVELOPMENT" : "HOSTED DEVELOPMENT PREVIEW"}</strong>
          <span>
            {localDevelopment
              ? "Local workspace · synthetic sign-in · no customer sending"
              : "Product development · customer delivery and production acceptance deferred"}
          </span>
        </div>
      ) : null}
      <main id="workspace" className={styles.main}>
        {error ? (
          <div role="alert" className={`${styles.notice} ${styles.error}`}>
            {error}
          </div>
        ) : null}
        {notice ? (
          <div role="status" className={styles.notice}>
            {notice}
          </div>
        ) : null}
        {!session?.authenticated ? (
          <section className={`${styles.panel} ${styles.narrow}`}>
            <p className={styles.eyebrow}>WELCOME TO CPL</p>
            <h1>
              Your service work,
              <br />
              from lead to proposal.
            </h1>
            <p className={styles.muted}>
              Sign in to your company workspace to manage intake and prepare proposal drafts.
            </p>
            {!session ? (
              <p role="status" className={styles.muted}>
                Checking workspace access…
              </p>
            ) : localDevelopment ? (
              <button
                className={styles.primary}
                disabled={busy}
                onClick={() => void developmentSignIn()}
              >
                Enter development workspace
              </button>
            ) : (
              <form action="/api/auth/google/start" method="post">
                <button className={styles.primary} type="submit">
                  Continue with Google
                </button>
              </form>
            )}
            <p className={styles.meta}>
              Organization access is assigned by an authorized administrator. New workspaces start
              empty.
            </p>
          </section>
        ) : (
          <>
            <div className={styles.intro}>
              <div>
                <p className={styles.eyebrow}>COMPANY WORKSPACE</p>
                <h1>{organization?.displayName ?? "Set up your organization"}</h1>
                <p className={styles.muted}>
                  {session.identity?.displayName} · Intake, proposals &amp; project handoff
                </p>
              </div>
              {data.organizations.length ? (
                <label className={`${styles.field} ${styles.org}`}>
                  Organization
                  <select
                    aria-label="Organization"
                    value={data.currentOrganizationId ?? ""}
                    disabled={busy}
                    onChange={(event) => {
                      const id = event.target.value;
                      commercialNavigation.navigate(
                        () =>
                          void action(async () => {
                            await request("/api/cpl/organizations/select", { organizationId: id });
                            resetRecords();
                            await refresh();
                          }),
                      );
                    }}
                  >
                    {!data.currentOrganizationId ? (
                      <option value="">Choose organization</option>
                    ) : null}
                    {data.organizations.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            {!organization || createOrganization ? (
              <section className={`${styles.panel} ${styles.narrow}`}>
                <h2>Create an empty organization</h2>
                <p className={styles.muted}>
                  Set the name shown throughout your company workspace. Only the authorized CPL
                  owner can provision organizations in this release.
                </p>
                {session.session?.stepUpRequired ? (
                  <div className={styles.notice}>
                    <p>
                      {localDevelopment
                        ? "Refresh your development sign-in to continue."
                        : "Verify your identity with a passkey to continue."}
                    </p>
                    <button
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() => void passkey()}
                    >
                      {localDevelopment
                        ? "Refresh development sign-in"
                        : session.session.hasPasskey
                          ? "Verify passkey"
                          : "Set up passkey"}
                    </button>
                  </div>
                ) : null}
                <form className={styles.form} onSubmit={(event) => void saveOrganization(event)}>
                  <label className={styles.field}>
                    Organization name
                    <input
                      name="displayName"
                      required
                      maxLength={160}
                      placeholder="Cyber Pirate Labs"
                    />
                  </label>
                  <label className={styles.field}>
                    Organization address
                    <input
                      name="slug"
                      required
                      minLength={3}
                      maxLength={63}
                      pattern="[a-z0-9][a-z0-9-]+[a-z0-9]"
                      placeholder="cyber-pirate-labs"
                    />
                    <small>Lowercase letters, numbers, and hyphens.</small>
                  </label>
                  <div className={styles.actions}>
                    <button
                      className={styles.primary}
                      disabled={busy || session.session?.stepUpRequired}
                      type="submit"
                    >
                      Create organization
                    </button>
                    {organization ? (
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => setCreateOrganization(false)}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </div>
                </form>
              </section>
            ) : (
              <>
                <nav className={styles.tabs} aria-label="Workspace sections">
                  {(["actions", "leads", "commercial", "proposals", "settings"] as const).map(
                    (item) => (
                      <button
                        key={item}
                        aria-current={view === item ? "page" : undefined}
                        disabled={busy}
                        onClick={() => {
                          if (view !== item)
                            commercialNavigation.navigate(() => {
                              setCommercialDirty(false);
                              setCommercialIntent(undefined);
                              setRecordIntent(undefined);
                              setView(item);
                            });
                        }}
                      >
                        {item === "actions"
                          ? "Action Center"
                          : item === "leads"
                            ? "Leads"
                            : item === "commercial"
                              ? "Proposals"
                              : item === "proposals"
                                ? "Legacy drafts"
                                : "Organization"}
                      </button>
                    ),
                  )}
                </nav>
                {view === "actions" ? (
                  <ActionCenter
                    key={data.currentOrganizationId}
                    organizationId={data.currentOrganizationId!}
                    request={commercialRequest}
                    onDirty={setCommercialDirty}
                    onBusy={setBusy}
                    onOpen={openActionTarget}
                  />
                ) : null}
                {view === "leads" ? (
                  <LeadWorkspace
                    key={data.currentOrganizationId}
                    leads={data.leads}
                    proposals={data.proposals}
                    directory={data.intakeDirectory ?? emptyDirectory}
                    permissions={permissions}
                    selectedId={leadId}
                    busy={busy}
                    onSelect={setLeadId}
                    onRefresh={() => void action(refresh)}
                    onSave={saveLead}
                    onEvidence={preserveEvidence}
                    onDirectory={saveDirectory}
                    onProposal={(lead, selectedId) => {
                      setLeadId(lead.id);
                      setView(selectedId ? "proposals" : "commercial");
                      setCommercialIntent(selectedId ? undefined : { leadId: lead.id });
                      setRecordIntent(undefined);
                      setProposalId(selectedId ?? "");
                      setEditing(false);
                      setEditVersion(null);
                      setDraftTitle(selectedId ? "" : `Proposal — ${lead.title}`);
                      setDraftContent("");
                    }}
                  />
                ) : null}
                {view === "commercial" ? (
                  <CommercialWorkspace
                    key={`${data.currentOrganizationId}:${recordIntent?.nonce ?? "browse"}`}
                    organizationId={data.currentOrganizationId!}
                    leads={data.leads}
                    legacyDrafts={data.proposals}
                    intent={commercialIntent}
                    recordIntent={recordIntent}
                    request={commercialRequest}
                    upload={fieldUpload}
                    onDirty={setCommercialDirty}
                    onBusy={setBusy}
                    onLegacy={() => {
                      setCommercialDirty(false);
                      setView("proposals");
                    }}
                    onOpenLead={openLead}
                  />
                ) : null}
                {view === "proposals" ? (
                  <div className={styles.grid}>
                    <section className={styles.panel}>
                      <h2>{editing ? "Edit proposal draft" : "New proposal draft"}</h2>
                      <p className={styles.muted}>
                        Preserved manual drafts use the original text and Markdown preparation flow.
                        Use Proposals for structured pricing, review, approved PDFs and project
                        handoff.
                      </p>
                      <form className={styles.form} onSubmit={(event) => void saveDraft(event)}>
                        {!editing &&
                        proposalLead &&
                        (proposalLead.status !== "ready_for_proposal" ||
                          !proposalLead.readiness.readyForProposal) ? (
                          <div className={styles.warning}>
                            This lead is not ready for a new proposal.{" "}
                            <button
                              type="button"
                              className={styles.textButton}
                              onClick={() => setView("leads")}
                            >
                              Review lead information
                            </button>
                          </div>
                        ) : null}
                        <fieldset
                          className={styles.fieldset}
                          disabled={
                            busy ||
                            (editing
                              ? !permissions.canEditProposal
                              : !permissions.canCreateProposal)
                          }
                        >
                          <label className={styles.field}>
                            Associated lead
                            <select
                              value={editing && selectedProposal ? selectedProposal.leadId : leadId}
                              required
                              disabled={editing}
                              onChange={(e) => setLeadId(e.target.value)}
                            >
                              <option value="">Choose a lead</option>
                              {data.leads.map((lead) => (
                                <option value={lead.id} key={lead.id}>
                                  {lead.title}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className={styles.field}>
                            Proposal title
                            <input
                              value={draftTitle}
                              onChange={(e) => setDraftTitle(e.target.value)}
                              required
                              maxLength={180}
                            />
                          </label>
                          <label className={styles.field}>
                            Manual proposal content
                            <textarea
                              value={draftContent}
                              onChange={(e) => setDraftContent(e.target.value)}
                              required
                              maxLength={50000}
                              rows={12}
                              placeholder="Scope of work, deliverables, pricing, assumptions, and next steps…"
                            />
                          </label>
                        </fieldset>
                        <button
                          className={styles.primary}
                          disabled={
                            busy ||
                            !data.leads.length ||
                            (editing
                              ? !permissions.canEditProposal
                              : !permissions.canCreateProposal ||
                                proposalLead?.status !== "ready_for_proposal" ||
                                !proposalLead?.readiness.readyForProposal)
                          }
                          type="submit"
                        >
                          Save draft
                        </button>
                      </form>
                    </section>
                    <section className={styles.panel}>
                      <div className={styles.actions}>
                        <h2>Saved drafts</h2>
                        <button
                          className={styles.secondary}
                          disabled={busy}
                          onClick={() => void action(refresh)}
                        >
                          Refresh status
                        </button>
                      </div>
                      {data.proposals.length ? (
                        <ul className={styles.list}>
                          {data.proposals.map((proposal) => (
                            <li key={proposal.id}>
                              <button
                                className={styles.record}
                                aria-pressed={proposalId === proposal.id}
                                onClick={() => {
                                  setProposalId(proposal.id);
                                  setEditing(false);
                                  setEditVersion(null);
                                  setDraftTitle("");
                                  setDraftContent("");
                                }}
                              >
                                <strong>{proposal.title}</strong>
                                <small>
                                  Draft · Version {proposal.version} ·{" "}
                                  {proposal.preparedVersion === proposal.version
                                    ? "Download ready"
                                    : "Preparing download"}
                                </small>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className={styles.empty}>
                          No proposal drafts yet. Select a lead and write your first draft.
                        </p>
                      )}
                      {selectedProposal ? (
                        <article className={styles.detail}>
                          <span className={styles.badge}>
                            DRAFT · VERSION {selectedProposal.version}
                          </span>
                          <h3>{selectedProposal.title}</h3>
                          <p className={styles.meta}>
                            For{" "}
                            {data.leads.find((lead) => lead.id === selectedProposal.leadId)
                              ?.title ?? "associated lead"}
                          </p>
                          <div className={styles.document}>{selectedProposal.content}</div>
                          <div className={styles.actions}>
                            <button
                              className={styles.primary}
                              disabled={busy || !permissions.canCreateProposal}
                              onClick={() => {
                                setCommercialIntent({
                                  leadId: selectedProposal.leadId,
                                  legacyDraftId: selectedProposal.id,
                                });
                                setView("commercial");
                              }}
                            >
                              Upgrade to structured proposal
                            </button>
                            <button
                              className={styles.secondary}
                              disabled={busy || !permissions.canEditProposal}
                              onClick={() => {
                                setEditing(true);
                                setEditVersion(selectedProposal.version);
                                setDraftTitle(selectedProposal.title);
                                setDraftContent(selectedProposal.content);
                              }}
                            >
                              Edit draft
                            </button>
                            {selectedProposal.preparedVersion === selectedProposal.version ? (
                              <a
                                className={`${styles.button} ${styles.primary}`}
                                href={`/api/cpl/proposals/${selectedProposal.id}/download?organization=${encodeURIComponent(data.currentOrganizationId ?? "")}`}
                              >
                                Download draft
                              </a>
                            ) : null}
                          </div>
                          <p className={styles.meta}>
                            Downloads are generated from this saved version. No separate file
                            archive is created.
                          </p>
                          {data.jobs
                            .filter((job) => job.proposalId === selectedProposal.id)
                            .map((job) => (
                              <p className={styles.meta} key={job.id}>
                                Preparation v{job.proposalVersion}: {job.status} · Attempt{" "}
                                {job.attempts}/{job.maxAttempts}
                                {job.lastErrorCode ? ` · ${job.lastErrorCode}` : ""}
                              </p>
                            ))}
                        </article>
                      ) : null}
                    </section>
                  </div>
                ) : null}
                {view === "settings" ? (
                  <section className={`${styles.panel} ${styles.narrow}`}>
                    <h2>Organization &amp; access</h2>
                    <p>
                      <strong>{organization.displayName}</strong>
                      <br />
                      <span className={styles.muted}>{organization.slug}</span>
                    </p>
                    <p className={styles.muted}>
                      Intake and proposal access follow your company’s enabled modules and role.
                      Structured proposal review and project handoff are available where enabled. AI
                      generation, customer sending, scheduling and field work are not performed
                      here.
                    </p>
                    <div className={styles.actions}>
                      <button
                        className={styles.secondary}
                        disabled={busy}
                        onClick={() => void passkey()}
                      >
                        {localDevelopment
                          ? "Refresh development sign-in"
                          : session.session?.hasPasskey
                            ? "Verify passkey"
                            : "Set up passkey"}
                      </button>
                      <button
                        className={styles.secondary}
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await request("/api/auth/renew", {});
                            await refresh();
                            setNotice("Your session has been renewed.");
                          })
                        }
                      >
                        Renew session
                      </button>
                      <button
                        className={styles.secondary}
                        onClick={() => setCreateOrganization(true)}
                      >
                        Create another organization
                      </button>
                    </div>
                    <p className={styles.meta}>
                      Session expires{" "}
                      {session.session
                        ? new Date(session.session.expiresAt).toLocaleString()
                        : "soon"}
                      . Organization changes are checked against your current membership on the
                      server.
                    </p>
                  </section>
                ) : null}
              </>
            )}
            <p className={styles.footer}>
              CPL Command Center · Manual content · No AI calls or customer messages
            </p>
          </>
        )}
      </main>
    </>
  );
}
