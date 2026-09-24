# Phase 5 handoff

Status: **IMPLEMENTED / WORKING locally; post-restart browser readback PASS**. Phase 5A, 5B and 5C are connected to the existing application and real PostgreSQL. Both new fictional companies completed the operational workflow through approved PDFs and configured readiness. This is local product verification, not production SaaS acceptance. See [implementation and evidence](PHASE5_IMPLEMENTATION.md) and [normal screen paths](LOCAL_PHASE5_TESTING.md).

## Preserved starting point

The canonical checkout remains on its existing development branch and private history at `7634a3d0503e21a8aee8a1ae0687023e9eeddffe`, with the accepted product source preserved as working changes. Its 1,216 pre-change source files match the final Phase 4 recovery manifest byte for byte. The separate sanitized public export is clean at `cd9184c6075854b30b1d6dca00a609ca5f085945` before Phase 5 publication. This reference does not authorize a reset.

The private pre-change Phase 5 recovery checkpoint contains source, a consistent PostgreSQL dump with 76 CPL table digests, and verified copies of 52 evidence files. Restoring that dump into a newly created isolated local database reproduced all 76 digests. New migrations must pass on this isolated current-data copy before being applied to the working application database.

## Implemented and exercised

- **5A IMPLEMENTED / WORKING locally:** separate platform provisioning, resumable setup, subject-bound local invitation handoffs, bounded roles, suspension/reactivation, last-owner protection and safe company switching. Actual PostgreSQL tests cover concurrent ownership, invitation lifecycle, live authorization and queued-work revocation. No invitation email is sent.
- **5B IMPLEMENTED / WORKING locally:** company profile, timezone defaults, document branding, catalog revisions, typed intake requirements and the existing proposal/field/report/recipe/readiness editors. Configuration changes affect new work without rewriting approved artifacts or agreements.
- **5C IMPLEMENTED / WORKING locally:** directory create/edit/archive/reactivate, bounded permission-scoped search/counts/pagination, safe audit summaries and related-record links. Browser evidence includes keyboard search, a 46-event audit across two pages and the settled 390-pixel layout.

Alpha owns **PHASE 5 - Alder Inspection Services · Synthetic**. Its original Maple Annex workflow uses USD 650, New York time, required access confirmation, an explicitly authorized automatic proposal draft, a purchase order and an approved report. Beta owns **PHASE 5 - Harbor Design Studio · Synthetic**. Harbor uses CAD 1,200, Los Angeles time, a Design brief choice and a manual proposal workflow; its readiness policy does not require a purchase order. The shared synthetic manager is manager in Alder and member in Harbor.

Both exact-version delivery packages are **READY / NOT SENT**. All eight pages of the four generated proposal/report PDFs were visually inspected after database/file readback. They contain clearly fictional evidence. No customer delivery, signature, payment or native browser save-dialog completion is implied.

Later Alder configuration revisions demonstrate preservation: current catalog USD 675, revised document identity, site address 202, policy version 2 and report-template version 2 leave the original approved USD 650 agreement, address 200, source policy and report-template version unchanged. A separate draft ending `7D24DAB8226E` uses the new configuration and remains unapproved. Alder recipe version 2 deliberately creates the manager action without an automatic proposal draft; its original version/run remains recorded. The older lead now requires current-policy review before another proposal can be created.

## Open and inspect

Double-click the existing `RUN-CPL-COMMAND-CENTER.cmd` in the canonical checkout. Open <http://127.0.0.1:3400/workspace>, choose **Synthetic company owner Alpha** or **Synthetic company owner Beta**, then **Enter development workspace** or **Switch development identity**. The app is explicitly labeled DEVELOPMENT.

Use **Company settings** for saved setup, team, catalog, intake, templates, directory and activity. Use **Proposals → Projects → the company project → Operations / Field work / Reports / Delivery & closeout** for the accepted examples. The [testing guide](LOCAL_PHASE5_TESTING.md) gives exact names and additional click paths. Save unfinished forms before restarting. Use the normal Stop and Restart launchers; do not reset, reseed or manually drain jobs.

## Verification and recovery

Private evidence remains in the existing SSD `product-phase5-20260923` evidence directory, outside the public export. It includes pre-change recovery source/database/evidence, restored-copy migration checks, scoped test receipts, browser captures, all-page PDF inspection, configuration-history comparisons and preserved failed attempts. The final before-restart baseline binds 72 tenant tables, 416 rows, four approved artifacts and six photo files, with no unsettled jobs. Final normal Stop/Restart comparison passed with the identical snapshot and artifact hashes. All 666 pre-existing protected rows across 68 tables and all 52 original evidence files remain exact. Authentication/session/fixture changes are outside the predeclared old-data baseline; new business/configuration rows are additive.

The phantom unsaved-navigation dialog was corrected and retested in the actual browser; real unsaved-entry protection remains covered. Earlier lint warnings and a live Next generated-type compilation failure are retained as failed attempts, not counted as passes. Installed-copy typechecks and the local build passed all 14 tasks (zero cache hits); whole strict lint passed with zero warnings. The real PostgreSQL total is 201 distinct passing cases across 10 files. The scoped UI receipt records 112 component/API and 31 unit passes; retained Phase 1–4 suites have overlapping coverage and are not added into a grand total. Exact scoped results and non-overlapping counts belong in the implementation evidence index; no whole-repository test-suite pass is claimed.

The final private database recovery checkpoint is `after-phase5.dump`, with 84 table digests and 68 hash-verified evidence files in `after-phase5-database-manifest.json`. Final source recovery and verification receipts are indexed in the private `PHASE5_FINAL_COMPLETION.json`; this index is evidence only, not a public release.

## Source and publication

Canonical HEAD is still `7634a3d0503e21a8aee8a1ae0687023e9eeddffe`; the accepted prior product and Phase 5 additions are preserved working changes, not a new local commit. Private source recovery is separate from public publication. No history was reset, rewritten or merged into the sanitized public history.

Phase 5 source is **BLOCKED / NOT PUBLISHED**. Anonymous readback confirmed public main remains `cd9184c6075854b30b1d6dca00a609ca5f085945` and its 1,075-file manifest matches the existing public checkout. The manifest SHA-256 is `0e8750b3e7544ee93fd30b23424f96516ce84172344099c97ff21ac0d32f36ce`. Current GitHub controls do not establish the absence of a provider-side automatic deployment connection. The request forbids deployment, so no export, public commit or push is performed while that guarantee is unavailable. Preserve existing trigger settings; do not disable automation as a workaround. A reviewed private source plan is preparation only.

## Remaining boundaries and next scope

Production Google/passkey/device acceptance, external invitation delivery, deployment linkage, cloud runtime/capacity and production hosting remain **DEFERRED**. Native save dialogs, physical phone/camera and unsupported filesystem junction checks are **NOT RUN**. The browser color-input interaction did not persist proposed alternate accents; both companies use their verified stored default accents with distinct company identities. No claim of different verified accent colors is made.

The next recommended scope is **Phase 6: integrations and intake**, through the existing tenant-safe adapter seams. Do not start that scope implicitly. The [roadmap](PRODUCT_ROADMAP.md) preserves Phases 7–11 and the deferred hosting track.

The existing Run, Stop and Restart launchers remain the normal owner workflow at `http://127.0.0.1:3400/workspace`. Startup must preserve records and queued work. Do not point the public checkout at the canonical database or alter its ownership marker. During development, the coordinator controls migration application, dependency-copy synchronization and restarts; individual implementation tasks must not race those operations.

No cloud-resource changes, actual invitation/customer messages, accounting calls or paid product AI are authorized in this milestone. Native save-dialog, physical phone/camera and unsupported filesystem-junction checks remain separate owner/environment acceptance items.

No cloud resources or deployment settings were changed, no external messages or accounting calls were sent, and no paid product AI was used in Phase 5.

Post-restart database/file persistence and final browser readback are PASS. After the owner manually reopened localhost in a fresh tab, both owner workspaces reopened with their saved setup and linked work; the shared user retained manager access in Alder and member access in Harbor. The application remains READY with the Alder owner workspace open. The earlier retained-error-page restriction and its resolution are recorded separately in `post-restart-browser-boundary.json` and `post-restart-browser-complete.json`; no browser-policy workaround was used.
