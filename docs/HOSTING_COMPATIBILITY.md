# Hosted runtime compatibility

The existing Next.js application is adapted with OpenNext; it is not replaced by a second application. The pinned adapter is `@opennextjs/cloudflare@1.20.6` with `wrangler@4.136.1`. Its published peer dependency requires Next.js `>=16.3.3`; this release uses the `16.3.5` patch and matching ESLint configuration. Do not use the adapter's unsupported-version override.

## Runtime contracts

- `cpl-command-center` serves the existing Next.js app and server routes. `DATABASE_URL` belongs to the registered, non-bypass web runtime role. Authenticated responses are dynamic and private; PostgreSQL remains the durable store.
- `cpl-command-center-jobs` processes at most one durable job every fifteen minutes. Its separate `CPL_WORKER_DATABASE_URL` belongs to the narrowly scoped scheduler role. Each invocation opens a one-connection pool, claims with a lease, validates the job's tenant authorization, records a fenced result, and closes the pool. HTTP requests cannot trigger jobs. This latency allows an idle database to suspend between polls; interactive traffic and queued work still consume the database's separate free compute quota.
- The two Workers share no credential binding. Neither runs a permanent process. No OpenAI call, customer message, R2 bucket, D1 database, Durable Object, paid queue, or storage subscription is needed for the manual acceptance slice.
- Downloadable artifacts are generated from authorized persisted proposal content for the current response. A successful download is not a durable artifact archive. Workers' `/tmp` storage is request-local and must never hold the only copy of customer data.
- Build-time public assets use the adapter's read-only Static Assets cache. No ISR, tenant query cache, or Hyperdrive query cache is configured.

The custom Worker entry reuses the existing released auth and CPL route functions after the shared deployment gate. It does not implement a second authentication or tenant layer. Ordinary workspace documents use the exact Next prerendered HTML, checked against its cache bytes during the build; React Server Component requests remain with OpenNext. Direct responses preserve security headers and separate cookies while removing Next's internal middleware cookie mirror. All other allowed requests retain the generated OpenNext handler.

## Local adapter verification

Use the verified Node 24.19.0 executable and the frozen dependencies. Every command validates the checkout boundary and keeps tool configuration, temporary files, generated bundles, and evidence on the authorized SSD.

```text
node scripts/cloudflare-hosting.mjs build web
node scripts/cloudflare-hosting.mjs dry-run web
node scripts/cloudflare-hosting.mjs dry-run jobs
node scripts/cloudflare-hosting.mjs preview web
node scripts/cloudflare-hosting.mjs preview jobs
```

The preview commands use workerd on loopback ports 3401 and 3402. The jobs preview supports Wrangler's local scheduled-event testing. A preview is not a public deployment or real PostgreSQL acceptance. Build and dry-run evidence under `.data/hosting/` records the source fingerprint and generated-output hash; source changes invalidate it. An ordinary `next build` does not establish adapter compatibility.

The hosting tool does not inherit application credentials for builds. Runtime secrets must be separately configured through an authorized provider session. Keep migration/admin credentials outside both deployed Workers. Do not commit `.dev.vars`, `.env`, credentials, generated `.open-next` files, or Wrangler state.

After preparing the read-only static cache, the hosted build collects emitted webpack resources and local Wrangler web/scheduler bundle metadata. It generates `THIRD_PARTY_NOTICES.txt` and its hash inventory in the public static assets, preserving original upstream notices. Next's full embedded-notice set is a labelled conservative supplement because its prebundled server runtime conceals individual module provenance. Version-pinned upstream supplements cover notices omitted from npm artifacts; an unreviewed missing notice stops the build. This artifact identifies distribution provenance and does not claim every installed build tool ships or grant a license to CPL source. The final public build and dry-run must include and review these generated notices before deployment.

## Exact public deployment

Build and dry-run from the clean reviewed public export after its commit is published. The deployment command verifies the public repository identity, origin, current commit, advertised public `main`, export manifest, and matching build/bundle evidence. It rejects private checkout deployment and unpublished modifications.

```text
node scripts/cloudflare-hosting.mjs deploy web --commit <full-public-commit>
node scripts/cloudflare-hosting.mjs deploy jobs --commit <same-full-public-commit>
```

`CPL_PUBLIC_COMMIT` records that revision in each deployed Worker. Do not connect hosted Git builds or create resources without the applicable account authorization. GitHub Actions and automatic Dependabot update jobs remain disabled.

## Free-plan constraints and acceptance

Cloudflare's current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) specify 100,000 requests per day, 10 ms CPU per HTTP or Cron invocation, 128 MB memory, a 64 MiB uncompressed bundle, and five Cron Triggers per free account. There is no compressed bundle-size cap in the current documentation. Network wait time does not count as CPU. The 10 ms budget can constrain authentication, rendering, and artifact generation; a successful local build cannot establish that those operations fit it.

Actual invocations of published commit `30bb0ef` on September 21 exceeded the Free CPU budget: several anonymous API rejections used 26–60 ms and the observed Google callback used 563 ms. These requests had invocation outcome `ok`; occasional platform tolerance is not proof of sustained suitability. The custom dispatcher is a subsequent compatibility correction with focused and local workerd evidence. Its deployed CPU acceptance remains NOT RUN until the reviewed correction is published, deployed, and measured.

Measure upload size using the Wrangler dry-run output, and inspect invocation CPU/outcomes after an authorized deployment. Do not enable a paid plan, attach billing, or raise paid CPU limits to hide a failure. Capture free-plan identity, public HTTPS URL, exact commit, real sign-in, PostgreSQL writes/readbacks across sessions, cross-tenant rejection, a real scheduled job, artifact handling, and rollback/recovery evidence before calling the hosted workflow verified.

Use the existing signed-in dashboard's [Workers Logs Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/) for per-invocation `$workers.cpuTimeMs`, outcome, and wall time, filtered to the two release Workers and the acceptance time window. Retain only those measurements and timestamps; exclude request headers, cookies, OAuth codes, and customer payloads. Ordinary `wrangler tail` output and client elapsed time do not establish CPU consumption. The [telemetry query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/) currently requires the separate `Workers Observability Write` permission, while GraphQL analytics requires `Account Analytics Read`; neither should be assumed from the deployment/tail OAuth scopes. No additional token grant or paid Tail Worker is needed to read the measurements through the existing dashboard session.

The [self-serve agreement](https://www.cloudflare.com/terms/) covers use by companies and their end users; it does not make this a paid or unlimited service. Its free-service restriction on collecting or processing credit-card information excludes payment collection from this slice. Cloudflare also [recommends a route or custom domain for production](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) and describes `workers.dev` as intended for personal/hobby use that is not business-critical. An acceptance deployment on `workers.dev` must not be presented as business-critical hosting. A domain change remains a separate owner-authorized action. Free services can be limited or suspended under the [developer-platform terms](https://www.cloudflare.com/service-specific-terms-developer-platform/).

The Google OAuth client is prepared with the exact HTTPS origin/callback, OpenID/email/profile scopes, and the owner as the sole test user. Provider credentials remain outside source. Client configuration does not establish successful live sign-in or physical passkey verification.

Official references: [OpenNext setup](https://opennext.js.org/cloudflare/get-started), [adapter caching](https://opennext.js.org/cloudflare/caching), [Node API compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/), [ephemeral filesystem](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/), and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/). The checked-in adapter is implementation, not evidence that deployment or production acceptance has happened.
