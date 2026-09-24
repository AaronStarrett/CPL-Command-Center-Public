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
import { AssignedWorkspace } from "./assigned-workspace";
import { CompanyWorkspace } from "./company-workspace";
import { downloadInboundEvidence } from "./integration-evidence-download";
import type { IntegrationNavigationTarget } from "./company-integrations";
import { ActionCenter } from "./action-center";
import type { CplActionTarget } from "@bea/domain/cpl-automation";
import type { WorkspaceRecordIntent } from "./phase4-ui";
import type { CplAdminBootstrap } from "@bea/domain/cpl-admin";
import {
  AcceptInvitation,
  ProvisionCompany,
  readInvitationHandoff,
  type InvitationHandoff,
} from "./administration-workspace";
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
  localPersonaKey?: string;
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
  CPL_LOCAL_SCHEMA_EXPECTATION_MISSING:
    "Local startup metadata is unavailable. Use the normal launcher to restart, then retry sign-in.",
  CPL_LOCAL_DATABASE_UNAVAILABLE:
    "The local database is unavailable. Check the normal launcher's status before retrying.",
  CPL_LOCAL_SCHEMA_NOT_READY:
    "The local database schema is not ready for this application version. Check the normal launcher's result before retrying.",
  CPL_LOCAL_SESSION_PREREQUISITES_UNAVAILABLE:
    "Local session prerequisites are unavailable. Keep the reference and ask the workspace owner to review the launcher result.",
  CPL_LOCAL_PERSONA_UNAVAILABLE:
    "This development identity is unavailable. Choose an available identity or ask the workspace owner to review its status.",
  CPL_INBOUND_INVALID_INPUT:
    "Check the intake fields, question types, limits and required values. Your entries are retained.",
  CPL_INTEGRATION_MAPPING_INVALID:
    "The saved mapping must match the source type and the form question destinations. Review or create a matching mapping, then save again.",
  CPL_INTEGRATION_STALE:
    "This integration changed elsewhere. Your entries are retained. Review its latest saved revision before retrying.",
  CPL_INTEGRATION_CONFIGURATION_CHANGED:
    "Integration configuration changed while this action was pending. Review its current saved configuration before retrying.",
  CPL_INTEGRATION_DISABLED:
    "This source is disabled or paused. An authorized member must review its saved state before intake can continue.",
  CPL_INTEGRATION_PROVIDER_DISABLED:
    "The provider is not enabled in this environment. Local fixture mode and live provider acceptance require separate configuration.",
  CPL_INTEGRATION_AUTHORIZATION_REVOKED:
    "The saved authorization is no longer valid. Review current company access and deliberately authorize again when permitted.",
  CPL_INTEGRATION_RECONNECT_REQUIRED:
    "Reconnect this saved account deliberately before trying intake again.",
  CPL_INTEGRATION_RESYNC_REQUIRED:
    "Coverage is incomplete. Review the start policy and save an explicit bounded recovery selection.",
  CPL_INTEGRATION_RATE_LIMITED:
    "Too many integration requests were made. Wait before retrying; your entries are retained.",
  CPL_INTEGRATION_SOURCE_UNAVAILABLE:
    "This source or selected label is not currently available. Reload its saved state and authorized choices.",
  CPL_INTEGRATION_SOURCE_CONFLICT:
    "This source event conflicts with an earlier saved event. Review the original receipt instead of creating another attempt.",
  CPL_INTEGRATION_PROCESSING_FAILED:
    "Processing could not finish. Review the source receipt and its available recovery controls.",
  CPL_INTEGRATION_NOT_FOUND: "This integration record is not available in the selected company.",
  CPL_FORM_CONFIGURATION_CHANGED:
    "The saved form changed. Review its current configuration before publishing or retrying.",
  CPL_FORM_REQUIRED_FIELD: "Complete the required form values before saving or submitting.",
  CPL_FORM_SERVICE_UNAVAILABLE:
    "A selected service is no longer available. Review this company's active published service choices.",
  CPL_MAPPING_VALUE_INVALID:
    "A source value does not match its supported destination type. Review the explicit mapping and sample values.",
  CPL_COMPANY_INVALID_INPUT:
    "Review the company fields, amounts, currency and time zone before saving.",
  CPL_COMPANY_VERSION_CONFLICT:
    "This company record changed elsewhere. Your entries are retained. Review the latest saved revision before retrying.",
  CPL_COMPANY_FIELD_IDENTITY_CONFLICT:
    "Keep existing custom field IDs and types. Deactivate a field instead of removing or changing its type.",
  CPL_COMPANY_WORKFLOW_KEY_IMMUTABLE:
    "An existing service keeps its workflow key. Create a separate catalog item for a different workflow.",
  CPL_CATALOG_DUPLICATE_CODE_OR_KEY:
    "That catalog code or workflow key is already used. Choose a distinct value or edit the existing item.",
  CPL_DIRECTORY_ARCHIVED:
    "This directory record is archived. Reactivate it deliberately before editing or choosing it for new work.",
  CPL_INVITATION_ALREADY_EXISTS:
    "A pending invitation already exists for this identity. Review it, or deliberately reissue it with a reason.",
  CPL_ADMIN_INVALID_INPUT: "Check the company, verified identity, role, reason and expiry fields.",
  CPL_ADMIN_INVALID_CURSOR: "The list filter changed. Return to its first page.",
  CPL_ADMIN_STALE_VERSION:
    "This membership or invitation changed elsewhere. Your entries are retained. Refresh and review before retrying.",
  CPL_ADMIN_IDEMPOTENCY_CONFLICT:
    "This attempt belongs to different saved input. Review the latest state before starting another change.",
  CPL_LAST_ACTIVE_OWNER:
    "This would leave the company without an active owner. Grant ownership to another active member first.",
  CPL_MEMBER_NOT_FOUND: "That membership is no longer available in this company.",
  CPL_MEMBER_ALREADY_EXISTS:
    "This identity already has a membership. Review and change that membership explicitly.",
  CPL_INVITATION_UNAVAILABLE:
    "This invitation cannot be used by the current identity, or it expired, was revoked, or was already redeemed. Ask an authorized administrator to review it.",
  CPL_ADMIN_RECIPIENT_UNAVAILABLE:
    "Choose an available verified identity. A typed email address alone is not identity verification.",
  CPL_INITIAL_OWNER_MUST_BE_DISTINCT:
    "Select an initial company owner distinct from the platform operator.",
  CPL_ORGANIZATION_SLUG_UNAVAILABLE: "That company workspace key is unavailable. Choose another.",
  CPL_ORGANIZATION_ACCESS_DENIED:
    "You no longer have active access to this company. Your entries are retained; review your current access.",
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
    readonly correlationId: string | null = null,
  ) {
    super(correlationId ? `${message} Reference: ${correlationId}.` : message);
  }
}

async function workspaceRequest<T>(
  path: string,
  body?: unknown,
  mutationHeaders?: Record<string, string>,
  method?: "POST" | "PATCH",
  readHeaders?: Record<string, string>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : (method ?? "POST"),
      cache: "no-store",
      credentials: "same-origin",
      headers: body === undefined ? readHeaders : mutationHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new WorkspaceRequestError(
      "CPL_REQUEST_FAILED",
      "The workspace could not be reached. Your entries are retained; check that the local launcher is running and try again.",
    );
  }
  const value: unknown = await response.json().catch(() => null);
  const failure =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const code =
    typeof failure.code === "string" && /^CPL_[A-Z0-9_]{1,100}$/u.test(failure.code)
      ? failure.code
      : "CPL_REQUEST_FAILED";
  const suppliedCorrelation = failure.correlationId ?? response.headers.get("X-CPL-Correlation-ID");
  const correlationId =
    typeof suppliedCorrelation === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      suppliedCorrelation,
    )
      ? suppliedCorrelation
      : null;
  if (!response.ok || value === null)
    throw new WorkspaceRequestError(
      code,
      messages[code] ??
        (response.status === 503
          ? "The workspace is temporarily unavailable. Try again shortly."
          : "The request could not be completed. Refresh and try again."),
      code === "CPL_EXECUTION_SCHEDULE_CONFLICT" ? executionConflicts(failure.conflicts) : [],
      correlationId,
    );
  return value as T;
}

function administrationAuthority(value: CplAdminBootstrap | null) {
  return value
    ? `${value.membership?.role ?? ""}:${value.membership?.version ?? 0}:${[...value.enabledModules].sort().join(",")}`
    : "";
}

export function Workspace() {
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<WorkspaceData>(emptyData);
  const [administration, setAdministration] = useState<CplAdminBootstrap | null>(null);
  const [personas, setPersonas] = useState<{ key: string; label: string }[]>([]);
  const [personaKey, setPersonaKey] = useState("legacy-owner");
  const [handoff, setHandoff] = useState<InvitationHandoff | null>(null);
  const [acceptingInvitation, setAcceptingInvitation] = useState(false);
  const [administrationDirty, setAdministrationDirty] = useState(false);
  const [leadDirty, setLeadDirty] = useState(false);
  const [contextBlocked, setContextBlocked] = useState(false);
  const dirtyRef = useRef(false);
  const [view, setView] = useState<
    "actions" | "leads" | "commercial" | "proposals" | "settings" | "assigned"
  >("actions");
  const [actionArea, setActionArea] = useState<"actions" | "recipes">("actions");
  const [commercialIntent, setCommercialIntent] = useState<ProposalIntent | undefined>();
  const [recordIntent, setRecordIntent] = useState<WorkspaceRecordIntent | undefined>();
  const [integrationIntent, setIntegrationIntent] = useState<
    IntegrationNavigationTarget | undefined
  >();
  const recordNonce = useRef(0);
  const [commercialDirty, setCommercialDirty] = useState(false);
  const [leadId, setLeadId] = useState("");
  const [proposalId, setProposalId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createOrganization, setCreateOrganization] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const commercialNavigation = useUnsavedNavigation(
    commercialDirty || administrationDirty || leadDirty || !!draftTitle || !!draftContent,
  );
  const [editing, setEditing] = useState(false);
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const refreshGeneration = useRef(0);
  const displayedOrganization = useRef<string | null>(null);
  const displayedIdentity = useRef<string | null>(null);
  const displayedAuthority = useRef("");
  const createAttempts = useRef<Record<string, { payload: string; key: string }>>({});
  const organization = data.organizations.find((item) => item.id === data.currentOrganizationId);
  const selectedProposal = data.proposals.find((item) => item.id === proposalId);
  const proposalLead = data.leads.find((item) => item.id === leadId);
  const localDevelopment =
    session?.authenticationMode === "local-development" && session.synthetic === true;
  const permissions = data.permissions ?? noPermissions;
  const authorityKey = `${session?.identity?.id}:${data.currentOrganizationId}:${administrationAuthority(administration)}`;
  useEffect(() => {
    dirtyRef.current =
      commercialDirty || administrationDirty || leadDirty || !!draftTitle || !!draftContent;
  }, [commercialDirty, administrationDirty, leadDirty, draftTitle, draftContent]);
  useEffect(() => {
    if (!window.location.hash) return;
    const invitation = readInvitationHandoff(window.location.href, window.location.origin);
    if (window.location.hash.includes("cplInvite")) {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      );
      if (invitation) {
        void Promise.resolve().then(() => {
          setHandoff(invitation);
          setAcceptingInvitation(true);
        });
      }
    }
  }, []);
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
    setIntegrationIntent(undefined);
    setActionArea("actions");
    setCommercialDirty(false);
    setAdministrationDirty(false);
    setLeadDirty(false);
    dirtyRef.current = false;
    createAttempts.current = {};
  }, []);

  const request = useCallback(
    <T,>(path: string, body?: unknown, method?: "POST" | "PATCH"): Promise<T> => {
      if (contextBlocked && body !== undefined && !path.startsWith("/api/auth/"))
        return Promise.reject(
          new WorkspaceRequestError(
            "CPL_ORGANIZATION_CONTEXT_CHANGED",
            messages.CPL_ORGANIZATION_CONTEXT_CHANGED!,
          ),
        );
      return workspaceRequest<T>(
        path,
        body,
        {
          "Content-Type": "application/json",
          "X-CPL-CSRF": session?.csrfToken ?? "",
          "X-CPL-Organization": data.currentOrganizationId ?? "",
        },
        method,
      );
    },
    [session?.csrfToken, data.currentOrganizationId, contextBlocked],
  );
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    // Reads do not depend on mutation headers; loading them must not restart this effect.
    const signedIn = await workspaceRequest<Session>("/api/auth/session");
    const bootstrap = signedIn.authenticated
      ? await workspaceRequest<CplAdminBootstrap>("/api/cpl-admin/bootstrap")
      : null;
    const selected =
      bootstrap?.organizations.find((item) => item.id === bootstrap.selectedOrganizationId)?.id ??
      null;
    const canReadBusiness =
      selected &&
      bootstrap?.membership &&
      bootstrap.membership.role !== "field-user" &&
      bootstrap.enabledModules.includes("intake-job-tracker") &&
      bootstrap.enabledModules.includes("proposal-builder");
    const workspace = canReadBusiness
      ? await workspaceRequest<WorkspaceData>("/api/cpl/workspace")
      : {
          ...emptyData,
          organizations: bootstrap?.organizations ?? [],
          currentOrganizationId: selected,
        };
    const local =
      signedIn.authenticationMode === "local-development" && signedIn.synthetic === true;
    const choices = local
      ? await workspaceRequest<{ personas: { key: string; label: string }[] }>(
          "/api/auth/local/config",
        )
      : null;
    if (generation === refreshGeneration.current) {
      const changed =
        workspace.currentOrganizationId !== displayedOrganization.current ||
        (signedIn.identity?.id ?? null) !== displayedIdentity.current ||
        administrationAuthority(bootstrap) !== displayedAuthority.current;
      if (changed && displayedIdentity.current && dirtyRef.current) {
        setContextBlocked(true);
        setError(
          "Your sign-in, company or permissions changed. Your entries are retained and cannot be submitted. Review current access before continuing.",
        );
        return;
      }
      if (changed) resetRecords();
      displayedOrganization.current = workspace.currentOrganizationId;
      displayedIdentity.current = signedIn.identity?.id ?? null;
      displayedAuthority.current = administrationAuthority(bootstrap);
      setSession(signedIn);
      setData(workspace);
      setAdministration(bootstrap);
      setView((previous) =>
        bootstrap?.membership?.role === "field-user"
          ? previous === "settings"
            ? "settings"
            : "assigned"
          : previous === "assigned"
            ? "actions"
            : previous,
      );
      setPersonas(choices?.personas ?? []);
      if (signedIn.localPersonaKey) setPersonaKey(signedIn.localPersonaKey);
      setContextBlocked(false);
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
    setAdministration(null);
    displayedOrganization.current = null;
    displayedIdentity.current = null;
    displayedAuthority.current = "";
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
        setContextBlocked(true);
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
  async function developmentSignIn(key = personaKey) {
    await action(async () => {
      await workspaceRequest(
        "/api/auth/local/sign-in",
        key === "legacy-owner" ? {} : { personaKey: key },
        { "Content-Type": "application/json" },
      );
      resetRecords();
      setContextBlocked(false);
      setCreateOrganization(false);
      await refresh();
      setNotice("Development sign-in ready. This workspace uses a synthetic local identity.");
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
      if (contextBlocked)
        throw new WorkspaceRequestError(
          "CPL_ORGANIZATION_CONTEXT_CHANGED",
          messages.CPL_ORGANIZATION_CONTEXT_CHANGED!,
        );
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
        setContextBlocked(true);
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
    if (target.kind === "integration" || target.kind === "source_receipt") {
      setCommercialDirty(false);
      setAdministrationDirty(false);
      setIntegrationIntent({ kind: target.kind, id: target.id, nonce: ++recordNonce.current });
      setView("settings");
      return;
    }
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
      if (contextBlocked)
        throw new WorkspaceRequestError(
          "CPL_ORGANIZATION_CONTEXT_CHANGED",
          messages.CPL_ORGANIZATION_CONTEXT_CHANGED!,
        );
      return await uploadFieldPhoto<T>(input, {
        organizationId: data.currentOrganizationId ?? "",
        csrfToken: session?.csrfToken ?? "",
      });
    } catch (caught) {
      if (caught instanceof FieldUploadError) {
        if (caught.code === "CPL_ORGANIZATION_CONTEXT_CHANGED") {
          setContextBlocked(true);
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
        {localDevelopment ? (
          <section className={styles.notice}>
            <label className={styles.field}>
              Development identity
              <select
                aria-label="Development identity"
                value={personaKey}
                disabled={busy}
                onChange={(event) => setPersonaKey(event.target.value)}
              >
                {personas.map((persona) => (
                  <option key={persona.key} value={persona.key}>
                    {persona.label}
                  </option>
                ))}
              </select>
            </label>
            {session?.authenticated ? (
              <button
                disabled={busy}
                onClick={() =>
                  commercialNavigation.navigate(() => void developmentSignIn(personaKey))
                }
              >
                Switch development identity
              </button>
            ) : null}
            <p>
              Fixed synthetic identities only. This does not simulate MFA or grant company access.
            </p>
          </section>
        ) : null}
        {contextBlocked ? (
          <section role="alert" className={styles.notice}>
            <strong>Context changed · entries retained</strong>
            <p>
              Saving is paused. Review your current identity and company before continuing.
              Discarding changes clears these entries.
            </p>
            <button
              disabled={busy}
              onClick={() =>
                commercialNavigation.navigate(() => {
                  resetRecords();
                  void action(refresh);
                })
              }
            >
              Review current access
            </button>
          </section>
        ) : null}
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
                  {session.identity?.displayName} ·{" "}
                  {administration?.membership?.role ??
                    (administration?.platform.canProvision
                      ? "Platform operator"
                      : data.organizations.length
                        ? "Select a company"
                        : "No company membership")}
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
                            setCreateOrganization(false);
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
            <div className={styles.actions}>
              <button
                disabled={busy}
                onClick={() =>
                  commercialNavigation.navigate(() => {
                    setAcceptingInvitation((value) => !value);
                    setAdministrationDirty(false);
                  })
                }
              >
                Accept an invitation
              </button>
              {administration?.platform.canProvision ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    commercialNavigation.navigate(() => {
                      setCreateOrganization((value) => !value);
                      setAdministrationDirty(false);
                    })
                  }
                >
                  Platform administration
                </button>
              ) : null}
            </div>
            {acceptingInvitation ? (
              <AcceptInvitation
                key={session.identity?.id}
                handoff={handoff}
                identityName={session.identity?.displayName ?? "current identity"}
                request={request}
                onDirty={setAdministrationDirty}
                onBusy={setBusy}
                onAccepted={async () => {
                  setHandoff(null);
                  await refresh();
                }}
              />
            ) : null}
            {!organization || createOrganization ? (
              administration ? (
                <ProvisionCompany
                  bootstrap={administration}
                  request={request}
                  onDirty={setAdministrationDirty}
                  onBusy={setBusy}
                  onCreated={refresh}
                />
              ) : (
                <p>Checking company access…</p>
              )
            ) : (
              <>
                <nav className={styles.tabs} aria-label="Workspace sections">
                  {(administration?.membership?.role === "field-user"
                    ? (["assigned", "settings"] as const)
                    : (["actions", "leads", "commercial", "proposals", "settings"] as const)
                  ).map((item) => (
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
                            setIntegrationIntent(undefined);
                            setView(item);
                            if (item === "actions") setActionArea("actions");
                          });
                      }}
                    >
                      {item === "assigned"
                        ? "Assigned work"
                        : item === "actions"
                          ? "Action Center"
                          : item === "leads"
                            ? "Leads"
                            : item === "commercial"
                              ? "Proposals"
                              : item === "proposals"
                                ? "Legacy drafts"
                                : "Company settings"}
                    </button>
                  ))}
                </nav>
                {view === "assigned" ? (
                  <AssignedWorkspace
                    key={authorityKey}
                    organizationId={data.currentOrganizationId!}
                    request={commercialRequest}
                    upload={fieldUpload}
                    onDirty={setCommercialDirty}
                    onBusy={setBusy}
                  />
                ) : null}
                {view === "actions" ? (
                  <ActionCenter
                    key={`${authorityKey}:${actionArea}`}
                    initialArea={actionArea}
                    organizationId={data.currentOrganizationId!}
                    request={commercialRequest}
                    onDirty={setCommercialDirty}
                    onBusy={setBusy}
                    onOpen={openActionTarget}
                  />
                ) : null}
                {view === "leads" ? (
                  <LeadWorkspace
                    key={authorityKey}
                    leads={data.leads}
                    proposals={data.proposals}
                    directory={data.intakeDirectory ?? emptyDirectory}
                    permissions={permissions}
                    selectedId={leadId}
                    busy={busy}
                    onDirty={setLeadDirty}
                    request={commercialRequest}
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
                      setDraftTitle("");
                      setDraftContent("");
                    }}
                  />
                ) : null}
                {view === "commercial" ? (
                  <CommercialWorkspace
                    key={`${authorityKey}:${recordIntent?.nonce ?? "browse"}`}
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
                  <>
                    <section className={styles.panel}>
                      <h2>Company settings &amp; access</h2>
                      <p>
                        <strong>{organization.displayName}</strong> ·{" "}
                        {administration?.membership?.role ?? "No active membership"}
                      </p>
                      <p>
                        Your current permissions and enabled modules are verified by the server for
                        every operation.
                      </p>
                      <div className={styles.actions}>
                        <button disabled={busy} onClick={() => void passkey()}>
                          {localDevelopment
                            ? "Refresh development sign-in"
                            : session.session?.hasPasskey
                              ? "Verify passkey"
                              : "Set up passkey"}
                        </button>
                        <button
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
                      </div>
                    </section>
                    {administration ? (
                      <CompanyWorkspace
                        key={`${authorityKey}:${integrationIntent?.nonce ?? "settings"}`}
                        initialIntegrationTarget={integrationIntent}
                        bootstrap={administration}
                        request={commercialRequest}
                        onDirty={setAdministrationDirty}
                        onBusy={setBusy}
                        onChanged={refresh}
                        onOpenLead={openLead}
                        onDownloadEvidence={async (input) => {
                          if (contextBlocked || !data.currentOrganizationId)
                            throw new WorkspaceRequestError(
                              "CPL_ORGANIZATION_CONTEXT_CHANGED",
                              messages.CPL_ORGANIZATION_CONTEXT_CHANGED!,
                            );
                          await downloadInboundEvidence(input, data.currentOrganizationId);
                        }}
                        onAuthorizeIntegration={async (connection) => {
                          const result = await commercialRequest<{ authorizationUrl: string }>(
                            `/api/cpl-integrations/connections/${connection.id}/oauth/start`,
                            {
                              expectedRevision: connection.revision,
                              idempotencyKey: crypto.randomUUID(),
                            },
                          );
                          const destination = new URL(
                            result.authorizationUrl,
                            window.location.origin,
                          );
                          const localCallback =
                            destination.origin === window.location.origin &&
                            destination.pathname === "/api/cpl-integrations/oauth/google/callback";
                          const googleConsent =
                            destination.protocol === "https:" &&
                            destination.origin === "https://accounts.google.com" &&
                            destination.pathname === "/o/oauth2/v2/auth";
                          if (
                            destination.username ||
                            destination.password ||
                            destination.hash ||
                            (localDevelopment ? !localCallback : !googleConsent)
                          )
                            throw new Error(
                              "The integration authorization destination was refused.",
                            );
                          window.location.assign(destination.href);
                        }}
                        onOpenRecipes={() => {
                          setAdministrationDirty(false);
                          setActionArea("recipes");
                          setView("actions");
                        }}
                      />
                    ) : (
                      <section className={styles.panel}>
                        <h2>Company administration</h2>
                        <p>
                          Your current role cannot administer this company. Ask a company owner or
                          administrator for changes.
                        </p>
                      </section>
                    )}
                  </>
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
