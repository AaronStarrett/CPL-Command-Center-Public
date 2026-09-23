/** Hosted-only entry point. Keep legacy/demo/local-owner adapters out of this graph. */
export * from "./hosted-authentication-contracts.js";
export * from "./google-oidc.js";
export * from "./hosted-authentication.js";
export * from "./local-development-auth.js";
export type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
