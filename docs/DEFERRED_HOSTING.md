# Deferred hosting track

Owner priority, September 23, 2026: build the product. Production hosting acceptance is not a feature-development gate.

Preserve the existing `cpl-command-center` and `cpl-command-center-jobs` Workers, Neon environment, Google configuration, jobs schedule and SSD recovery material. The existing workers.dev workspace is a development checkpoint. No new cloud resource, database, paid host, billing activation, official domain or DNS change is part of this milestone.

Deferred until the owner changes this priority:

- Hyperdrive and connection changes.
- Cloudflare Free CPU fit and repeated telemetry investigation.
- Hosting cleanup, cron/capacity optimization, cost optimization beyond avoiding new charges.
- Final hosting architecture, production load/capacity tests, SLA and domain cutover.
- Production Google/passkey owner-device acceptance remains an independent acceptance item.

The Phase 4 instruction explicitly excludes deploying this milestone, including a routine preview deployment. Reviewed source publication may proceed independently; it does not run a hosted build, deploy code, alter a schedule or change infrastructure. Earlier preview-deployment instructions are historical and do not authorize a Phase 4 deployment. Future hosting work requires a separate owner instruction; preserve the existing hosted resources while product development continues locally.

No infrastructure deletion, new provisioning or optimization was performed for the local product-build milestone. Local testing uses a dedicated synthetic PostgreSQL database on the verified SSD; it does not use Neon/customer records.
