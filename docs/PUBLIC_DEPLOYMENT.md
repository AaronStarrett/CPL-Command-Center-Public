# Public source and deployment boundary

Status: ARCHITECTURE DEFINED. Cloud deployment and automatic deployment connection: NOT RUN.

The development checkout exports reviewed application source to `AaronStarrett/CPL-Command-Center-Public`. The public repository has independent history. A release must use a specific public commit and its `PUBLIC_EXPORT_MANIFEST.json`; never deploy a private branch or merge private history into the public repository. GitHub Actions remain disabled.

The preserved application uses a Next.js Node web/API process, a separate Node worker, PostgreSQL, and provider interfaces. The repository's existing container and deployment contracts remain in `infra/`. They are configuration templates, not an implemented hosting adapter. No native Git deployment connection, host project, deployment credential, or installed hosting CLI has been verified for this release.

Deployment is BLOCKED by the absent hosted identity-provider adapter, tenant migration of legacy operational records, real PostgreSQL role/queue/restore acceptance, and the missing host-specific deployment adapter. The production entry gate deliberately exposes only empty setup and rejects customer operations. Publishing a development release does not satisfy these gates.

The earlier two-warm-service Railway topology is not a verified zero-cost production arrangement. Railway's documented Free plan provides a limited monthly resource credit; that does not prove this web/worker/database topology fits it. Cloudflare Workers remains a compatibility goal, but this application has no reviewed Workers deployment adapter. Do not change runtimes or activate billing to hide that gap.

Before any future deployment, verify the selected free-compatible host and its spend controls, resolve the operational gates, clone the exact public commit without private history, install the frozen lockfile, run the local verification gate and production build, and record the commit in the host deployment metadata. A successful deployment must read back that commit, application URL, health evidence, and private-service configuration. No automatic deployment may be claimed before that readback.

No service, paid runner, billing plan, live provider test, DNS change, or phone routing change is activated by this source release.

References checked 2026-09-21: [Railway plans](https://docs.railway.com/pricing/plans), [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
