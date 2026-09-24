/** Server composition ports. Never accepted from HTTP bodies or persisted in DTOs. */
export type CplProviderOperation =
  | "authorize"
  | "exchange"
  | "jwks"
  | "refresh"
  | "profile"
  | "labels"
  | "messages.list"
  | "messages.get"
  | "history.list"
  | "revoke";
export type CplProviderGuard = (operation: CplProviderOperation) => Promise<void>;
export type CplIntegrationSecretContext = {
  purpose: "gmail_tokens" | "signed_intake_key" | "oauth_attempt";
  organizationId: string;
  sourceId: string;
  credentialRevision: number;
};
export type CplIntegrationSecretEnvelope = {
  algorithm: "AES-256-GCM";
  keyVersion: string;
  nonce: string;
  ciphertext: string;
  tag: string;
};
export type CplGmailAccount = {
  issuer: "https://accounts.google.com";
  subject: string;
  email: string;
};
export type CplGmailTokens = {
  accessToken: string;
  expiresAt: string;
  refreshToken?: string;
  scopes: string[];
};
export type CplGmailPage = {
  messageIds: string[];
  nextPageToken: string | null;
  historyId: string | null;
};
export type CplGmailHistoryPage = CplGmailPage & {
  changes: {
    messageId: string;
    historyId: string;
    kind: "message_added" | "label_added" | "message_deleted" | "label_removed";
  }[];
};
export type CplGmailMessage = {
  id: string;
  threadId: string;
  historyId: string;
  internalDate: string;
  labelIds: string[];
  original: Uint8Array;
  originalMediaType: "application/json";
  contentSha256: string;
  subject: string;
  senderNameClaim: string;
  senderEmailClaim: string;
  plainText: string | null;
  attachments: {
    id: string | null;
    name: string;
    mediaType: string;
    bytes: number;
    status: "not_ingested" | "unavailable";
  }[];
  parseIssues?: string[];
};
export interface CplGoogleGmailAdapter {
  authorizationUrl(input: {
    state: string;
    nonce: string;
    verifier: string;
    redirectUri: string;
  }): Promise<string>;
  exchangeCode(input: {
    code: string;
    verifier: string;
    nonce: string;
    redirectUri: string;
  }): Promise<{ account: CplGmailAccount; tokens: CplGmailTokens }>;
  refresh(input: { refreshToken: string; priorScopes: string[] }): Promise<CplGmailTokens>;
  listLabels(input: { accessToken: string }): Promise<{ id: string; name: string }[]>;
  profile(input: { accessToken: string }): Promise<{ email: string; historyId: string }>;
  listMessages(input: {
    accessToken: string;
    labelId: string;
    after: string;
    pageToken?: string;
    limit: number;
  }): Promise<CplGmailPage>;
  listHistory(input: {
    accessToken: string;
    labelId: string;
    startHistoryId: string;
    pageToken?: string;
    limit: number;
  }): Promise<CplGmailHistoryPage>;
  getMessage(input: { accessToken: string; messageId: string }): Promise<CplGmailMessage>;
  revoke(input: { token: string; projectGrantRevocationConfirmed: true }): Promise<void>;
}
export interface CplIntegrationSecretBox {
  seal(input: {
    plaintext: Uint8Array;
    context: CplIntegrationSecretContext;
    keyVersion: string;
  }): Promise<CplIntegrationSecretEnvelope>;
  open(input: {
    envelope: CplIntegrationSecretEnvelope;
    context: CplIntegrationSecretContext;
  }): Promise<Uint8Array>;
}
export type CplSignedSubmissionMaterial = {
  method: "POST";
  publicId: string;
  keyId: string;
  keyGeneration: number;
  timestamp: string;
  nonce: string;
  rawBody: Uint8Array;
};
export interface CplSignedSubmissionCrypto {
  verify(
    input: CplSignedSubmissionMaterial & { key: Uint8Array; signature: string; now: Date },
  ): Promise<{ bodySha256: string; timestampSeconds: number }>;
}
export interface CplIntegrationRepositoryOptions {
  /** Missing configuration is disabled; only the trusted runtime selects a mode. */
  providerMode?: "disabled" | "local_fixture" | "live";
  keyVersion?: string;
  redirectUri?: string;
  secretBox?: CplIntegrationSecretBox;
  signedSubmissions?: CplSignedSubmissionCrypto;
  createGmailAdapter?: (input: {
    organizationId: string;
    connectionId: string;
    assertCurrent: CplProviderGuard;
    signal: AbortSignal;
  }) => CplGoogleGmailAdapter | Promise<CplGoogleGmailAdapter>;
}
