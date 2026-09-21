import type { AuditSink, EntityId, PermissionGrantStore } from "@bea/domain";
import {
  AccessDeniedError,
  PERMISSIONS,
  type AuthorizationDecision,
  type Permission,
  type TaskReadScope,
} from "./rbac.js";

export class PersistentAuthorizationService {
  constructor(
    private readonly grants: PermissionGrantStore,
    private readonly audit?: AuditSink,
  ) {}

  async authorizeUser(
    userId: EntityId | null | undefined,
    permission: Permission | undefined,
  ): Promise<AuthorizationDecision> {
    if (!permission) return { allowed: false, reason: "invalid-requirement" };
    if (!userId) return { allowed: false, reason: "unauthenticated" };
    return (await this.grants.userHasPermission(userId, permission))
      ? { allowed: true }
      : { allowed: false, reason: "permission-not-granted" };
  }

  async taskReadScopeForUser(userId: EntityId | null | undefined): Promise<TaskReadScope> {
    const viewDecision = await this.authorizeUser(userId, PERMISSIONS.TASKS_VIEW);
    if (!viewDecision.allowed) return "none";
    const [viewAllDecision, manageDecision] = await Promise.all([
      this.authorizeUser(userId, PERMISSIONS.TASKS_VIEW_ALL),
      this.authorizeUser(userId, PERMISSIONS.TASKS_MANAGE),
    ]);
    return viewAllDecision.allowed || manageDecision.allowed ? "all" : "assigned";
  }

  async requireUser(input: {
    readonly userId: EntityId | null | undefined;
    readonly permission: Permission;
    readonly action: string;
    readonly resourceType?: string;
    readonly resourceId?: EntityId;
    readonly correlationId?: string;
  }): Promise<void> {
    const decision = await this.authorizeUser(input.userId, input.permission);
    if (decision.allowed) return;
    if (this.audit) {
      await this.audit.record({
        eventType: "authorization.denied",
        action: input.action,
        outcome: "denied",
        actorUserId: input.userId ?? null,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        correlationId: input.correlationId ?? null,
        metadata: {
          permission: input.permission,
          reason: decision.reason,
          source: "database-rbac",
        },
      });
    }
    throw new AccessDeniedError(decision.reason);
  }
}
