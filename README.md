# CPL Command Center

CPL Command Center is a modular application for service-business workflows. This public source snapshot contains the actual Next.js application, Node worker, domain and database packages, migrations, tests, and dependency lockfile. It is a development checkpoint, not an activated production service.

The hosted slice implements Google identity, sessions and passkeys, organization membership, manually entered leads and proposal drafts, and a bounded PostgreSQL job. The existing Next.js app has an OpenNext Cloudflare adapter and a separate scheduler Worker. Live owner sign-in, device verification, deployed free-plan behavior, and the complete HTTPS workflow remain NOT RUN until recorded against the deployed public commit. See [deployment controls](docs/PUBLIC_DEPLOYMENT.md) and [test coverage](docs/HOSTED_TEST_COVERAGE.md).

Hosted operation requires explicit configuration; an unconfigured local production launch retains the empty setup gate. Legacy tenant migration, live connectors, paid AI calls, and customer communications remain outside this slice. Legacy demonstration workflows require isolated test mode (`NODE_ENV=test`). PGlite and deterministic providers are simulated evidence.

## Local verification

Use the verified portable Node 24.19.0 and pnpm 11.19.0 toolchain. Production activation is not implied by this checkpoint. The owner-controlled Windows paths and supported Linux checkout paths are explicitly validated by `scripts/repository-boundary.mjs`; arbitrary environment variables do not grant access. See [public source policy](docs/PUBLIC_EXPORT.md) for the supported paths and repeatable export process.

On the supported Windows SSD checkout, run `node scripts/cpl-install.mjs` for a frozen installation with workspace copies appropriate to exFAT. Then run `node scripts/repository-boundary.mjs`, `pnpm source:verify`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and the applicable unit/component/integration suites. `pnpm precommit:verify` is the installed local commit gate. Credentials are not required for isolated tests. Local production/setup starts with `Start-CPL.cmd`; `CPL-Doctor.cmd` and `Stop-CPL.cmd` inspect and stop that runtime.

Hosted GitHub Actions are parked and repository Actions must remain disabled. Dependabot version updates and automatic rebasing are paused in every configured ecosystem because Dependabot jobs can bypass Actions disablement. Repository security-update automation must also remain disabled unless separately authorized. Deployment, paid providers, billing, and live customer communications are not activated by publishing source.

## Publication and rights

This repository has independent public history created from an allowlisted snapshot. Private repository history, customer-supplied logos/documents, populated personal profiles, credentials, runtime data, and private review records are excluded. Each exported file is identified in `PUBLIC_EXPORT_MANIFEST.json`. Business implementation changes originate in the canonical development source and pass through the same reviewed export workflow.

The package license remains `UNLICENSED`. Public visibility does not grant an open-source license. Dependency packages retain their own license terms and notices; the dependency inventory records the reviewed installed versions. No dependency vendor tree is distributed here. The included CPL mark is a product identity asset, not a grant to use that trademark.
