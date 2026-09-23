# CPL Command Center

CPL Command Center is a modular application for service-business workflows. This public snapshot contains the Next.js application, Node worker, domain and database packages, migrations, tests and dependency lockfile. It is a local development product checkpoint. Production hosting acceptance is **DEFERRED**.

The current tenant workspace includes structured lead intake; saved proposals, human review and award-to-project handoff; project visits and agenda; field checklists, observations, photos and annotations; reviewed report versions and PDFs; internal automation recipes and an Action Center; and exact-version delivery packages with manual-send records and policy-based closeout/invoice readiness. The [feature map](docs/PRODUCT_FEATURE_MAP.md) distinguishes implemented behavior, bounded local verification and remaining work. The [Phase 2](docs/LOCAL_PHASE2_TESTING.md), [Phase 3](docs/LOCAL_PHASE3_TESTING.md) and [Phase 4](docs/LOCAL_PHASE4_TESTING.md) guides describe the local workflows and their evidence limits.

Local DEVELOPMENT uses an explicitly configured synthetic identity and real tenant-scoped PostgreSQL records. It is restricted to loopback and preserves authorization, sessions, CSRF, membership and role checks. It does not turn off hosted Google/passkey authentication. Use fictional records only. Legacy demonstration engines remain isolated test behavior; PGlite and deterministic providers are simulated evidence.

Internal approval is not a customer signature or professional certification. A PDF download is not delivery. Manual send and acknowledgment entries record a person's stated evidence; no email provider, customer portal, invoice/payment system or paid AI is activated by these workflows.

## Local setup and verification

Use the verified portable Node 24.19.0 and pnpm 11.19.0 toolchain. The repository guard permits only the documented owner-controlled Windows SSD and Linux verification paths; arbitrary root or CI variables do not grant access. See [public source policy](docs/PUBLIC_EXPORT.md).

On the supported Windows SSD checkout, run `node scripts/cpl-install.mjs` for a frozen installation and the exFAT workspace-copy layout. Then run `node scripts/repository-boundary.mjs`, `pnpm source:verify`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and the applicable unit/component/integration suites. `pnpm precommit:verify` is the mandatory local commit gate. Isolated tests do not require hosted credentials; real PostgreSQL suites require their separately scoped test setup.

The [opening guide](OPEN-CPL-COMMAND-CENTER.md) describes `RUN-CPL-COMMAND-CENTER.cmd`, `STOP-CPL-COMMAND-CENTER.cmd`, `RESTART-CPL-COMMAND-CENTER.cmd` and `CPL-Doctor.cmd`. The DEVELOPMENT launcher additionally requires the verified portable PostgreSQL 16.15 toolchain already on the SSD. It does not install software during startup. The supported local address is `http://127.0.0.1:3400/workspace`.

This source snapshot contains no prepared walkthrough database, customer records, uploaded photos or generated PDFs. A public checkout cannot reuse the canonical checkout's existing local database: the ownership marker checks both repository identity and checkout path and refuses a mismatch without altering data. Do not delete that marker, copy credentials, stop another checkout's runtime or repoint the launcher at its database. A separate local setup review is required before running this public checkout on the same machine. The included guides identify synthetic examples from recorded acceptance runs; those records are not distributed with source.

## Hosting and publication

The existing hosted development checkpoint is separate from this local product milestone. Historical Google sign-in and adapter evidence does not establish hosted acceptance of the current workflows. Cloudflare runtime fit, device acceptance and further hosting work remain [DEFERRED](docs/DEFERRED_HOSTING.md). Phase 4 source publication does not deploy this milestone or change existing Workers, databases, DNS, schedules or infrastructure. See [deployment boundary](docs/PUBLIC_DEPLOYMENT.md).

Hosted GitHub Actions remain parked and repository Actions disabled. Dependabot version updates and automatic rebasing are paused in every configured ecosystem; repository security-update automation also remains disabled unless separately authorized. The normal local pre-commit gate must pass before source publication.

This repository has independent public history generated from an allowlisted snapshot. Private Git history, customer-supplied assets, populated personal profiles, credentials, runtime data and private review records are excluded. `PUBLIC_EXPORT_MANIFEST.json` identifies every exported file. Implementation changes originate in the canonical development source and pass through the reviewed export process.

The package license remains `UNLICENSED`; public visibility does not grant an open-source license. Dependencies retain their own license terms and notices. The dependency inventory records reviewed installed versions, and no dependency vendor tree is distributed here. The included CPL mark is a product identity asset, not a trademark license.
