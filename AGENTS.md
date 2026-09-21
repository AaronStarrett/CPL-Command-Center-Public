# CPL Command Center public source rules

This is a sanitized publication of the canonical CPL implementation. Do not fetch, merge, or copy private repository history into this repository. Changes to application behavior originate in the canonical source and are exported through its reviewed publication workflow. Keep the exported source and tests coherent.

Run `node scripts/repository-boundary.mjs` before mutation and final verification. The public identity marker, exact public Git origin, Git metadata, resolved path, and explicit checkout allowlist must all match. Never bypass the guard with CI or an arbitrary root variable. Do not enter the unrelated internal CPL repository.

Keep credentials, runtime data, customer data, private review records, and supplied customer assets out of Git. Preserve the exported CPL asset bytes. Run focused tests plus formatting, lint, type checking, source-integrity, secret, and inventory checks before commits. Install the local pre-commit hook; never bypass it with `--no-verify` or skip flags. Do not label skipped checks as passes.

Keep GitHub Actions parked and remote Actions disabled. No deployment, paid provider request, provisioning, live billing, customer communication, or autonomous connector execution is authorized by this source publication. PGlite and deterministic providers provide Preview/test evidence only.

Preserve all third-party notices and the existing `UNLICENSED` package declaration. Do not invent a source license or grant rights to the CPL mark.
