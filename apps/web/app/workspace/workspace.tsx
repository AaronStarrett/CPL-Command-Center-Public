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

type Organization = { id: string; displayName: string; slug: string };
type Session = {
  authenticated: boolean;
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
};
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
  CPL_PLATFORM_MFA_REQUIRED: "Verify your passkey before changing organization settings.",
  CPL_PROPOSAL_VERSION_CONFLICT:
    "This draft changed in another session. Refresh before editing again.",
  CPL_RECENT_MFA_REQUIRED: "Verify your passkey before changing organization settings.",
  CPL_PROPOSAL_NOT_READY:
    "This version is still being prepared. The background runner checks every 15 minutes.",
  CPL_VERSION_CONFLICT: "This draft changed in another session. Refresh before editing again.",
  CPL_INVALID_INPUT: "Check the required fields and try again.",
  CPL_FRESH_AUTHENTICATION_REQUIRED: "Sign out and sign in again to enroll your first passkey.",
  CPL_ORGANIZATION_CONTEXT_CHANGED:
    "The selected organization changed in another tab. Review the current organization before entering records again.",
  CPL_ORGANIZATION_SLUG_TAKEN: "That organization address is already in use. Choose another.",
};

class WorkspaceRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function Workspace() {
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<WorkspaceData>(emptyData);
  const [view, setView] = useState<"leads" | "proposals" | "settings">("leads");
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
  const selectedLead = data.leads.find((item) => item.id === leadId);
  const selectedProposal = data.proposals.find((item) => item.id === proposalId);
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
    createAttempts.current = {};
  }, []);

  const request = useCallback(
    async <T,>(path: string, body?: unknown): Promise<T> => {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers:
          body === undefined
            ? undefined
            : {
                "Content-Type": "application/json",
                "X-CPL-CSRF": session?.csrfToken ?? "",
                "X-CPL-Organization": data.currentOrganizationId ?? "",
              },
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
        );
      return value as T;
    },
    [session?.csrfToken, data.currentOrganizationId],
  );
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const signedIn = await request<Session>("/api/auth/session");
    const workspace = signedIn.authenticated
      ? await request<WorkspaceData>("/api/cpl/workspace")
      : emptyData;
    if (generation === refreshGeneration.current) {
      if (workspace.currentOrganizationId !== displayedOrganization.current) resetRecords();
      displayedOrganization.current = workspace.currentOrganizationId;
      setSession(signedIn);
      setData(workspace);
    }
  }, [request, resetRecords]);
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
  async function action(operation: () => Promise<void>) {
    if (busy) return;
    refreshGeneration.current++;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (e) {
      if (e instanceof WorkspaceRequestError && e.code === "CPL_ORGANIZATION_CONTEXT_CHANGED") {
        resetRecords();
        await refresh().catch(() => undefined);
      }
      setError(e instanceof Error ? e.message : "The request could not be completed.");
    } finally {
      setBusy(false);
    }
  }
  async function passkey() {
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
  async function createLead(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    await action(async () => {
      const input = {
        title: fields.get("title"),
        contactName: fields.get("contactName"),
        contactEmail: fields.get("contactEmail") || null,
        details: fields.get("details"),
      };
      const lead = await request<CplWorkflowLead>("/api/cpl/leads", {
        ...input,
        idempotencyKey: createKey("lead", input),
      });
      delete createAttempts.current.lead;
      form.reset();
      await refresh();
      setLeadId(lead.id);
      setNotice("Lead saved to your organization.");
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
        "Draft saved. Downloads are prepared every 15 minutes. Use Refresh status to check progress.",
      );
    });
  }
  return (
    <>
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
            onClick={() =>
              void action(async () => {
                await request("/api/auth/logout", {});
                setSession({ authenticated: false });
                setData(emptyData);
                resetRecords();
                setCreateOrganization(false);
                setView("leads");
              })
            }
          >
            Sign out
          </button>
        ) : (
          <span className={styles.badge}>Company workspace</span>
        )}
      </header>
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
            <form action="/api/auth/google/start" method="post">
              <button className={styles.primary} type="submit">
                Continue with Google
              </button>
            </form>
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
                  {session.identity?.displayName} · Intake &amp; manual proposals
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
                      void action(async () => {
                        await request("/api/cpl/organizations/select", { organizationId: id });
                        resetRecords();
                        await refresh();
                      });
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
                    <p>Verify your identity with a passkey to continue.</p>
                    <button
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() => void passkey()}
                    >
                      {session.session.hasPasskey ? "Verify passkey" : "Set up passkey"}
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
                  {(["leads", "proposals", "settings"] as const).map((item) => (
                    <button
                      key={item}
                      aria-current={view === item ? "page" : undefined}
                      onClick={() => setView(item)}
                    >
                      {item === "leads"
                        ? "Leads"
                        : item === "proposals"
                          ? "Proposal drafts"
                          : "Organization"}
                    </button>
                  ))}
                </nav>
                {view === "leads" ? (
                  <div className={styles.grid} key={data.currentOrganizationId}>
                    <section className={styles.panel}>
                      <h2>New lead</h2>
                      <p className={styles.muted}>
                        Capture an inquiry before preparing a proposal.
                      </p>
                      <form className={styles.form} onSubmit={(event) => void createLead(event)}>
                        <label className={styles.field}>
                          Lead title
                          <input
                            name="title"
                            required
                            maxLength={180}
                            placeholder="Fictional test — site inspection"
                          />
                        </label>
                        <label className={styles.field}>
                          Contact name
                          <input name="contactName" required maxLength={160} />
                        </label>
                        <label className={styles.field}>
                          Contact email (optional)
                          <input name="contactEmail" type="email" maxLength={254} />
                        </label>
                        <label className={styles.field}>
                          Request details
                          <textarea name="details" maxLength={10000} />
                        </label>
                        <button className={styles.primary} disabled={busy} type="submit">
                          Save lead
                        </button>
                      </form>
                    </section>
                    <section className={styles.panel}>
                      <div className={styles.actions}>
                        <h2>
                          Leads <span className={styles.badge}>{data.leads.length}</span>
                        </h2>
                        <button
                          className={styles.secondary}
                          disabled={busy}
                          onClick={() => void action(refresh)}
                        >
                          Refresh
                        </button>
                      </div>
                      {data.leads.length ? (
                        <ul className={styles.list}>
                          {data.leads.map((lead) => (
                            <li key={lead.id}>
                              <button
                                className={styles.record}
                                aria-pressed={leadId === lead.id}
                                onClick={() => setLeadId(lead.id)}
                              >
                                <strong>{lead.title}</strong>
                                <small>
                                  {lead.contactName} ·{" "}
                                  {new Date(lead.createdAt).toLocaleDateString()}
                                </small>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className={styles.empty}>
                          No leads yet. Your first inquiry will appear here.
                        </p>
                      )}
                      {selectedLead ? (
                        <article className={styles.detail}>
                          <h3>{selectedLead.title}</h3>
                          <p>
                            {selectedLead.contactName}
                            {selectedLead.contactEmail ? ` · ${selectedLead.contactEmail}` : ""}
                          </p>
                          <p className={styles.document}>{selectedLead.details}</p>
                          <button
                            className={styles.primary}
                            onClick={() => {
                              setView("proposals");
                              setProposalId("");
                              setEditing(false);
                              setEditVersion(null);
                              setDraftTitle(`Proposal — ${selectedLead.title}`);
                              setDraftContent("");
                            }}
                          >
                            Draft proposal
                          </button>
                        </article>
                      ) : null}
                    </section>
                  </div>
                ) : null}
                {view === "proposals" ? (
                  <div className={styles.grid}>
                    <section className={styles.panel}>
                      <h2>{editing ? "Edit proposal draft" : "New proposal draft"}</h2>
                      <p className={styles.muted}>
                        Write your proposal content below. Drafts stay inside your workspace; saving
                        does not send anything to the contact.
                      </p>
                      <form className={styles.form} onSubmit={(event) => void saveDraft(event)}>
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
                        <button
                          className={styles.primary}
                          disabled={busy || !data.leads.length}
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
                              className={styles.secondary}
                              disabled={busy}
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
                      Enabled: intake and manual proposal drafts. AI generation, connectors,
                      customer sending, and other workflow modules are unavailable in this release.
                    </p>
                    <div className={styles.actions}>
                      <button
                        className={styles.secondary}
                        disabled={busy}
                        onClick={() => void passkey()}
                      >
                        {session.session?.hasPasskey ? "Verify passkey" : "Set up passkey"}
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
