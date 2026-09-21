# Cloudflare R2 template

The pilot object store uses the S3-compatible endpoint through `ObjectStorageProvider`. Keep buckets private, put tenant IDs in validated namespaces, store authoritative metadata and checksums in PostgreSQL, and issue short-lived operation-specific upload/download URLs.

The templates contain no Cloudflare account ID or credential. `cors.example.json` uses invalid example origins, keeps wildcard origins disabled, and exposes only checksum/ETag headers needed by verified direct transfers. Before activation, verify the exact S3 operations used by the selected SDK, replace CORS origins per environment, apply lifecycle policies, test deletion propagation and restore/export behavior, and keep access keys in the runtime `SecretProvider`.
