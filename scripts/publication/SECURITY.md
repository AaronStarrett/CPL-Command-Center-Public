# Security policy

Report vulnerabilities privately to repository owner `AaronStarrett` through an established private channel or a private GitHub security advisory when available. Do not place credentials, customer data, recovery codes, certificates, or exploit details in public issues or pull requests. No guaranteed response SLA is published.

This source checkpoint is not approved for production deployment. PGlite and deterministic providers are Preview/test evidence. Authentication, tenant boundaries, connectors, external execution, storage, and operational recovery each require their own acceptance evidence.

Keep all credentials and customer/runtime records outside Git. Secrets belong only in backend secret storage. Do not put them in browser code, logs, screenshots, or generated reports. Revoke and rotate any credential suspected of exposure through the relevant provider before publishing remediation details.
