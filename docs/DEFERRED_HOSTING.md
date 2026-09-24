# Deferred hosting track

Owner priority, September 23, 2026: build the product. Phase 5 is **IMPLEMENTED**, with local workflow/build/persistence verification **PASS** and final post-restart browser readback **PASS**. Production hosting acceptance is not a feature-development gate. See the [Phase 5 guide](LOCAL_PHASE5_TESTING.md) and [feature map](PRODUCT_FEATURE_MAP.md) for the current local scope.

Preserve the existing `cpl-command-center` and `cpl-command-center-jobs` Workers, Neon environment, Google configuration, jobs schedule, trigger settings and SSD recovery material during this milestone. The existing workers.dev workspace is a separate development checkpoint. No new cloud resource, hosted database, paid host, billing activation, official domain or DNS change is part of this scope. Authorized isolated local recovery and test databases are separate from hosting.

Deferred until the owner changes this priority:

- Hyperdrive and connection changes.
- Cloudflare Free CPU fit and repeated telemetry investigation.
- Hosting cleanup, cron/capacity optimization, cost optimization beyond avoiding new charges.
- Final hosting architecture, production load/capacity tests, SLA and domain cutover.
- Production Google/passkey owner-device acceptance remains an independent acceptance item.

The Phase 5 instruction excludes deploying this milestone, including a routine preview deployment. Phase 5 source publication is **BLOCKED / NOT PUBLISHED** pending confirmation that a repository push cannot trigger an external deployment; private allowlist/hash review can proceed independently. The public Phase 4 reference remains `cd9184c6075854b30b1d6dca00a609ca5f085945`. Source publication does not authorize a hosted build, schedule change or infrastructure change. Earlier preview-deployment instructions are historical and do not authorize a Phase 5 deployment. These are current scope limits, not a permanent ban on future owner-authorized hosting work.

No infrastructure deletion, new provisioning or optimization was performed for the local product-build milestone. Local testing uses a dedicated synthetic PostgreSQL database on the verified SSD; it does not use Neon/customer records.
