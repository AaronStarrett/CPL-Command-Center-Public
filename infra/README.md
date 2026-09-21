# Provider-neutral deployment scaffolding

This directory contains architecture-only templates for Phase 1.3.5. Nothing here provisions a service. The initial recommendation is Railway containers with Supabase PostgreSQL and Cloudflare R2, but the release unit remains an OCI-compatible web image plus an OCI-compatible worker image.

- `docker/` builds the current web and worker processes.
- `deployment/` defines portable service, health, and environment contracts.
- `supabase/` records PostgreSQL/pgvector pilot templates without moving domain logic into Supabase.
- `r2/` records an S3-compatible object-storage configuration shape without credentials.

Azure is not required. Azure Container Apps, Azure PostgreSQL, Blob Storage, Key Vault, and Entra may be implemented later only behind the provider contracts in `packages/platform`.
