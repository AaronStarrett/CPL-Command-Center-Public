import type { EntityId, IsoDateTime, JsonObject, VersionedEntity } from "./entities.js";

export interface TenantOwned {
  readonly tenantId: EntityId;
}

export type TenantStatus = "provisioning" | "active" | "suspended" | "deleting" | "deleted";

export interface Tenant extends VersionedEntity {
  readonly slug: string;
  readonly displayName: string;
  readonly status: TenantStatus;
  readonly defaultRegion: string;
  readonly retentionPolicyId: EntityId;
  readonly deletedAt: IsoDateTime | null;
}

export interface TenantDomain extends VersionedEntity, TenantOwned {
  readonly hostname: string;
  readonly verificationState: "pending" | "verified" | "failed";
  readonly tlsState: "pending" | "active" | "failed";
  readonly primary: boolean;
}

export interface TenantUser extends VersionedEntity, TenantOwned {
  readonly applicationUserId: EntityId;
  readonly identityProvider: string;
  readonly providerSubject: string;
  readonly status: "invited" | "active" | "suspended" | "removed";
}

export interface TenantRole extends VersionedEntity, TenantOwned {
  readonly key: string;
  readonly name: string;
  readonly permissionKeys: readonly string[];
}

export interface TenantSubscription extends VersionedEntity, TenantOwned {
  readonly planKey: string;
  readonly status: "trial" | "active" | "past_due" | "suspended" | "cancelled";
  readonly subscriptionProvider: string | null;
  readonly providerReference: string | null;
  readonly currentPeriodEndsAt: IsoDateTime | null;
}

export interface TenantFeature extends VersionedEntity, TenantOwned {
  readonly key: string;
  readonly enabled: boolean;
  readonly entitlementSource: "plan" | "override" | "trial";
  readonly limits: JsonObject;
}

export interface TenantConnector extends VersionedEntity, TenantOwned {
  readonly connectorType: string;
  readonly displayName: string;
  readonly secretReferenceId: EntityId | null;
  readonly status: "configured" | "connected" | "degraded" | "revoked";
  readonly executionPolicyId: EntityId;
}

export interface TenantSecretReference extends VersionedEntity, TenantOwned {
  readonly secretProvider: string;
  readonly opaqueReference: string;
  readonly purpose: string;
  readonly rotatedAt: IsoDateTime | null;
}

export interface TenantStorageNamespace extends VersionedEntity, TenantOwned {
  readonly storageProvider: string;
  readonly namespace: string;
  readonly region: string;
  readonly retentionPolicyId: EntityId;
}

export interface TenantModelRoutingProfile extends VersionedEntity, TenantOwned {
  readonly name: string;
  readonly allowedProviderKeys: readonly string[];
  readonly defaultModelClass: string;
  readonly monthlyBudgetCeiling: number | null;
  readonly routingRules: JsonObject;
}

export interface TenantAgent extends VersionedEntity, TenantOwned {
  readonly agentProfileId: EntityId;
  readonly teamId: EntityId;
  readonly managerAgentId: EntityId | null;
  readonly modelRoutingProfileId: EntityId;
  readonly memoryPolicyId: EntityId;
  readonly approvalPolicyId: EntityId;
}

export interface TenantAuditEvent extends TenantOwned {
  readonly id: EntityId;
  readonly occurredAt: IsoDateTime;
  readonly actorType: "user" | "agent" | "system" | "bridge";
  readonly actorId: EntityId | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: EntityId | null;
  readonly outcome: "allowed" | "denied" | "succeeded" | "failed";
  readonly correlationId: string;
  readonly detail: JsonObject;
}

export interface TenantLifecycleProvider {
  provision(tenant: Tenant): Promise<void>;
  exportTenant(tenantId: EntityId): Promise<{ readonly exportReference: string }>;
  deleteTenant(
    tenantId: EntityId,
    input: { readonly approvedBy: EntityId; readonly confirmation: string },
  ): Promise<void>;
}

export interface SubscriptionProvider {
  synchronize(subscription: TenantSubscription): Promise<TenantSubscription>;
}
