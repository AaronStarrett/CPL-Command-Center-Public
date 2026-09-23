import type { CplCommercialProject } from "./cpl-commercial.js";

export const CPL_EXECUTION_TIME_ZONE = "America/Indiana/Indianapolis";
export const CPL_PROJECT_STATUSES = ["active", "on_hold", "completed", "cancelled"] as const;
export const CPL_VISIT_STATUSES = [
  "draft",
  "scheduled",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export const CPL_TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type CplProjectStatus = (typeof CPL_PROJECT_STATUSES)[number];
export type CplVisitStatus = (typeof CPL_VISIT_STATUSES)[number];
export type CplTaskStatus = (typeof CPL_TASK_STATUSES)[number];
export interface CplProjectOperationsInput {
  name: string;
  status: CplProjectStatus;
  ownerIdentityId: string | null;
  teamIdentityIds: string[];
  nextAction: string;
  operationalInstructions: string;
  internalNotes: string;
  timeZone: string;
  statusReason: string;
}
export interface CplProjectOperations extends CplProjectOperationsInput {
  projectId: string;
  revision: number;
  updatedAt: string | null;
  updatedByIdentityId: string | null;
}
export interface CplVisitTaskInput {
  id: string;
  title: string;
  instructions: string;
  required: boolean;
  status: CplTaskStatus;
  note: string;
}
export interface CplVisitInput {
  purpose: string;
  serviceType: string;
  status: CplVisitStatus;
  timeZone: string;
  plannedStartLocal: string | null;
  plannedEndLocal: string | null;
  plannedStartOffsetMinutes: number | null;
  plannedEndOffsetMinutes: number | null;
  responsibleIdentityId: string | null;
  siteName: string;
  siteAddress: string;
  accessInstructions: string;
  actualStartAt: string | null;
  actualEndAt: string | null;
  completionNote: string;
  cancellationReason: string;
  tasks: CplVisitTaskInput[];
}
export interface CplExecutionReadinessItem {
  code: string;
  field: string;
  message: string;
}
export interface CplVisit extends CplVisitInput {
  id: string;
  organizationId: string;
  projectId: string;
  revision: number;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  createdByIdentityId: string;
  createdAt: string;
  updatedAt: string;
  readiness: CplExecutionReadinessItem[];
}
export interface CplExecutionMember {
  identityId: string;
  displayName: string;
  role: string;
}
export interface CplExecutionEvent {
  id: string;
  projectId: string;
  visitId: string | null;
  action: string;
  revision: number;
  actorIdentityId: string;
  createdAt: string;
  before: CplProjectOperationsInput | CplVisitInput | null;
  after: CplProjectOperationsInput | CplVisitInput;
}
export interface CplExecutionPermissions {
  canPlan: boolean;
  canCompleteAssignedVisits: boolean;
}
export interface CplProjectWorkspace {
  project: CplCommercialProject;
  operations: CplProjectOperations;
  members: CplExecutionMember[];
  visits: CplVisit[];
  events: CplExecutionEvent[];
  permissions: CplExecutionPermissions;
  currentIdentityId: string;
}
export interface CplExecutionAgendaItem {
  visit: CplVisit;
  projectReference: string;
  projectName: string;
}
export interface CplExecutionAgenda {
  from: string;
  to: string;
  items: CplExecutionAgendaItem[];
  truncated: boolean;
}
export interface CplVisitConflict {
  visitId: string;
  projectId: string;
  purpose: string;
  plannedStartAt: string;
  plannedEndAt: string;
  timeZone: string;
}
export class CplExecutionValidationError extends Error {
  constructor(readonly code = "CPL_INVALID_INPUT") {
    super(code);
    this.name = "CplExecutionValidationError";
  }
}
function invalid(code?: string): never {
  throw new CplExecutionValidationError(code);
}
export function cplExecutionObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  return input as Record<string, unknown>;
}
function text(value: unknown, maximum = 20000, required = false): string {
  if (value === undefined || value === null) value = "";
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
  )
    invalid();
  const result = value.trim();
  if (required && !result) invalid();
  return result;
}
export function cplExecutionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  )
    invalid();
  return value.toLowerCase();
}
function optionalId(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : cplExecutionId(value);
}
export function cplExecutionRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2147483646)
    invalid();
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid();
  return value as T;
}
export function cplExecutionTimeZone(value: unknown): string {
  const zone = text(value, 100, true);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
  } catch {
    invalid("CPL_EXECUTION_TIME_ZONE_INVALID");
  }
  return zone;
}
export function cplExecutionInstant(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  )
    invalid();
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().replace(".000Z", "Z") !== value.replace(".000Z", "Z")
  )
    invalid();
  if (parsed < Date.UTC(2000, 0, 1) || parsed >= Date.UTC(2101, 0, 1)) invalid();
  return new Date(parsed).toISOString();
}
function localParts(format: Intl.DateTimeFormat, time: number): string {
  const parts = Object.fromEntries(
    format.formatToParts(time).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
/** Resolve wall time independently of the host/browser zone. Repeated DST times
 * require an explicit UTC offset in minutes (e.g. Indianapolis winter=-300). */
export function resolveCplLocalDateTime(
  value: unknown,
  timeZone: string,
  preferredOffset?: unknown,
): { local: string; instant: string; offsetMinutes: number } | null {
  if (value === null || value === undefined || value === "") {
    if (preferredOffset !== null && preferredOffset !== undefined) invalid();
    return null;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) invalid();
  const wall = Date.parse(`${value}:00.000Z`);
  if (
    !Number.isFinite(wall) ||
    new Date(wall).toISOString().slice(0, 16) !== value ||
    wall < Date.UTC(2000, 0, 1) ||
    wall >= Date.UTC(2101, 0, 1)
  )
    invalid();
  if (
    preferredOffset !== undefined &&
    preferredOffset !== null &&
    (typeof preferredOffset !== "number" ||
      !Number.isInteger(preferredOffset) ||
      Math.abs(preferredOffset) > 840)
  )
    invalid();
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: cplExecutionTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const offsets = new Set(
    [-86400000, 0, 86400000].map(
      (delta) => (Date.parse(`${localParts(format, wall + delta)}:00Z`) - (wall + delta)) / 60000,
    ),
  );
  const candidates = [...offsets]
    .map((offsetMinutes) => ({
      local: value,
      instant: new Date(wall - offsetMinutes * 60000).toISOString(),
      offsetMinutes,
    }))
    .filter((candidate) => localParts(format, Date.parse(candidate.instant)) === value);
  if (!candidates.length) invalid("CPL_EXECUTION_TIME_NONEXISTENT");
  if (preferredOffset !== null && preferredOffset !== undefined)
    return (
      candidates.find((candidate) => candidate.offsetMinutes === preferredOffset) ??
      invalid("CPL_EXECUTION_TIME_OFFSET_INVALID")
    );
  if (candidates.length !== 1) invalid("CPL_EXECUTION_TIME_AMBIGUOUS");
  return candidates[0]!;
}
export function normalizeCplProjectOperations(input: unknown): CplProjectOperationsInput {
  const row = cplExecutionObject(input);
  if (!Array.isArray(row.teamIdentityIds) || row.teamIdentityIds.length > 100) invalid();
  const teamIdentityIds = row.teamIdentityIds.map(cplExecutionId);
  if (new Set(teamIdentityIds).size !== teamIdentityIds.length) invalid();
  const status = choice(row.status, CPL_PROJECT_STATUSES);
  return {
    name: text(row.name, 240, true),
    status,
    ownerIdentityId: optionalId(row.ownerIdentityId),
    teamIdentityIds: teamIdentityIds.sort(),
    nextAction: text(row.nextAction, 2000),
    operationalInstructions: text(row.operationalInstructions),
    internalNotes: text(row.internalNotes),
    timeZone: cplExecutionTimeZone(row.timeZone),
    statusReason: text(row.statusReason, 2000, status !== "active"),
  };
}
export function normalizeCplVisit(
  input: unknown,
): CplVisitInput & { plannedStartAt: string | null; plannedEndAt: string | null } {
  const row = cplExecutionObject(input),
    timeZone = cplExecutionTimeZone(row.timeZone);
  const start = resolveCplLocalDateTime(
      row.plannedStartLocal,
      timeZone,
      row.plannedStartOffsetMinutes,
    ),
    end = resolveCplLocalDateTime(row.plannedEndLocal, timeZone, row.plannedEndOffsetMinutes);
  if (
    Boolean(start) !== Boolean(end) ||
    (start &&
      end &&
      (end.instant <= start.instant ||
        Date.parse(end.instant) - Date.parse(start.instant) > 14 * 86400000))
  )
    invalid();
  if (!Array.isArray(row.tasks) || row.tasks.length > 100) invalid();
  const tasks = row.tasks.map((value): CplVisitTaskInput => {
    const task = cplExecutionObject(value),
      status = choice(task.status, CPL_TASK_STATUSES);
    if (typeof task.required !== "boolean") invalid();
    return {
      id: cplExecutionId(task.id),
      title: text(task.title, 240, true),
      instructions: text(task.instructions, 4000),
      required: task.required,
      status,
      note: text(task.note, 4000, status === "cancelled"),
    };
  });
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) invalid();
  const status = choice(row.status, CPL_VISIT_STATUSES),
    actualStartAt = cplExecutionInstant(row.actualStartAt),
    actualEndAt = cplExecutionInstant(row.actualEndAt);
  if (actualEndAt && (!actualStartAt || actualEndAt < actualStartAt)) invalid();
  if (
    [actualStartAt, actualEndAt].some(
      (instant) => instant && Date.parse(instant) > Date.now() + 60000,
    )
  )
    invalid();
  return {
    purpose: text(row.purpose, 240, true),
    serviceType: text(row.serviceType, 240),
    status,
    timeZone,
    plannedStartLocal: start?.local ?? null,
    plannedEndLocal: end?.local ?? null,
    plannedStartOffsetMinutes: start?.offsetMinutes ?? null,
    plannedEndOffsetMinutes: end?.offsetMinutes ?? null,
    plannedStartAt: start?.instant ?? null,
    plannedEndAt: end?.instant ?? null,
    responsibleIdentityId: optionalId(row.responsibleIdentityId),
    siteName: text(row.siteName, 240),
    siteAddress: text(row.siteAddress, 2000),
    accessInstructions: text(row.accessInstructions),
    actualStartAt,
    actualEndAt,
    completionNote: text(row.completionNote, 4000),
    cancellationReason: text(row.cancellationReason, 2000, status === "cancelled"),
    tasks,
  };
}
export function cplVisitReadiness(visit: CplVisitInput): CplExecutionReadinessItem[] {
  const missing: CplExecutionReadinessItem[] = [];
  if (!visit.responsibleIdentityId)
    missing.push({
      code: "responsible_required",
      field: "responsibleIdentityId",
      message: "Assign an active responsible team member.",
    });
  if (!visit.plannedStartLocal || !visit.plannedEndLocal)
    missing.push({
      code: "schedule_required",
      field: "plannedStartLocal",
      message: "Set a start and end time.",
    });
  if (!visit.siteName && !visit.siteAddress)
    missing.push({
      code: "location_required",
      field: "siteName",
      message: "Record the visit location.",
    });
  for (const task of visit.tasks)
    if (task.required && task.status !== "completed")
      missing.push({
        code: "task_incomplete",
        field: `tasks.${task.id}`,
        message: `Complete required task: ${task.title}`,
      });
  return missing;
}
