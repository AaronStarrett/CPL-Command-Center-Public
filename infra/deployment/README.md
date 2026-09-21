# Deployment contract

The examples describe two independent, warm Node processes and external provider dependencies. They deliberately contain no account IDs, project references, host tokens, database passwords, API keys, or OAuth secrets.

The current application still needs a separately authorized implementation phase for the selected AuthProvider and R2 adapters before this target can become a live hosted pilot. The templates validate image construction and architectural boundaries only; they do not establish a deployment or provider connection.

Container liveness and application readiness are deliberately distinct. The web image liveness probe uses `/sign-in`, and the worker image probes its own loopback `/health`. The richer web `/api/health` readiness route still assumes a loopback worker; a host adapter must add authenticated private service discovery before that route can attest the documented two-container topology. The manifest marks that readiness seam blocked instead of presenting a locally healthy web process as hosted-worker proof.

A host-specific release maps these fields into its native manifest, stores values marked `writeOnly` in encrypted runtime secrets, points the custom domain to the web service, and keeps the worker private. A migration to another host changes only that mapping and image destination.
