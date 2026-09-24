"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  CplAdminBootstrap,
  CplAdminMember,
  CplAdminInvitation,
  CplAdminPage,
  CplInvitationIssueResult,
  CplAdminRole,
} from "@bea/domain/cpl-admin";
import type { CommercialRequest } from "./commercial-ui";
import { useUnsavedNavigation } from "./commercial-navigation";
import styles from "./workspace.module.css";

type Common = {
  request: CommercialRequest;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
};
function useEdit({ onDirty, onBusy }: Common) {
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const attempts = useRef(new Map<string, { payload: string; key: string }>());
  const dirtyParts = useRef(new Set<string>());
  function changedPart(part: string) {
    dirtyParts.current.add(part);
    setDirty(true);
    onDirty(true);
    setNotice("");
  }
  function cleanPart(part: string) {
    dirtyParts.current.delete(part);
    const remaining = dirtyParts.current.size > 0;
    setDirty(remaining);
    onDirty(remaining);
    return remaining;
  }
  function changed() {
    changedPart("default");
  }
  function clean() {
    dirtyParts.current.clear();
    setDirty(false);
    onDirty(false);
  }
  function key(action: string, input: unknown) {
    const payload = JSON.stringify(input),
      old = attempts.current.get(action);
    if (old?.payload === payload) return old.key;
    const value = crypto.randomUUID();
    attempts.current.set(action, { payload, key: value });
    return value;
  }
  async function run(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      await operation();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The change could not be saved.");
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return {
    dirty,
    busy,
    error,
    notice,
    setNotice,
    changed,
    clean,
    changedPart,
    cleanPart,
    key,
    run,
  };
}
function Feedback({ edit }: { edit: ReturnType<typeof useEdit> }) {
  return (
    <>
      {edit.error ? (
        <p role="alert" className={styles.error}>
          {edit.error}
        </p>
      ) : null}
      {edit.notice ? <p role="status">{edit.notice}</p> : null}
    </>
  );
}

const modules = [
  ["intake-job-tracker", "Lead intake"],
  ["proposal-builder", "Proposals"],
  ["award-to-project-launcher", "Project execution"],
  ["field-report-assembler", "Field work and reports"],
] as const;
export function ProvisionCompany(
  props: Common & { bootstrap: CplAdminBootstrap; onCreated: () => Promise<void> },
) {
  const edit = useEdit(props),
    [revision, setRevision] = useState(0);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = {
      displayName: String(form.get("displayName") ?? ""),
      slug: String(form.get("slug") ?? ""),
      initialOwnerIdentityId: String(form.get("owner") ?? ""),
      enabledModules: form.getAll("modules").map(String),
    };
    await edit.run(async () => {
      await props.request("/api/cpl-admin/platform/organizations", {
        ...input,
        idempotencyKey: edit.key("provision", input),
      });
      edit.clean();
      setRevision((n) => n + 1);
      await props.onCreated();
      edit.setNotice(
        "Company created. Its initial owner can now sign in and configure it. The platform operator has not been added as a company member.",
      );
    });
  }
  if (!props.bootstrap.platform.canProvision)
    return (
      <section className={styles.panel}>
        <h2>Company access</h2>
        <p>
          No company is selected. Choose a company you belong to, or accept an invitation from its
          administrator.
        </p>
        <p>Creating a company requires the separate authorized platform operator.</p>
      </section>
    );
  return (
    <section className={styles.panel}>
      <h2>Platform administration · Create company</h2>
      <p>
        This creates an empty company with a distinct initial owner. It does not give the platform
        operator access to company records.
      </p>
      <Feedback edit={edit} />
      <form
        key={revision}
        className={styles.form}
        onChange={edit.changed}
        onSubmit={(e) => void submit(e)}
      >
        <fieldset className={styles.fieldset} disabled={edit.busy}>
          <label className={styles.field}>
            Company name
            <input name="displayName" required maxLength={240} />
          </label>
          <label className={styles.field}>
            Company workspace key
            <input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,61}[a-z0-9]" />
            <small>Unique lowercase letters, numbers and hyphens.</small>
          </label>
          <label className={styles.field}>
            Initial company owner
            <select name="owner" required defaultValue="">
              <option value="">Choose a verified identity</option>
              {props.bootstrap.localRecipients
                .filter((person) => person.identityId !== props.bootstrap.identity.id)
                .map((person) => (
                  <option key={person.identityId} value={person.identityId}>
                    {person.displayName}
                  </option>
                ))}
            </select>
          </label>
          <div>Enabled product modules</div>
          {modules.map(([id, label]) => (
            <label key={id}>
              <input type="checkbox" name="modules" value={id} defaultChecked />
              {label}
            </label>
          ))}
          <button className={styles.primary} type="submit">
            Create company
          </button>
        </fieldset>
      </form>
    </section>
  );
}

export type InvitationHandoff = { organizationId: string; invitationToken: string };
/** Fragments never reach HTTP logs. Clear immediately, and keep no persistent browser copy. */
export function readInvitationHandoff(value: string, origin: string): InvitationHandoff | null {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname !== "/workspace" || url.search) return null;
    const p = new URLSearchParams(url.hash.slice(1));
    if (
      [...p.keys()].some((k) => !["cplInvite", "organization"].includes(k)) ||
      p.getAll("cplInvite").length !== 1 ||
      p.getAll("organization").length !== 1
    )
      return null;
    const token = p.get("cplInvite")!,
      org = p.get("organization")!;
    if (
      !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(org)
    )
      return null;
    return { organizationId: org, invitationToken: token };
  } catch {
    return null;
  }
}
export function AcceptInvitation(
  props: Common & {
    handoff: InvitationHandoff | null;
    identityName: string;
    onAccepted: () => Promise<void>;
  },
) {
  const edit = useEdit(props),
    [link, setLink] = useState(""),
    [done, setDone] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await edit.run(async () => {
      const input = props.handoff ?? readInvitationHandoff(link, window.location.origin);
      if (!input)
        throw new Error(
          "Paste the full local invitation handoff link. It must belong to this workspace.",
        );
      await props.request("/api/cpl-admin/invitations/accept", {
        ...input,
        idempotencyKey: edit.key("accept", input),
      });
      setDone(true);
      setLink("");
      edit.clean();
      await props.onAccepted();
      edit.setNotice(
        "Invitation accepted for this signed-in identity. Select the company to continue.",
      );
    });
  }
  return (
    <section className={styles.panel}>
      <h2>Accept company invitation</h2>
      <p>
        Accepting as <strong>{props.identityName}</strong>. Only the intended verified identity can
        redeem the invitation. No email was sent by this application.
      </p>
      <Feedback edit={edit} />
      {!done ? (
        <form onSubmit={(e) => void submit(e)} className={styles.form}>
          <fieldset disabled={edit.busy} className={styles.fieldset}>
            {props.handoff ? (
              <p>Local handoff received. The token was removed from the address bar.</p>
            ) : (
              <label className={styles.field}>
                Local invitation handoff link
                <textarea
                  required
                  value={link}
                  onChange={(e) => {
                    setLink(e.target.value);
                    edit.changed();
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            )}
            <button type="submit" className={styles.primary}>
              Accept invitation as this identity
            </button>
          </fieldset>
        </form>
      ) : null}
    </section>
  );
}

export function TeamAdministration(
  props: Common & { bootstrap: CplAdminBootstrap; onChanged: () => Promise<void> },
) {
  const edit = useEdit(props),
    navigation = useUnsavedNavigation(edit.dirty);
  const [tab, setTab] = useState<"members" | "invitations">("members"),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [applied, setApplied] = useState({ query: "", status: "all" }),
    [cursor, setCursor] = useState<string | null>(null),
    [page, setPage] = useState<CplAdminPage<CplAdminMember | CplAdminInvitation> | null>(null),
    [loadError, setLoadError] = useState(""),
    [loading, setLoading] = useState(false),
    [reload, setReload] = useState(0),
    [selected, setSelected] = useState<CplAdminMember | null>(null),
    [issued, setIssued] = useState<CplInvitationIssueResult | null>(null),
    [formRevision, setFormRevision] = useState(0),
    [inviteRevision, setInviteRevision] = useState(0);
  const requestRef = useRef(props.request);
  useEffect(() => {
    requestRef.current = props.request;
  }, [props.request]);
  const generation = useRef(0);
  const load = useCallback(
    async (current: number) => {
      setLoading(true);
      setLoadError("");
      const parameters = new URLSearchParams({
        ...applied,
        limit: "25",
        ...(cursor ? { cursor } : {}),
      });
      try {
        const result = await requestRef.current<CplAdminPage<CplAdminMember | CplAdminInvitation>>(
          `/api/cpl-admin/${tab}?${parameters}`,
        );
        if (current === generation.current) setPage(result);
      } catch (e) {
        if (current === generation.current)
          setLoadError(e instanceof Error ? e.message : "List unavailable.");
      } finally {
        if (current === generation.current) setLoading(false);
      }
    },
    [tab, applied, cursor],
  );
  useEffect(() => {
    let active = true;
    const current = ++generation.current;
    void Promise.resolve().then(() => (active ? load(current) : undefined));
    return () => {
      active = false;
      generation.current = current + 1;
    };
  }, [load, reload]);
  function discardChanges() {
    edit.clean();
    setSelected(null);
    setFormRevision((n) => n + 1);
  }
  async function memberSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    const input = {
      identityId: selected.identityId,
      expectedVersion: selected.version,
      role: String(form.get("role")),
      status: String(form.get("status")),
      reason: String(form.get("reason")),
    };
    await edit.run(async () => {
      await props.request("/api/cpl-admin/members", {
        ...input,
        idempotencyKey: edit.key("member", input),
      });
      edit.cleanPart("member");
      setSelected(null);
      await props.onChanged();
      setReload((n) => n + 1);
      edit.setNotice(
        "Membership changed. Historical authorship and assignments remain; reassign outstanding work deliberately.",
      );
    });
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = {
      recipientIdentityId: String(form.get("recipient")),
      role: String(form.get("role")),
      expiresInMinutes: Number(form.get("expires")),
    };
    await edit.run(async () => {
      const result = await props.request<CplInvitationIssueResult>("/api/cpl-admin/invitations", {
        ...input,
        idempotencyKey: edit.key("invite", input),
      });
      setIssued(result);
      const otherEdits = edit.cleanPart("invite");
      setInviteRevision((n) => n + 1);
      if (!otherEdits) setReload((n) => n + 1);
      edit.setNotice(
        otherEdits
          ? "Invitation prepared. Other unsaved forms are retained; save or discard them before refreshing the list."
          : "Invitation prepared. No message was sent.",
      );
    });
  }
  async function invitationAction(
    event: FormEvent<HTMLFormElement>,
    item: CplAdminInvitation,
    action: "reissue" | "revoke",
  ) {
    event.preventDefault();
    const formElement = event.currentTarget,
      form = new FormData(formElement);
    const input = { expectedVersion: item.version, reason: String(form.get("reason")) };
    await edit.run(async () => {
      setIssued(
        await props.request<CplInvitationIssueResult>(
          `/api/cpl-admin/invitations/${item.id}/${action}`,
          { ...input, idempotencyKey: edit.key(`${item.id}:${action}`, input) },
        ),
      );
      const otherEdits = edit.cleanPart(`invitation:${item.id}`);
      formElement.reset();
      if (!otherEdits) setReload((n) => n + 1);
      edit.setNotice(
        (action === "revoke"
          ? "Invitation revoked."
          : "New invitation issued. The prior token is invalid.") +
          (otherEdits
            ? " Other unsaved forms are retained; save or discard them before refreshing the list."
            : ""),
      );
    });
  }
  const handoff = issued?.token
    ? `${typeof window === "undefined" ? "" : window.location.origin}/workspace#cplInvite=${issued.token}&organization=${issued.invitation.organizationId}`
    : null;
  return (
    <section className={styles.panel}>
      {navigation.dialog}
      <h2>Team &amp; invitations</h2>
      <p>
        Role changes are checked against your current authority. Owners protect the last active
        owner; administrators can manage only lower roles.
      </p>
      <div className={styles.tabs}>
        {(["members", "invitations"] as const).map((value) => (
          <button
            key={value}
            aria-current={tab === value ? "page" : undefined}
            disabled={edit.busy}
            onClick={() =>
              navigation.navigate(() => {
                setTab(value);
                setSelected(null);
                setIssued(null);
                setCursor(null);
                setPage(null);
                setFilter("all");
                setApplied({ query: "", status: "all" });
                setQuery("");
                discardChanges();
              })
            }
          >
            {value === "members" ? "Members" : "Invitations"}
          </button>
        ))}
      </div>
      <Feedback edit={edit} />
      {loadError ? <p role="alert">{loadError}</p> : null}
      <form
        className={styles.actions}
        onSubmit={(event) => {
          event.preventDefault();
          navigation.navigate(() => {
            setApplied({ query, status: filter });
            setCursor(null);
            setPage(null);
            setSelected(null);
            discardChanges();
          });
        }}
      >
        <label>
          Search{" "}
          <input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={160} />
        </label>
        <label>
          Status{" "}
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">All</option>
            {(tab === "members"
              ? ["active", "suspended", "removed"]
              : ["pending", "expired", "revoked", "redeemed", "authority_changed"]
            ).map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        </label>
        <button disabled={edit.busy}>Search {tab}</button>
      </form>
      {loading ? <p role="status">Loading {tab}…</p> : null}
      <p>
        {page?.total ?? 0} matching {tab} · up to 25 per page
      </p>
      <ul className={styles.list}>
        {page?.items.map((item) =>
          "displayName" in item ? (
            <li key={item.identityId}>
              <strong>{item.displayName}</strong> · {item.role} · {item.status} · revision{" "}
              {item.version}
              {item.needsReassignment ? <p>Review outstanding assignments.</p> : null}
              {item.canChange ? (
                <button
                  disabled={edit.busy}
                  onClick={() =>
                    navigation.navigate(() => {
                      setSelected(item);
                      edit.clean();
                      setFormRevision((n) => n + 1);
                    })
                  }
                >
                  Change membership for {item.displayName}
                </button>
              ) : null}
            </li>
          ) : (
            <li key={item.id}>
              <strong>{item.recipientDisplayName}</strong> · {item.role} · {item.status}
              <p>
                Expires {new Date(item.expiresAt).toLocaleString()} · version {item.version}
              </p>
              {item.canReissue || item.canRevoke ? (
                <form
                  key={formRevision}
                  onChange={() => edit.changedPart(`invitation:${item.id}`)}
                  onSubmit={(event) => {
                    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute(
                      "value",
                    );
                    void invitationAction(event, item, action === "revoke" ? "revoke" : "reissue");
                  }}
                >
                  <fieldset disabled={edit.busy} className={styles.fieldset}>
                    <label>
                      Reason <input name="reason" required maxLength={2000} />
                    </label>
                    {item.canReissue ? (
                      <button name="action" value="reissue">
                        Reissue local handoff
                      </button>
                    ) : null}
                    {item.canRevoke ? (
                      <button name="action" value="revoke">
                        Revoke invitation
                      </button>
                    ) : null}
                  </fieldset>
                </form>
              ) : null}
            </li>
          ),
        )}
      </ul>
      <div className={styles.actions}>
        <button
          disabled={edit.busy || !cursor}
          onClick={() =>
            navigation.navigate(() => {
              setCursor(null);
              discardChanges();
            })
          }
        >
          First page
        </button>
        <button
          disabled={edit.busy || !page?.nextCursor}
          onClick={() =>
            navigation.navigate(() => {
              setCursor(page?.nextCursor ?? null);
              discardChanges();
            })
          }
        >
          Next page
        </button>
        <button
          disabled={edit.busy}
          onClick={() =>
            navigation.navigate(() => {
              setReload((n) => n + 1);
              discardChanges();
              setSelected(null);
            })
          }
        >
          Refresh {tab}
        </button>
      </div>
      {selected ? (
        <form
          key={`${selected.identityId}:${selected.version}`}
          onChange={() => edit.changedPart("member")}
          onSubmit={(event) => void memberSave(event)}
          className={styles.form}
        >
          <h3>Change {selected.displayName}</h3>
          <fieldset disabled={edit.busy} className={styles.fieldset}>
            <label className={styles.field}>
              Role
              <select name="role" defaultValue={selected.role}>
                {props.bootstrap.roles
                  .filter((role) => role.canGrant || role.role === selected.role)
                  .map((role) => (
                    <option key={role.role} value={role.role}>
                      {role.role} — {role.description}
                    </option>
                  ))}
              </select>
            </label>
            <label className={styles.field}>
              Membership status
              <select name="status" defaultValue={selected.status}>
                {["active", "suspended", "removed"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              Reason for membership change
              <textarea name="reason" required maxLength={2000} />
            </label>
            <button>Save membership change</button>
          </fieldset>
        </form>
      ) : null}
      {tab === "invitations" && props.bootstrap.permissions.canManageMembers ? (
        <form
          key={`${formRevision}:${inviteRevision}`}
          className={styles.form}
          onChange={() => edit.changedPart("invite")}
          onSubmit={(event) => void invite(event)}
        >
          <h3>Prepare invitation · NOT SENT</h3>
          <fieldset disabled={edit.busy} className={styles.fieldset}>
            <label className={styles.field}>
              Verified invitation recipient
              <select name="recipient" required defaultValue="">
                <option value="">Choose identity</option>
                {props.bootstrap.localRecipients.map((person) => (
                  <option key={person.identityId} value={person.identityId}>
                    {person.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              Invitation role
              <select name="role" defaultValue="member">
                {props.bootstrap.roles
                  .filter((role) => role.canGrant && role.role !== "owner")
                  .map((role) => (
                    <option key={role.role} value={role.role as CplAdminRole}>
                      {role.role} — {role.description}
                    </option>
                  ))}
              </select>
            </label>
            <label className={styles.field}>
              Expires in minutes
              <input
                name="expires"
                type="number"
                defaultValue={1440}
                min={5}
                max={10080}
                required
              />
            </label>
            <button>Create local handoff invitation</button>
          </fieldset>
          <p>
            Ownership is granted deliberately through an authorized membership change after joining.
            Invitations do not grant platform access.
          </p>
        </form>
      ) : null}
      {issued ? (
        <section className={styles.notice}>
          <h3>Invitation NOT SENT</h3>
          {handoff ? (
            <>
              <p>
                This handoff token is shown once. Copy it to the intended local synthetic recipient.
                It is not stored in the invitation list.
              </p>
              <label className={styles.field}>
                Local handoff link
                <textarea readOnly value={handoff} spellCheck={false} />
              </label>
              <button
                onClick={() =>
                  void edit.run(async () => {
                    await navigator.clipboard.writeText(handoff);
                    edit.setNotice("Local handoff copied. No message was sent.");
                  })
                }
              >
                Copy local handoff
              </button>
              <button onClick={() => setIssued(null)}>Hide handoff token</button>
            </>
          ) : (
            <p>
              No token is available from this response. To recover a lost token, deliberately
              reissue the invitation with a reason.
            </p>
          )}
        </section>
      ) : null}
    </section>
  );
}
