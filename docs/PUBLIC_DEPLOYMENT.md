# Public source and deployment boundary

Status: hosting adapter and bounded workflow IMPLEMENTED. Hosted code deployment and live owner acceptance: NOT RUN until recorded against a published commit. This source does not establish a production service or automatic deployment connection.

The development checkout exports reviewed application source to `AaronStarrett/CPL-Command-Center-Public`. The public repository has independent history. A release must use a specific public commit and its `PUBLIC_EXPORT_MANIFEST.json`; never deploy a private branch or merge private history into the public repository. GitHub Actions remain disabled. Dependabot version updates use zero open-PR limits and disabled rebasing in both configured ecosystems; repository security-update automation must remain disabled unless separately authorized. These are separate controls because [Dependabot jobs bypass Actions disablement](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-on-actions).

## Implemented release path

The existing Next.js application uses the pinned OpenNext Cloudflare adapter. A separate, bounded Cloudflare scheduler invokes the same PostgreSQL workflow implementation. The hosted slice supports Google identity, database-backed sessions, device passkeys, organization membership, manually entered leads and proposal drafts, and a durable job that prepares an authorized proposal artifact. Legacy operational records and connector execution are not automatically migrated or activated.

The dedicated web Worker is `cpl-command-center`, with the reviewed origin `https://cpl-command-center.astarrett.workers.dev`. The separate `cpl-command-center-jobs` Worker has no public HTTP endpoint and claims at most one job every fifteen minutes. Both use restricted PostgreSQL roles; the jobs credential is distinct from the web credential. The web runtime receives `DATABASE_URL`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` through provider bindings. The scheduler receives only `CPL_WORKER_DATABASE_URL`. Migration/admin credentials never belong in either Worker.

Cloudflare CLI authorization, a dedicated free PostgreSQL project, and the Google OAuth client have been prepared. The client has the exact HTTPS origin and callback, only OpenID/email/profile scopes, and the owner as its sole test user; credentials remain outside source. PostgreSQL migration, restricted-role, tenant, queue, and disposable backup/restore checks have executed; their scope is recorded in [hosted test coverage](HOSTED_TEST_COVERAGE.md). Live owner sign-in and physical device verification remain NOT RUN. An adapter build or synthetic signed assertion does not satisfy them.

The release procedure is:

1. Review the allowlisted export and privacy findings, then commit through the full local pre-commit gate and publish the exact reviewed public source.
2. In that clean public checkout, install the frozen lockfile, verify the boundary and export manifest, and run the applicable local checks.
3. Run `node scripts/cloudflare-hosting.mjs build web`, then `dry-run web` and `dry-run jobs`. The tool records source and bundle hashes; source changes invalidate release evidence.
4. After the required account authorization, configure the least-privilege runtime bindings and deploy each Worker with `node scripts/cloudflare-hosting.mjs deploy <web|jobs> --commit <full-public-commit>`.
5. Read back the deployed commit, HTTPS origin, free-plan state, secret-binding names, scheduler configuration, and invocation outcomes. Complete real sign-in, device verification, persistence across sessions, tenant-denial checks, one durable job, authorized artifact handling, and recovery evidence against that same release.

The deployment tool rejects private checkout deployment, dirty source, unpublished commits, mismatched manifests, and stale build/dry-run evidence. Hosted Git builds and automatic deployments are not part of this path. The retained `infra/` templates describe earlier hosting arrangements and do not override the reviewed Cloudflare configuration.

## Remaining acceptance limits

Cloudflare's free CPU, memory, request and Cron limits must be verified with actual deployed invocations, especially authentication and PostgreSQL work. A local workerd test cannot prove the deployed free CPU budget. The fifteen-minute schedule also limits throughput to four claimed jobs per hour; database compute remains separately metered. No paid plan, R2 subscription, D1 substitution, or framework rewrite is authorized by this document.

The [hosting compatibility record](HOSTING_COMPATIBILITY.md) documents current limits and the `workers.dev` suitability boundary. A fictional acceptance deployment must not be described as business-critical hosting. Owner-operated Google sign-in, physical passkeys, deployed organization/lead/proposal behavior, and deployed runtime binding verification remain NOT RUN until their evidence is recorded. Customer sending, paid AI calls, billing activation, DNS changes, and legacy tenant migration remain outside this bounded release.
