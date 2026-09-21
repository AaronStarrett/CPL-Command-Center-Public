import type {
  AuditLog,
  AuditSink,
  JsonValue,
  SystemSetting,
  SystemSettingStore,
} from "@bea/domain";
import { SystemSettingService } from "../../packages/config/src/index.js";
import { describe, expect, it, vi } from "vitest";

const actorUserId = "10000000-0000-4000-8000-000000000001";
const fixedTime = "2026-08-20T18:00:00.000Z";

function setting(value: JsonValue, version = 1): SystemSetting {
  return {
    id: "50000000-0000-4000-8000-000000000005",
    key: "ai.provider.settings",
    value,
    description: "AI provider settings",
    sensitivity: "internal",
    createdByUserId: actorUserId,
    createdAt: fixedTime,
    updatedAt: fixedTime,
    version,
  };
}

function auditLog(eventType: string): AuditLog {
  return {
    id: "70000000-0000-4000-8000-000000000001",
    eventType,
    action: "system-setting.set",
    outcome: "allowed",
    actorUserId,
    resourceType: "system-setting",
    resourceId: "50000000-0000-4000-8000-000000000005",
    correlationId: null,
    metadata: {},
    createdAt: fixedTime,
  };
}

describe("audited system setting service", () => {
  it("does not mutate when the durable authorization audit persistently fails", async () => {
    let current = setting({ mode: "demo" });
    const setSystemSetting = vi.fn<SystemSettingStore["setSystemSetting"]>(
      async (key, value, updatedByUserId, updatedAt, expectedVersion) => {
        if (
          key !== current.key ||
          (expectedVersion !== undefined && current.version !== expectedVersion)
        ) {
          throw new Error("synthetic version conflict");
        }
        current = {
          ...current,
          value,
          createdByUserId: updatedByUserId,
          updatedAt,
          version: current.version + 1,
        };
        return current;
      },
    );
    const store: SystemSettingStore = {
      getSystemSetting: vi.fn(async () => current),
      listSystemSettings: vi.fn(async () => [current]),
      setSystemSetting,
    };
    const auditFailure = new Error("synthetic audit outage");
    const audit: AuditSink = {
      record: vi.fn(async () => {
        throw auditFailure;
      }),
    };
    const service = new SystemSettingService(store, audit, { now: () => new Date(fixedTime) });

    await expect(
      service.set({
        key: current.key,
        value: { mode: "openai" },
        actorUserId,
        correlationId: "settings-audit-rollback",
      }),
    ).rejects.toBe(auditFailure);

    expect(current.value).toEqual({ mode: "demo" });
    expect(current.version).toBe(1);
    expect(setSystemSetting).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "system-setting.change-authorized",
        outcome: "allowed",
      }),
    );
  });

  it("records durable authorization before the version-guarded mutation", async () => {
    let current = setting({ mode: "demo" });
    const calls: string[] = [];
    const store: SystemSettingStore = {
      getSystemSetting: vi.fn(async () => current),
      listSystemSettings: vi.fn(async () => [current]),
      setSystemSetting: vi.fn(async (key, value, updatedByUserId, updatedAt, expectedVersion) => {
        calls.push("mutation");
        expect(expectedVersion).toBe(current.version);
        current = {
          ...current,
          key,
          value,
          createdByUserId: updatedByUserId,
          updatedAt,
          version: current.version + 1,
        };
        return current;
      }),
    };
    const audit: AuditSink = {
      record: vi.fn(async (event) => {
        calls.push("authorization-audit");
        return auditLog(event.eventType);
      }),
    };
    const service = new SystemSettingService(store, audit, { now: () => new Date(fixedTime) });

    await expect(
      service.set({
        key: current.key,
        value: { mode: "openai" },
        actorUserId,
        correlationId: "settings-authorized",
      }),
    ).resolves.toMatchObject({ value: { mode: "openai" }, version: 2 });

    expect(calls).toEqual(["authorization-audit", "mutation"]);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it("does not emit a success event when the authorized mutation fails", async () => {
    const current = setting({ mode: "demo" });
    const mutationFailure = new Error("synthetic mutation failure");
    const store: SystemSettingStore = {
      getSystemSetting: vi.fn(async () => current),
      listSystemSettings: vi.fn(async () => [current]),
      setSystemSetting: vi.fn(async () => {
        throw mutationFailure;
      }),
    };
    const audit: AuditSink = {
      record: vi.fn(async (event) => auditLog(event.eventType)),
    };
    const service = new SystemSettingService(store, audit, { now: () => new Date(fixedTime) });

    await expect(
      service.set({
        key: current.key,
        value: { mode: "openai" },
        actorUserId,
      }),
    ).rejects.toBe(mutationFailure);

    expect(current.value).toEqual({ mode: "demo" });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "system-setting.change-authorized" }),
    );
  });
});
