# CPL tenant and runtime foundation

Status: IMPLEMENTED as an additive backend foundation. Customer onboarding and operational routes remain BLOCKED. This document does not establish production readiness.

## Runtime boundary

An empty environment selects production configuration and fails validation until secure settings are supplied. Supplying valid settings still cannot activate the legacy operational server or worker: both refuse startup before repository, database, queue, or provider access outside an explicit isolated test process. `NODE_ENV=production` cannot be weakened by the legacy runtime override.

Synthetic identities, fixture seeding, reset commands, AI providers, and integration providers require `NODE_ENV=test`. Direct authentication and provider use recheck this restriction. The old Preview profile is retained only as an isolated test fixture. Application AI activation remains blocked at the zero-budget checkpoint; saved credentials and connection-test records do not authorize reactivation. Reusable live provider implementations remain preserved.

The provisioning screen reports configuration status without constructing operational storage, exposing secret values, selecting a test persona, or seeding business records.

## Additive persistence

Migration `0025_cpl_tenant_foundation.sql` is registered after the preserved legacy migration chain. It creates identities, hashed and expiring sessions, organizations, memberships, single-use invitations, disabled-by-default module entitlements, versioned organization settings, short-lived worker grants, and tenant/platform audit records. It seeds no organization, identity, administrator, customer, project, or other business activity.

`SqlCplTenantRepository` verifies the server-side session and active organization membership for protected operations. Role checks and module checks occur in the repository. Tenant queries use explicit organization predicates, transaction-local context, composite membership references, and forced row-level-security policies. The eight organization-owned control tables have RLS enabled and forced. The database connection used in production must be a non-superuser without `BYPASSRLS`; real connection-role acceptance is NOT RUN.

Company and workflow settings are JSON records with optimistic version checks and durable audit events. The integration tests save different catalogs and proposal templates for two synthetic organizations and reject cross-organization access and stale/concurrent edits. This verifies configuration persistence, not adoption by the legacy commercial engine.

Invitations bind the exact identity-provider issuer and subject, expire, redeem once, and require an active inviter identity and administrator membership at redemption. Worker grants bind the organization, module, issuing identity, and membership version. Restoring a suspended or removed membership cannot revive an older grant. Each protected worker operation must revalidate current authorization; returned access objects and namespace strings are not bearer capabilities.

Namespace derivation separates object, vector, cache, job, export, and credential-reference identifiers by verified organization and a hashed resource identifier. Actual object storage, vector indexes, connectors, and legacy jobs have not been wired to this API.

## Authentication and administration limits

No default identity verifier is provided. Session creation fails closed until a supported identity-provider adapter validates the assertion's signature, issuer, audience, expiry, nonce, and authentication context. Browser-supplied claims cannot create sessions by themselves. A successful first organization signup grants only organization ownership.

Platform administrators must be separately provisioned. Module entitlement changes require an active platform administrator and recent MFA verified by the identity provider, and write an audit event. Public administrator enrollment, silent impersonation, hosted login, secure cookie/CSRF integration, and a working administration UI are not implemented by this foundation.

Usage limits persist and zero allowance blocks module execution. Consumption accounting, atomic usage reservation, billing periods, spend metering, and billing activation are DEFERRED. Positive allowance values must not be described as a completed metering system.

## Evidence and next boundary

Automated foundation tests use isolated PGlite persistence and a synthetic identity verifier. They cover empty provisioning, session revocation, identity and invitation rejection, independent memberships, role/module checks, distinct organization configuration, grant expiry and revocation, composite tenant references, and RLS under a non-bypass test role. This is Preview/test evidence, not production PostgreSQL parity or hosted authentication acceptance.

The existing business tables remain globally scoped. Keep legacy operational routes and workers blocked until their records, files, retrieval, jobs, logs, and connector credentials are migrated and tested through tenant boundaries. Follow with supported hosted authentication, secure session/CSRF integration, real PostgreSQL role verification, and a tenant-scoped intake-to-proposal path. No customer data migration or external provider activation is authorized by running these tests.
