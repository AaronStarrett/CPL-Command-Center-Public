# Public source and deployment boundary

Current scope: Phase 5 is recoverably checkpointed at `864c0b0f022b642d08476b9546829b1e2db0dd75`. Phase 6A–6B company integration management and reliable inbound intake are **IMPLEMENTED**. The [feature map](PRODUCT_FEATURE_MAP.md), [Phase 6 testing guide](LOCAL_PHASE6_INTAKE_TESTING.md) and [handoff](PHASE6_HANDOFF.md) distinguish bounded verification, current source publication status and unfinished acceptance. Production hosting and live Gmail acceptance are **DEFERRED**. Publishing a source milestone does not deploy it, activate a service or establish that the hosted checkpoint supports the current product.

The local workspace connects tenant-scoped intake, commercial proposals and projects, visits, field evidence, reviewed reports, internal recipes and actions, delivery packages and configurable readiness. Phase 5 adds company administration, setup, catalog/intake configuration, shared directories and company audit views. Local DEVELOPMENT uses explicit synthetic identities with real PostgreSQL authorization and persistence. Use fictional records. Invitation records do not send email; customer portals, external sending, accounting execution and paid AI are not activated.

## Reviewed source publication

The canonical development checkout exports reviewed application source to `AaronStarrett/CPL-Command-Center-Public`, repository ID `1380072423`. Public history remains independent. Never merge private history into the public repository or include private records, uploads, generated customer artifacts, credentials, logs or local database files.

The source-only procedure is:

1. Finish the applicable local checks and preservation/readback evidence. Review the current documentation and allowlisted plan, including each source/output hash, privacy findings and dependency inventory. Refresh the external deployment-linkage check before public mutation: GitHub-native settings alone do not prove that a provider's repository connection cannot deploy on push. Inspect native Cloudflare Git builds/branch rules, repository automation and hooks through existing read-only access. If linkage remains unknown, retain local checkpoints and report publication BLOCKED. A private export plan is preparation only.
2. Refresh the existing public candidate through `scripts/publication-export.mjs` using that exact reviewed plan. Verify the resulting manifest; source drift requires a new review.
3. Install the frozen lockfile in the public checkout when dependencies change. Verify its repository boundary, source integrity, secret scan, inventory and applicable application tests. Preserve separate real-database, browser and restart evidence; mocked tests do not replace it.
4. Commit the exact reviewed index through the installed full local pre-commit gate. Review the committed manifest, independent public history and remote cost controls before a normal forward push.
5. Read back the public repository and exact commit without credentials. Confirm the manifest bytes and all published blob identities match the reviewed snapshot, and recheck disabled automation.

No hosted build, cloud deployment, runtime secret update, database migration, schedule change, DNS change or new resource is part of these publication steps. Preserve and read back the existing disabled GitHub Actions and security-update automation, plus zero open-PR limits and disabled Dependabot rebasing in both configured ecosystems. These are separate controls because [Dependabot jobs bypass Actions disablement](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-on-actions). No trigger-setting change is authorized to make a publication check pass; a changed setting requires a new review. Future owner instructions may establish a different hosting or automation scope.

## Local setup boundary

The [opening guide](../OPEN-CPL-COMMAND-CENTER.md) describes the DEVELOPMENT launchers, pinned Node 24.19.0/pnpm 11.19.0 tooling and separately prepared portable PostgreSQL 16.15. All controlled files stay on the approved SSD. Installation uses `node scripts/cpl-install.mjs`; startup does not install dependencies.

The public checkout has a different repository identity and path from the canonical development checkout. Its launcher refuses the canonical database's ownership marker. Publishing source neither copies that database nor authorizes changing its ownership, credentials or runtime. Do not delete the marker or point the public checkout at the owner's existing data. A fresh source clone also does not contain the synthetic walkthrough records, field uploads or approved PDFs mentioned in historical local acceptance guides.

## Preserved hosted work

The existing Next.js/OpenNext adapter, dedicated web and jobs Worker source, Google identity/passkey implementation and restricted database-role contracts remain available for a future separately authorized hosting milestone. The existing [hosted development checkpoint](https://cpl-command-center.astarrett.workers.dev/workspace) is a separate release, not the local DEVELOPMENT session or a production acceptance claim.

Earlier hosted work includes both failed attempts and subsequent Google sign-in evidence. The former `30bb0ef` callback failure and early NOT RUN statuses are historical, not the current result of every later release. Those records also do not establish current device/passkey acceptance, complete tenant workflow acceptance or Cloudflare Free CPU fit. Historical [hosting compatibility](HOSTING_COMPATIBILITY.md) and [test coverage](HOSTED_TEST_COVERAGE.md) records retain their original scope; local feature verification does not erase their limitations.

The Phase 6 instruction preserves existing Workers, Neon, Google configuration, schedules and trigger settings without deploying this milestone or performing hosting cleanup. Hyperdrive, runtime optimization, production load/capacity work, billing activation and domain cutover remain [DEFERRED](DEFERRED_HOSTING.md). Any future deployment must be separately authorized and bind fresh build/runtime evidence to an exact reviewed public commit; retained deployment tooling and infrastructure examples do not grant that authorization.
