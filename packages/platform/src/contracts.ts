import type { EntityId, IsoDateTime, JsonObject, JsonValue } from "@bea/domain";

export type ProviderEnvironment = "development" | "preview" | "staging" | "production";
export type ProviderHealthStatus = "healthy" | "degraded" | "unavailable";
export type ProviderConnectionStatus =
  "not-configured" | "configured-not-tested" | "connected" | "degraded" | "failed" | "disabled";
export type ProviderEvidenceKind = "configuration" | "simulated" | "live";

export interface TenantOperationContext {
  readonly tenantId: EntityId;
  readonly actorId: EntityId;
  readonly correlationId: string;
  readonly environment: ProviderEnvironment;
}

interface ProviderHealthBase {
  readonly status: ProviderHealthStatus;
  readonly checkedAt: IsoDateTime;
  readonly detail: string | null;
  readonly evidenceReferences: readonly string[];
}

type NonConnectedProviderStatus = Exclude<ProviderConnectionStatus, "connected">;

export type ProviderHealth =
  | (ProviderHealthBase & {
      readonly connectionStatus: "connected";
      readonly evidenceKind: "live";
      readonly simulated: false;
    })
  | (ProviderHealthBase & {
      readonly connectionStatus: NonConnectedProviderStatus;
      readonly evidenceKind: "simulated";
      readonly simulated: true;
    })
  | (ProviderHealthBase & {
      readonly connectionStatus: NonConnectedProviderStatus;
      readonly evidenceKind: "configuration" | "live";
      readonly simulated: false;
    });

export interface TenantScopedResource {
  readonly tenantId: EntityId;
}

export function assertTenantScope(
  context: Pick<TenantOperationContext, "tenantId">,
  resource: TenantScopedResource,
): void {
  if (context.tenantId !== resource.tenantId) {
    throw new Error("CROSS_TENANT_PROVIDER_OPERATION_BLOCKED");
  }
}

export interface ProviderDescriptor {
  readonly providerId: string;
  readonly displayName: string;
  readonly portableProtocol: string;
  readonly environment: ProviderEnvironment;
}

export interface DatabaseResult<Row extends JsonObject = JsonObject> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface DatabaseSession {
  readonly tenantId: EntityId;
  query<Row extends JsonObject = JsonObject>(
    statement: string,
    parameters?: readonly JsonValue[],
  ): Promise<DatabaseResult<Row>>;
}

export interface DatabaseProvider {
  readonly descriptor: ProviderDescriptor;
  health(): Promise<ProviderHealth>;
  connect(context: TenantOperationContext): Promise<DatabaseSession>;
  transaction<Result>(
    context: TenantOperationContext,
    operation: (session: DatabaseSession) => Promise<Result>,
  ): Promise<Result>;
  close(): Promise<void>;
}

export interface AuthenticatedPrincipal {
  readonly providerSubject: string;
  readonly applicationUserId: EntityId;
  readonly tenantId: EntityId;
  readonly roles: readonly string[];
  readonly authenticatedAt: IsoDateTime;
}

export interface AuthChallenge {
  readonly authorizationUrl: string;
  readonly stateReference: string;
  readonly expiresAt: IsoDateTime;
}

export interface AuthProvider {
  readonly descriptor: ProviderDescriptor;
  beginAuthentication(input: {
    readonly tenantId: EntityId;
    readonly redirectUri: string;
    readonly stateReference: string;
  }): Promise<AuthChallenge>;
  completeAuthentication(input: {
    readonly tenantId: EntityId;
    readonly redirectUri: string;
    readonly stateReference: string;
    readonly authorizationCode: string;
  }): Promise<AuthenticatedPrincipal>;
  verifyAccessToken(token: string): Promise<AuthenticatedPrincipal>;
  refreshSession(
    context: TenantOperationContext,
    refreshReference: string,
  ): Promise<AuthenticatedPrincipal>;
  getPrincipal(
    context: TenantOperationContext,
    providerSubject: string,
  ): Promise<AuthenticatedPrincipal | null>;
  createInvitation(
    context: GovernedWriteContext,
    email: string,
    roleKeys: readonly string[],
  ): Promise<{ readonly invitationId: string; readonly expiresAt: IsoDateTime }>;
  updateAccount(
    context: GovernedWriteContext,
    providerSubject: string,
    patch: JsonObject,
  ): Promise<AuthenticatedPrincipal>;
  disableAccount(context: GovernedWriteContext, providerSubject: string): Promise<void>;
  linkFederatedIdentity(
    context: GovernedWriteContext,
    providerSubject: string,
    externalProvider: string,
    externalSubject: string,
  ): Promise<void>;
  revokeSession(context: TenantOperationContext, sessionId: string): Promise<void>;
  health(): Promise<ProviderHealth>;
}

export interface ObjectLocator {
  readonly tenantId: EntityId;
  readonly namespace: string;
  readonly objectKey: string;
}

export interface ObjectMetadata extends ObjectLocator {
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly checksumSha256: string;
  readonly version: string | null;
  readonly createdAt: IsoDateTime;
  readonly retentionClass: string;
}

export interface ObjectWriteRequest extends ObjectLocator {
  readonly contentType: string;
  readonly checksumSha256: string;
  readonly retentionClass: string;
  readonly expiresAt: IsoDateTime | null;
}

export interface ObjectStorageProvider {
  readonly descriptor: ProviderDescriptor;
  put(
    context: TenantOperationContext,
    request: ObjectWriteRequest,
    content: ReadableStream<Uint8Array>,
  ): Promise<ObjectMetadata>;
  head(context: TenantOperationContext, locator: ObjectLocator): Promise<ObjectMetadata | null>;
  get(context: TenantOperationContext, locator: ObjectLocator): Promise<ReadableStream<Uint8Array>>;
  createUploadUrl(
    context: TenantOperationContext,
    request: ObjectWriteRequest,
    expiresInSeconds: number,
  ): Promise<string>;
  createDownloadUrl(
    context: TenantOperationContext,
    locator: ObjectLocator,
    expiresInSeconds: number,
  ): Promise<string>;
  delete(context: TenantOperationContext, locator: ObjectLocator): Promise<void>;
  health(): Promise<ProviderHealth>;
}

export interface SecretReference {
  readonly tenantId: EntityId;
  readonly providerKey: string;
  readonly secretId: string;
  readonly version: string | null;
}

export interface OpaqueSecretLease {
  readonly reference: SecretReference;
  readonly expiresAt: IsoDateTime;
  use<Result>(operation: (secretValue: string) => Promise<Result>): Promise<Result>;
}

export interface SecretProvider {
  readonly descriptor: ProviderDescriptor;
  lease(context: TenantOperationContext, reference: SecretReference): Promise<OpaqueSecretLease>;
  rotate(context: TenantOperationContext, reference: SecretReference): Promise<SecretReference>;
  revoke(context: TenantOperationContext, reference: SecretReference): Promise<void>;
  health(): Promise<ProviderHealth>;
}

export interface GovernedWriteContext {
  readonly operation: TenantOperationContext;
  readonly authorizationDecisionId: EntityId;
  readonly executionPolicy: "AUTOMATIC" | "PREVIEW" | "CONFIRM";
  readonly approvalReference: string | null;
  readonly idempotencyKey: string;
  readonly emergencyStopVersion: number;
}

export type KnowledgeCapability =
  "read" | "create" | "update" | "delete" | "export" | "permissions" | "revisions" | "changes";

export interface KnowledgeItemReference {
  readonly tenantId: EntityId;
  readonly connectionId: EntityId;
  readonly providerItemId: string;
  readonly revisionId: string | null;
}

export interface KnowledgeItemMetadata extends KnowledgeItemReference {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
  readonly checksumSha256: string | null;
  readonly ownerReferences: readonly string[];
  readonly permissionFingerprint: string;
  readonly modifiedAt: IsoDateTime;
  readonly deleted: boolean;
}

export interface KnowledgeChangePage {
  readonly items: readonly KnowledgeItemMetadata[];
  readonly nextCursor: string | null;
}

export interface KnowledgeQueryPage {
  readonly items: readonly KnowledgeItemMetadata[];
  readonly nextCursor: string | null;
}

export interface KnowledgePermission {
  readonly permissionId: string;
  readonly principalType: "user" | "group" | "domain" | "public";
  readonly principalReference: string | null;
  readonly role: string;
  readonly inherited: boolean;
}

export interface KnowledgeSourceProvider {
  readonly descriptor: ProviderDescriptor;
  readonly capabilities: readonly KnowledgeCapability[];
  listChanges(
    context: TenantOperationContext,
    connectionId: EntityId,
    cursor: string | null,
  ): Promise<KnowledgeChangePage>;
  list(
    context: TenantOperationContext,
    connectionId: EntityId,
    parent: KnowledgeItemReference | null,
    cursor: string | null,
  ): Promise<KnowledgeQueryPage>;
  search(
    context: TenantOperationContext,
    connectionId: EntityId,
    query: string,
    cursor: string | null,
  ): Promise<KnowledgeQueryPage>;
  getMetadata(
    context: TenantOperationContext,
    reference: KnowledgeItemReference,
  ): Promise<KnowledgeItemMetadata | null>;
  read(
    context: TenantOperationContext,
    reference: KnowledgeItemReference,
  ): Promise<ReadableStream<Uint8Array>>;
  export(
    context: TenantOperationContext,
    reference: KnowledgeItemReference,
    targetMimeType: string,
  ): Promise<ReadableStream<Uint8Array>>;
  write(
    context: GovernedWriteContext,
    metadata: KnowledgeItemMetadata,
    content: ReadableStream<Uint8Array>,
  ): Promise<KnowledgeItemMetadata>;
  delete(context: GovernedWriteContext, reference: KnowledgeItemReference): Promise<void>;
  copy(
    context: GovernedWriteContext,
    reference: KnowledgeItemReference,
    destinationParent: KnowledgeItemReference,
    newName: string | null,
  ): Promise<KnowledgeItemMetadata>;
  move(
    context: GovernedWriteContext,
    reference: KnowledgeItemReference,
    destinationParent: KnowledgeItemReference,
  ): Promise<KnowledgeItemMetadata>;
  listPermissions(
    context: TenantOperationContext,
    reference: KnowledgeItemReference,
  ): Promise<readonly KnowledgePermission[]>;
  setPermissions(
    context: GovernedWriteContext,
    reference: KnowledgeItemReference,
    permissions: readonly KnowledgePermission[],
  ): Promise<readonly KnowledgePermission[]>;
  listRevisions(
    context: TenantOperationContext,
    reference: KnowledgeItemReference,
  ): Promise<readonly KnowledgeItemReference[]>;
  revalidateAccess(
    context: TenantOperationContext,
    reference: KnowledgeItemReference,
  ): Promise<boolean>;
  health(): Promise<ProviderHealth>;
}

export interface VectorRecord {
  readonly tenantId: EntityId;
  readonly memoryId: EntityId;
  readonly sourceReference: string;
  readonly scope: string;
  readonly embeddingModel: string;
  readonly embeddingVersion: string;
  readonly vector: readonly number[];
  readonly metadata: JsonObject;
}

export interface VectorMatch {
  readonly memoryId: EntityId;
  readonly score: number;
  readonly sourceReference: string;
  readonly metadata: JsonObject;
}

export interface VectorMemoryProvider {
  readonly descriptor: ProviderDescriptor;
  upsert(context: TenantOperationContext, records: readonly VectorRecord[]): Promise<void>;
  search(
    context: TenantOperationContext,
    input: {
      readonly vector: readonly number[];
      readonly scope: string;
      readonly limit: number;
      readonly minimumScore: number;
    },
  ): Promise<readonly VectorMatch[]>;
  deleteBySource(context: TenantOperationContext, sourceReference: string): Promise<number>;
  reindex(context: TenantOperationContext, memoryIds: readonly EntityId[]): Promise<void>;
  health(): Promise<ProviderHealth>;
}

export interface QueueMessage<Payload extends JsonObject = JsonObject> {
  readonly id: string;
  readonly tenantId: EntityId;
  readonly queue: string;
  readonly idempotencyKey: string;
  readonly payload: Payload;
  readonly attempt: number;
  readonly createdAt: IsoDateTime;
}

export interface QueueProvider {
  readonly descriptor: ProviderDescriptor;
  enqueue(
    context: TenantOperationContext,
    input: Omit<QueueMessage, "id" | "attempt" | "createdAt">,
  ): Promise<QueueMessage>;
  claim(
    context: TenantOperationContext,
    queue: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<QueueMessage | null>;
  acknowledge(context: TenantOperationContext, messageId: string, workerId: string): Promise<void>;
  fail(
    context: TenantOperationContext,
    messageId: string,
    workerId: string,
    errorCode: string,
    retryAt: IsoDateTime | null,
  ): Promise<void>;
  moveToDeadLetter(
    context: TenantOperationContext,
    messageId: string,
    reason: string,
  ): Promise<void>;
  health(): Promise<ProviderHealth>;
}

export interface RuntimeCapability {
  readonly key: string;
  readonly supported: boolean;
  readonly limitation: string | null;
}

export interface ApplicationRuntimeTarget {
  readonly descriptor: ProviderDescriptor;
  readonly containerImageRequired: boolean;
  capabilities(): Promise<readonly RuntimeCapability[]>;
  validateRelease(input: {
    readonly imageDigest: string;
    readonly environmentSchemaVersion: string;
    readonly healthContractVersion: string;
  }): Promise<{ readonly valid: boolean; readonly findings: readonly string[] }>;
}

export interface EmailMessage {
  readonly tenantId: EntityId;
  readonly fromReference: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string | null;
  readonly idempotencyKey: string;
}

export interface EmailQuery {
  readonly folderId: string | null;
  readonly search: string | null;
  readonly unreadOnly: boolean;
  readonly limit: number;
  readonly cursor: string | null;
}

export interface EmailAttachmentReference {
  readonly providerMessageId: string;
  readonly attachmentId: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface EmailProvider {
  readonly descriptor: ProviderDescriptor;
  readonly capabilities: readonly string[];
  search(
    context: TenantOperationContext,
    query: EmailQuery,
  ): Promise<{ readonly messages: readonly JsonObject[]; readonly nextCursor: string | null }>;
  get(context: TenantOperationContext, providerMessageId: string): Promise<JsonObject | null>;
  listAttachments(
    context: TenantOperationContext,
    providerMessageId: string,
  ): Promise<readonly EmailAttachmentReference[]>;
  readAttachment(
    context: TenantOperationContext,
    reference: EmailAttachmentReference,
  ): Promise<ReadableStream<Uint8Array>>;
  createDraft(context: GovernedWriteContext, message: EmailMessage): Promise<JsonObject>;
  send(
    context: GovernedWriteContext,
    message: EmailMessage,
  ): Promise<{
    readonly providerMessageId: string;
    readonly acceptedAt: IsoDateTime;
  }>;
  updateDraft(
    context: GovernedWriteContext,
    providerMessageId: string,
    patch: JsonObject,
  ): Promise<JsonObject>;
  sendDraft(
    context: GovernedWriteContext,
    providerMessageId: string,
  ): Promise<{ readonly providerMessageId: string; readonly acceptedAt: IsoDateTime }>;
  reply(
    context: GovernedWriteContext,
    providerMessageId: string,
    message: EmailMessage,
  ): Promise<{ readonly providerMessageId: string; readonly acceptedAt: IsoDateTime }>;
  forward(
    context: GovernedWriteContext,
    providerMessageId: string,
    message: EmailMessage,
  ): Promise<{ readonly providerMessageId: string; readonly acceptedAt: IsoDateTime }>;
  delete(context: GovernedWriteContext, providerMessageId: string): Promise<void>;
  health(): Promise<ProviderHealth>;
}

export interface MonitoringProvider {
  readonly descriptor: ProviderDescriptor;
  recordMetric(
    context: TenantOperationContext,
    name: string,
    value: number,
    dimensions: Readonly<Record<string, string>>,
  ): Promise<void>;
  recordEvent(context: TenantOperationContext, name: string, detail: JsonObject): Promise<void>;
  health(): Promise<ProviderHealth>;
}

export interface BackupArtifact {
  readonly backupId: string;
  readonly tenantId: EntityId | null;
  readonly createdAt: IsoDateTime;
  readonly checksumSha256: string;
  readonly storageReference: string;
  readonly encrypted: boolean;
  readonly verifiedAt: IsoDateTime | null;
}

export interface BackupProvider {
  readonly descriptor: ProviderDescriptor;
  create(context: TenantOperationContext | null, scope: string): Promise<BackupArtifact>;
  verify(context: TenantOperationContext, backupId: string): Promise<BackupArtifact>;
  planRestore(
    context: TenantOperationContext,
    backupId: string,
    targetEnvironment: ProviderEnvironment,
  ): Promise<{
    readonly steps: readonly string[];
    readonly destructive: boolean;
    readonly ownerApprovalRequired: boolean;
  }>;
  delete(context: GovernedWriteContext, backupId: string, ownerConfirmation: string): Promise<void>;
  health(): Promise<ProviderHealth>;
}
