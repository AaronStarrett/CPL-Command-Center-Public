import type {
  AuditSink,
  Clock,
  EntityId,
  FeatureFlag,
  FeatureFlagStore,
  JsonValue,
  SystemSetting,
  SystemSettingStore,
} from "@bea/domain";

const systemClock: Clock = { now: () => new Date() };

export class FeatureFlagService {
  constructor(
    private readonly store: FeatureFlagStore,
    private readonly audit: AuditSink,
    private readonly clock: Clock = systemClock,
  ) {}

  async isEnabled(key: string): Promise<boolean> {
    return (await this.store.getFeatureFlag(key))?.enabled ?? false;
  }

  list(): Promise<readonly FeatureFlag[]> {
    return this.store.listFeatureFlags();
  }

  async setEnabled(input: {
    key: string;
    enabled: boolean;
    actorUserId: EntityId;
    expectedVersion?: number;
    correlationId?: string;
  }): Promise<FeatureFlag> {
    const updatedAt = this.clock.now().toISOString();
    const updated = await this.store.setFeatureFlag(
      input.key,
      input.enabled,
      input.actorUserId,
      updatedAt,
      input.expectedVersion,
    );
    await this.audit.record({
      eventType: "feature-flag.changed",
      action: "feature-flag.set-enabled",
      outcome: "succeeded",
      actorUserId: input.actorUserId,
      resourceType: "feature-flag",
      resourceId: updated.id,
      correlationId: input.correlationId ?? null,
      metadata: { key: input.key, enabled: input.enabled },
      createdAt: updatedAt,
    });
    return updated;
  }
}

export class SystemSettingService {
  constructor(
    private readonly store: SystemSettingStore,
    private readonly audit: AuditSink,
    private readonly clock: Clock = systemClock,
  ) {}

  get(key: string): Promise<SystemSetting | null> {
    return this.store.getSystemSetting(key);
  }

  list(): Promise<readonly SystemSetting[]> {
    return this.store.listSystemSettings();
  }

  async set(input: {
    key: string;
    value: JsonValue;
    actorUserId: EntityId;
    expectedVersion?: number;
    correlationId?: string;
  }): Promise<SystemSetting> {
    const previous = await this.store.getSystemSetting(input.key);
    if (previous === null) {
      throw new Error("System setting does not exist and cannot be changed safely.");
    }
    const updatedAt = this.clock.now().toISOString();
    await this.audit.record({
      eventType: "system-setting.change-authorized",
      action: "system-setting.set",
      outcome: "allowed",
      actorUserId: input.actorUserId,
      resourceType: "system-setting",
      resourceId: previous.id,
      correlationId: input.correlationId ?? null,
      metadata: { key: input.key, valueRecordedInAudit: false },
      createdAt: updatedAt,
    });
    const updated = await this.store.setSystemSetting(
      input.key,
      input.value,
      input.actorUserId,
      updatedAt,
      input.expectedVersion ?? previous.version,
    );
    return updated;
  }
}
