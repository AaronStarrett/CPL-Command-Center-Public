# Contributing

This repository is a reviewed public snapshot of the canonical CPL Command Center source. Keep implementation changes in the canonical development checkout and publish through its reviewed export workflow so the public and private implementations do not diverge. Public issue reports may describe reproducible behavior without customer data or credentials.

Use conventional commits and focused changes. Run the boundary guard, source-integrity check, formatting, lint, typecheck, relevant tests, secret scan, and file-inventory check. Install and use `pnpm precommit:verify` through the repository hook. Never use `--no-verify` or skip flags. Hosted Actions and deployment remain disabled; provider calls and customer actions require separate authorization.

The source remains `UNLICENSED`. Contribution does not grant authority to deploy, activate billing, connect a provider, or contact a third party.
