# Live Gmail acceptance — DEFERRED

Phase 6A–6B implements an executable read-only adapter. Controlled HTTP fixtures, local PostgreSQL, and local browser checks are separate evidence levels. None proves that a real mailbox has authorized this application or that Google has approved its public use.

Do not execute this checklist without a separate owner instruction identifying the organization, test account, data, connection, and permitted read operations. The Phase 6 build authorization does not grant mailbox access, permit reusing sign-in credentials, or authorize new cloud configuration.

## Owner-approved scope

- Identify the real application company and authorized member. Use a securely authenticated real identity, current company membership, the applicable permission and entitlement, and the normal session/CSRF controls. A synthetic local persona cannot authorize a live connection.
- Identify a dedicated test mailbox and an existing intake label containing explicitly approved test messages. Record a bounded start date and maximum backfill size. Never choose the full mailbox by default.
- Confirm which body content and attachment metadata may be read and retained. Attachment bytes, OCR, AI extraction, sending, label changes, marking read, deletion, watch registration, and calendar/CRM operations are outside this implementation.
- Record the expected impact of disconnect separately from provider grant revocation. Ordinary disconnect deletes this application's stored credentials and fences pending work; it does not claim to revoke Google's broader grant.

## Configuration and Google requirements

- Review the dedicated Gmail OAuth client configuration separately from Google sign-in. Confirm the exact HTTPS application origin and callback `/api/cpl-integrations/oauth/google/callback`, approved redirect registration, secret custody, consent-screen status, audience, and test-user restrictions. Do not silently expand an existing sign-in grant.
- Supply externally managed encryption keys and an active key version through secret configuration. Verify that absent keys, unknown versions, wrong tenant/connection context, and modified ciphertext fail closed. Retain required old key versions through a separately reviewed key-rotation procedure.
- Request `openid`, `email`, and `https://www.googleapis.com/auth/gmail.readonly` only. Verify the actual granted scopes and stable issuer/subject evidence. The chosen label constrains application ingestion; it does **not** reduce the breadth of the OAuth permission. See [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).
- Resolve the applicable restricted-scope verification and security-assessment requirements before external launch. The implementation and fixture tests do not satisfy or waive those requirements. Review Google's current [OAuth requirements and best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices) and the [server authorization flow](https://developers.google.com/identity/protocols/oauth2/web-server).
- Confirm HTTPS, secure sessions, approved OAuth callback handling, provider secret storage, log redaction, retention, account disconnection, and data-deletion policies in the actual intended hosting environment. Production hosting acceptance remains a separate track.

## Required live evidence

- Owner performs explicit consent to the declared scopes. Preserve sanitized evidence of account identity, scope set, company, authorizing member, configuration version, and authorization time. Never record codes, access/refresh tokens, cookies, or raw request URLs in evidence or logs.
- Exercise deny/cancel, expired state, reused state, wrong initiating session, company switching during consent, and a revoked member. None may attach credentials to the wrong company or resurrect a revoked grant.
- Confirm offline refresh behavior with the real provider: expiry, an omitted replacement refresh token, a revoked grant, insufficient permission, and serialized refresh. Do not deliberately revoke an unrelated grant to create this evidence.
- List existing labels, save an explicit bounded selection, enqueue normal sync, and inspect actual durable receipt and worker state. A configured or authorized connection is not yet a successful sync; a successful sync is not automatically a created or reviewed lead.
- Compare approved source message IDs, original selected content, body decoding, attachment limitations, persisted mapping version, and the linked non-ready leads. Verify that distinct inquiries from one sender/thread remain distinct.
- Reconnect the same verified account and exercise overlapping selections without multiplying receipts or leads. A different account requires deliberate separate handling; do not silently substitute it.
- Verify pagination, lossless history IDs, durable page work before checkpoint advancement, committed-response loss, mid-batch restart, deleted messages, partial failure, rate limits, and bounded history-expiry recovery. Record incomplete coverage honestly. Use [Google's sync guidance](https://developers.google.com/workspace/gmail/api/guides/sync) and [history contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).
- Pause/disconnect, disable the module, revoke the authorizing membership, and change configuration while work is queued or in flight. Verify that new operations stop and stale results cannot commit. A request already transmitted to Google cannot be undone.
- Review a resulting lead through the ordinary authorized screen. Only human readiness may trigger an enabled proposal recipe. No source input may approve, award, send, or mark invoice readiness.
- Record exact source revision, environment, test account and approved data scope, expected versus observed counts, sanitized logs, durable readbacks, unresolved failures, and cleanup/retention decisions.

## Acceptance labels

- **IMPLEMENTED:** reviewed provider and application code exists.
- **PROVIDER-FIXTURE VERIFIED:** actual adapter and cryptography executed against isolated synthetic HTTP responses.
- **LOCAL POSTGRESQL VERIFIED:** restricted roles, transactions, receipts, worker behavior, and recovery were exercised on the declared local database.
- **BROWSER VERIFIED:** the stated clicks and outcomes were observed in the actual application.
- **LIVE GMAIL VERIFIED:** use only after all relevant owner-approved live checks above have recorded evidence.
- **DEFERRED:** real consent/mailbox acceptance, production identity and hosting acceptance, and applicable Google launch approval until separately authorized and completed.

Phase 6C outbound delivery, calendar, and CRM synchronization remain separate product work. This checklist does not authorize them.
