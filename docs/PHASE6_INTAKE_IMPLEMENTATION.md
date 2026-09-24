# Phase 6A–6B integration and inbound intake architecture

This milestone extends the existing tenant PostgreSQL application. It does not complete Phase 6C sending/calendar/CRM synchronization or establish production hosting or live Gmail acceptance. See the testing guide and handoff for the measured acceptance results.

## Durable workflow

Both anonymous inquiry forms and signed submissions resolve a saved public source identifier on the server. Gmail identifies source events by the verified provider account and message ID. Each accepted input creates an immutable original, a company-scoped receipt, and a job in the existing workflow queue within one transaction. A success response means source receipt is durable, not that a lead is ready.

The normal local worker dispatches the new receipt and Gmail job kinds alongside existing jobs. Receipt processing applies the pinned mapping and calls the existing intake transaction kernel. Lead creation, original-source evidence, linkage, normalization history and applicable internal events commit together. The resulting lead remains in the existing review workflow. There is no second CRM or queue.

Only an authorized human can confirm information and mark a lead ready. An explicitly enabled matching Phase 4 recipe may then prepare the linked proposal draft. Neither an anonymous submission nor a Gmail message can approve, award, deliver, or mark invoice readiness.

## Additive persistence

- `0038_cpl_company_integrations.sql`: tenant provider accounts, versioned sources/configuration, encrypted credential envelopes, OAuth attempts, versioned mappings, mutation idempotency and integration events.
- `0039_cpl_durable_inbound.sql`: immutable originals, receipts, normalization history, replay and abuse counters, durable queue integration, restricted server lookup and worker authority functions.

These migrations follow the accepted Phase 5 head `0037`. Original intake, proposal, project, field, report, delivery and administration records remain independent. The upgrade is first tested against an isolated restored Phase 5 database, with old-row comparison, before the ordinary local launcher applies it to the synthetic development database.

All tenant tables retain enforced row-level security. The application web role and worker role receive their distinct minimum grants through the existing role configurator. Ingestion requires an explicit worker capability opt-in; a generic queue worker does not automatically receive source or credential access. Public lookup functions return only deliberately published metadata and bounded authority context, not a tenant directory.

## Connection authority and credentials

Connection state, configuration version, generation, authorizing identity and membership version are separate. Settings actions require current session, CSRF for mutations, selected-company consistency, role permission and module entitlement. Source content and original downloads additionally require source-read permission. Ordinary status DTOs never include tokens.

The server checks live membership, entitlement, connection state, configuration/generation and worker lease before provider operations and before committing results. Provider HTTP runs outside SQL transactions. Short transactions establish or recheck authority; final writes are fenced by current authority and lease. Pausing, disconnecting or changing configuration invalidates old generations. A request already transmitted to a provider cannot be undone; its stale result is prevented from restoring credentials or committing new business records.

Human label/checkpoint operations and worker sync share a bounded per-connection operation lease. Token refresh uses that lease plus credential revision compare-and-swap, current-generation checks and authenticated encryption. An omitted replacement refresh token retains the previously valid token for the same verified account. Missing refresh material, revoked consent or inadequate scopes requires corrective authorization rather than an endless retry loop.

AES-GCM envelopes bind purpose, organization, connection and credential revision as authenticated context and record the key version. Unknown versions, altered ciphertext or another tenant/context fail closed. Live key material must come from externally supplied configuration; no key or provider credential is in product source. Disconnect deletes this connection's stored credentials and OAuth attempts, cancels stale work and preserves historical receipts/evidence. It does not automatically revoke a Google grant that might affect other connections. Provider revocation code is separately fixture-tested; no owner's grant is revoked by local acceptance.

## Google authorization boundary

Gmail authorization is separate from Google application sign-in. It uses an authorization code, unpredictable single-use five-minute state bound to the initiating session/company/connection, PKCE and nonce. Callback ownership comes from stored state and the initiating authenticated session, never a callback tenant field or the currently selected company. Permission and membership are checked again after provider exchange.

The adapter validates the signed identity token, issuer, audience, nonce, timestamps, stable subject, verified email and access-token hash when supplied. It verifies the returned permission set. Reconnecting another mailbox cannot silently replace the connection's verified account. The selected label limits what the application ingests; it does not narrow Google's granted read permission.

Requested permissions are `openid`, `email` and `https://www.googleapis.com/auth/gmail.readonly`. There are no send, modify, label-write or full-mailbox-write scopes. Google classifies Gmail read-only as restricted, with verification and server-side data security requirements. These are launch dependencies, not completed acceptance. See [scope definitions](https://developers.google.com/workspace/gmail/api/auth/scopes), [server authorization flow](https://developers.google.com/identity/protocols/oauth2/web-server), and [OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices), reviewed for this implementation.

Ordinary request/error logging excludes callback parameters, provider bodies, credentials and source content. The local web request logger suppresses the OAuth callback path. Unexpected failures return and log a correlation ID only.

## Explicit local provider fixture

The normal SSD launcher supplies a separate DPAPI-protected fixture envelope and RSA signing material. This is unrelated to saved Google sign-in configuration. Its persisted epoch and organization identity make synthetic accounts/messages stable across restarts. The real adapter performs PKCE exchange, signed identity verification, refresh, label/profile reads, pagination and message decoding against the isolated HTTP fixture transport.

The fixture factory requires explicit development/test configuration, strict loopback origin, the verified restricted local database/role/marker, and no hosted or live/sign-in credential configuration. It has no fallback to network fetch. Synthetic local identities cannot attach real credentials. Production build/deployment checks reject fixture flags, local material and the launcher schema manifest. Merely adding a URL parameter or public request cannot enable the fixture.

The live runtime factory exists behind explicit production configuration with a dedicated OAuth client, exact HTTPS redirect and external key ring. It is unconfigured and unexecuted for this milestone. No live consent, mailbox data, Google verification or production identity acceptance is implied by fixture tests.

## Form publication and signed contract

An administrator explicitly saves field/schema configuration and permitted active services, previews it, and separately publishes the form. Public metadata contains customer-visible labels/options and approved service descriptions, not prices, directory IDs, employee roles or operational state. Declared typed fields include bounded text, email, date, boolean and choice values. Unknown/internal fields, invalid dates, unpublished or archived services and stale configuration versions are rejected.

The public endpoint is `POST /api/cpl-inbound/forms/{publicId}`. The signed backend endpoint is `POST /api/cpl-inbound/sources/{publicId}`. Both consume the same bounded UTF-8 JSON contract:

```json
{
  "configurationVersion": 1,
  "eventId": "caller-generated-unique-event-identity",
  "values": { "title": "Fictional inquiry", "details": "Synthetic request" },
  "serviceId": null
}
```

Values must match that saved form's published keys and types. A service ID must be in its published selection. Opaque server receipt references contain no lead/member/company record details. There is no anonymous internal receipt-status API.

Payloads are limited to 64 KiB, with a ten-second body-read deadline. PostgreSQL enforces aggregate and valid-source request budgets; unknown identifiers cannot create an unbounded collection of quota keys. Original retention is bounded per company by both receipt count and byte size. Capacity exhaustion stops new capture with a visible error, without silently deleting previous evidence. Exact quota values are defined in the shared SQL/source-capacity code and tested at the boundary.

The local endpoint deliberately ignores untrusted forwarding headers. Anonymous requests share the aggregate budget; it does not pretend to have a trusted client IP. Same-origin checks are additional browser defenses, not authentication or adequate hosted spam protection. Hosted edge identity, rate controls and operational abuse acceptance remain deferred.

Signed requests use a separately generated, revocable credential scoped to one source. The administrator receives the secret once; ordinary settings APIs expose only its identifier and generation. Rotation/revocation invalidates the prior credential. Send these headers:

```text
x-cpl-source-key: <source key ID>
x-cpl-timestamp: <Unix seconds>
x-cpl-nonce: <32 random bytes, base64url without padding>
x-cpl-signature: <HMAC-SHA256, base64url without padding>
Content-Type: application/json
```

The signature covers the UTF-8 JSON encoding of this ordered array:

```text
["cpl-inbound-v1","POST",publicId,keyId,keyGeneration,timestamp,nonce,sha256(rawBody)]
```

The timestamp is a string; generation is an integer; the body hash is lowercase hexadecimal. Verification uses the exact raw bytes, a bounded timestamp window and constant-time cryptographic verification. Nonce replay protection is separate from event idempotency. An identical authenticated retry returns the existing receipt; a changed body with the same event ID conflicts. Preserve identical serialized bytes when retrying. A new signature/nonce for the same unchanged event also converges. A reused nonce cannot authorize a different event/body.

`scripts/examples/cpl-signed-inquiry.mjs` is a local-only sender using environment placeholders and JSON on stdin. It cannot target a remote host and does not log credentials or request content. Never embed the credential in frontend code, a URL or a committed example.

## Gmail sync and coverage

Saving a selection requires a verified existing label and an explicit `from_now` or bounded-backfill policy. The adapter only lists/reads selected messages and history; it does not modify messages, create labels, follow source links or fetch remote images.

A from-now selection captures the provider's current history checkpoint. Bounded backfill captures a history baseline before listing the selected label after the configured date, with an explicit maximum. History identifiers remain decimal strings. Each page's message IDs and continuation are durable before fetching message bodies. Each captured original/receipt/job commits with removing that ID from the pending page. The checkpoint advances only after pending page work is accounted for. A restart can repeat provider reads, but durable uniqueness prevents a second receipt/lead for the same event.

Each normal worker turn handles at most four messages with bounded time and provider deadlines. Continuations are queued; completed cycles schedule the next configured poll through the existing queue. Empty pages yield rather than spinning. Retries honor bounded provider Retry-After guidance and exponential delay. Permanent permission failures stop until correction. Unavailable/deleted/out-of-selection messages and capped backfill leave explicit coverage warnings. Expired history enters visible resync-required state: the operator must choose a bounded reconciliation instead of silently widening to the full mailbox.

Stable event uniqueness is organization + verified provider account + Gmail message ID. Overlapping selections and reconnecting the same mailbox converge. Different messages in one thread or from one sender remain independent. Content identity excludes mutable label/history metadata while exact original response bytes have their own hash. Conflicting content for the same event is retained as a visible failure rather than overwriting source evidence.

The parser bounds source size, body size, MIME depth/part count and attachment metadata. Supported text is decoded as inert data. Unsupported/malformed content is flagged. Attachment names/types/sizes are listed with `not_ingested`/unavailable status; bytes, OCR, AI extraction and attachment understanding are not claimed. Original JSON downloads require tenant source-read authorization and use attachment, octet-stream, no-store, nosniff and sandbox headers.

The checkpoint approach follows [Google's sync guidance](https://developers.google.com/workspace/gmail/api/guides/sync) and [history pagination/expiry contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list). The bounded intake selection and explicit incomplete-coverage state are application policy, not a claim of full mailbox synchronization.

## Mapping and review

Mappings are immutable versions with declared source fields, typed targets and bounded trim/whitespace/email transformations. There is no executable template language, JavaScript/SQL evaluation or dynamic fetch. Preview and worker use the same normalization code.

Structured fields retain source provenance. Gmail sender/header values remain claims, not verified customer identity. The adapter does not infer services, addresses, budgets, findings or dates from prose. Receipts display original source, mapping version, normalized results, attempts, warnings and linked lead. Authorized reprocessing records a new normalization but cannot overwrite a human-corrected linked lead or create another lead. Earlier mappings and originals remain inspectable.

A public calendar date is normalized to midnight in the company's configured timezone for the existing lead timestamp contract. It is a requested date, not a confirmed appointment. Preview, processing and explicit reprocessing share this rule; the normalization records `dateOnlyTimeZone`, while original source bytes retain the date exactly as submitted. A nonexistent or ambiguous local midnight is rejected for review rather than guessed.

## Entry readiness and acceptance boundaries

Recovery from a PostgreSQL backup restored with `--no-acl` needs an explicit operator step before runtime-role provisioning: revoke all `PUBLIC` privileges on the four Phase 6 `SECURITY DEFINER` functions: `public.cpl_integration_oauth_context(text,text)`, `public.cpl_inbound_admission_budget(text)`, `public.cpl_inbound_public_context(text)` and `public.cpl_ingestion_lock_authority(uuid,uuid,uuid)`. PostgreSQL restores their default execute privilege when ACLs are omitted. The runtime verifier deliberately refuses that state; do not weaken or bypass it. The retained real-PostgreSQL recovery test verifies the refusal, applies only those revocations, then verifies restored data, tenant isolation and restricted runtime roles.

The normal launcher supplies the exact migration ID/checksum manifest after migration verification. Development entry checks that ledger, required session columns/privileges and active synthetic identities after the existing strict local database guard. It does not manufacture a session merely to label the application ready. Entry failures retain safe correlation diagnostics; CSRF, origin, session security and tenant authorization remain required.

Acceptance distinguishes provider-fixture, restricted PostgreSQL, actual browser, normal restart, source preservation and live-provider evidence. Previous failed attempts are retained alongside corrected checks. See `PHASE6_HANDOFF.md` for exact measured results and `PHASE6_LIVE_GMAIL_ACCEPTANCE.md` for the separately authorized live checklist.
