import { describe, expect, it } from "vitest";
import {
  CPL_EXECUTION_TIME_ZONE,
  cplExecutionInstant,
  cplVisitReadiness,
  normalizeCplProjectOperations,
  normalizeCplVisit,
  resolveCplLocalDateTime,
} from "../../packages/domain/src/cpl-execution";

const id = "a1111111-1111-4111-8111-111111111111";
const draft = () => ({
  purpose: "Fictional site visit",
  status: "draft",
  timeZone: CPL_EXECUTION_TIME_ZONE,
  tasks: [],
});
describe("tenant execution input and timezone rules", () => {
  it("resolves Indianapolis wall time without the host timezone", () => {
    expect(resolveCplLocalDateTime("2026-07-10T09:30", CPL_EXECUTION_TIME_ZONE)).toEqual({
      local: "2026-07-10T09:30",
      instant: "2026-07-10T13:30:00.000Z",
      offsetMinutes: -240,
    });
    expect(resolveCplLocalDateTime("2026-12-10T09:30", CPL_EXECUTION_TIME_ZONE)?.instant).toBe(
      "2026-12-10T14:30:00.000Z",
    );
  });
  it("rejects a nonexistent spring-forward time", () => {
    expect(() => resolveCplLocalDateTime("2026-03-08T02:30", CPL_EXECUTION_TIME_ZONE)).toThrow(
      "CPL_EXECUTION_TIME_NONEXISTENT",
    );
  });
  it("requires explicit offset for a repeated fall-back time", () => {
    expect(() => resolveCplLocalDateTime("2026-11-01T01:30", CPL_EXECUTION_TIME_ZONE)).toThrow(
      "CPL_EXECUTION_TIME_AMBIGUOUS",
    );
    expect(
      resolveCplLocalDateTime("2026-11-01T01:30", CPL_EXECUTION_TIME_ZONE, -240)?.instant,
    ).toBe("2026-11-01T05:30:00.000Z");
    expect(
      resolveCplLocalDateTime("2026-11-01T01:30", CPL_EXECUTION_TIME_ZONE, -300)?.instant,
    ).toBe("2026-11-01T06:30:00.000Z");
  });
  it("rejects stale offset and invalid zone", () => {
    expect(() =>
      resolveCplLocalDateTime("2026-07-10T09:00", CPL_EXECUTION_TIME_ZONE, -300),
    ).toThrow("CPL_EXECUTION_TIME_OFFSET_INVALID");
    expect(() => resolveCplLocalDateTime("2026-07-10T09:00", "Not/AZone")).toThrow(
      "CPL_EXECUTION_TIME_ZONE_INVALID",
    );
  });
  it("supports quarter-hour offsets and midnight without rolling dates", () => {
    expect(resolveCplLocalDateTime("2026-01-01T00:00", "Asia/Kathmandu")?.instant).toBe(
      "2025-12-31T18:15:00.000Z",
    );
  });
  it.each(["2026-02-30T12:00", "2026-04-01T24:00", "2026-04-01", "2026-04-01T12:00Z"])(
    "rejects malformed or impossible wall time %s",
    (value) => {
      expect(() => resolveCplLocalDateTime(value, CPL_EXECUTION_TIME_ZONE)).toThrow();
    },
  );
  it("allows incomplete draft capture but exposes actual missing requirements", () => {
    const value = normalizeCplVisit(draft());
    expect(value.responsibleIdentityId).toBeNull();
    expect(cplVisitReadiness(value).map((row) => row.code)).toEqual([
      "responsible_required",
      "schedule_required",
      "location_required",
    ]);
  });
  it("never treats an unchecked or cancelled required task as complete", () => {
    const value = normalizeCplVisit({
      ...draft(),
      tasks: [
        {
          id,
          title: "Photograph context",
          instructions: "",
          required: true,
          status: "pending",
          note: "",
        },
      ],
    });
    expect(cplVisitReadiness(value)).toContainEqual(
      expect.objectContaining({ code: "task_incomplete" }),
    );
    value.tasks[0]!.status = "cancelled";
    expect(cplVisitReadiness(value)).toContainEqual(
      expect.objectContaining({ code: "task_incomplete" }),
    );
    value.tasks[0]!.status = "completed";
    expect(cplVisitReadiness(value).some((row) => row.code === "task_incomplete")).toBe(false);
  });
  it("rejects duplicate task identity, missing cancellation reason, and excessive intervals", () => {
    const task = { id, title: "Task", required: true, status: "pending" };
    expect(() => normalizeCplVisit({ ...draft(), tasks: [task, task] })).toThrow();
    expect(() => normalizeCplVisit({ ...draft(), status: "cancelled" })).toThrow();
    expect(() =>
      normalizeCplVisit({
        ...draft(),
        plannedStartLocal: "2026-10-01T09:00",
        plannedEndLocal: "2026-10-20T09:00",
      }),
    ).toThrow();
  });
  it("rejects reversed/one-sided appointments and impossible actual timestamps", () => {
    expect(() =>
      normalizeCplVisit({ ...draft(), plannedStartLocal: "2026-10-01T09:00" }),
    ).toThrow();
    expect(() =>
      normalizeCplVisit({
        ...draft(),
        plannedStartLocal: "2026-10-01T10:00",
        plannedEndLocal: "2026-10-01T09:00",
      }),
    ).toThrow();
    expect(() => cplExecutionInstant("2026-02-30T09:00:00Z")).toThrow();
    expect(() => cplExecutionInstant("2026-01-01T09:00:00-05:00")).toThrow();
  });
  it("requires reasons for project holds/terminal status and unique team members", () => {
    const input = {
      name: "Fictional project",
      status: "active",
      teamIdentityIds: [id],
      timeZone: CPL_EXECUTION_TIME_ZONE,
    };
    expect(normalizeCplProjectOperations(input).teamIdentityIds).toEqual([id]);
    expect(() => normalizeCplProjectOperations({ ...input, status: "cancelled" })).toThrow();
    expect(() => normalizeCplProjectOperations({ ...input, teamIdentityIds: [id, id] })).toThrow();
  });
});
