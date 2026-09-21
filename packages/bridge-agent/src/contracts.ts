import type { EntityId, IsoDateTime, JsonObject } from "@bea/domain";

export type BridgeCapability =
  | "local-file-read"
  | "local-file-write"
  | "desktop-application"
  | "browser-automation"
  | "private-network"
  | "screenshot"
  | "artifact-return";

export interface BridgeDeviceRegistration {
  readonly deviceId: EntityId;
  readonly tenantId: EntityId;
  readonly ownerUserId: EntityId;
  readonly displayName: string;
  readonly certificateReference: string;
  readonly approvedCapabilities: readonly BridgeCapability[];
  readonly registeredAt: IsoDateTime;
  readonly revokedAt: IsoDateTime | null;
}

export interface SignedBridgeTaskEnvelope {
  readonly taskId: EntityId;
  readonly tenantId: EntityId;
  readonly deviceId: EntityId;
  readonly requestedBy: EntityId;
  readonly capability: BridgeCapability;
  readonly command: JsonObject;
  readonly idempotencyKey: string;
  readonly issuedAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly nonce: string;
  readonly signature: string;
}

export interface BridgeTaskEvidence {
  readonly taskId: EntityId;
  readonly tenantId: EntityId;
  readonly deviceId: EntityId;
  readonly status: "succeeded" | "failed" | "blocked" | "cancelled";
  readonly startedAt: IsoDateTime;
  readonly completedAt: IsoDateTime;
  readonly logReferences: readonly string[];
  readonly screenshotReferences: readonly string[];
  readonly artifactReferences: readonly string[];
  readonly resultFingerprint: string;
  readonly signature: string;
}

export interface BridgeOutboundChannel {
  register(registration: BridgeDeviceRegistration): Promise<void>;
  connectOutbound(deviceId: EntityId): Promise<void>;
  receiveAuthorizedTask(deviceId: EntityId): Promise<SignedBridgeTaskEnvelope | null>;
  submitEvidence(evidence: BridgeTaskEvidence): Promise<void>;
  disconnect(deviceId: EntityId): Promise<void>;
}

export interface BridgeEmergencyStop {
  isStopped(deviceId: EntityId): Promise<boolean>;
  stop(deviceId: EntityId, requestedBy: EntityId, reason: string): Promise<void>;
  resume(deviceId: EntityId, approvedBy: EntityId, confirmation: string): Promise<void>;
}
