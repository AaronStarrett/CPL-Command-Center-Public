import type { CplVisit } from "./cpl-execution.js";
import { cplExecutionId, cplExecutionRevision } from "./cpl-execution.js";

export const CPL_FIELD_TYPES = ["text", "number", "date", "choice", "checkbox", "photo"] as const;
export const CPL_FIELD_RESULTS = ["complete", "issue", "not_applicable", "not_inspected"] as const;
export type CplFieldType = (typeof CPL_FIELD_TYPES)[number];
export type CplFieldResult = (typeof CPL_FIELD_RESULTS)[number];
export interface CplFieldTemplateItem {
  id: string;
  label: string;
  instructions: string;
  type: CplFieldType;
  required: boolean;
  unit: string;
  options: string[];
  naReasonRequired: boolean;
  minimumPhotos: number;
}
export interface CplFieldTemplateInput {
  name: string;
  description: string;
  sections: { id: string; title: string; items: CplFieldTemplateItem[] }[];
}
export interface CplFieldTemplateVersion extends CplFieldTemplateInput {
  id: string;
  organizationId: string;
  version: number;
  createdByIdentityId: string;
  createdAt: string;
}
export interface CplFieldAnswer {
  itemId: string;
  result: CplFieldResult;
  value: string | number | boolean | null;
  note: string;
  photoIds: string[];
}
export interface CplFieldObservationInput {
  title: string;
  location: string;
  component: string;
  description: string;
  checklistItemId: string | null;
  category: string;
  priority: string;
  followUp: string;
  internalNotes: string;
  reportEligible: boolean;
}
export interface CplFieldObservationRevision extends CplFieldObservationInput {
  revision: number;
  createdByIdentityId: string;
  createdAt: string;
}
export interface CplFieldObservation extends CplFieldObservationRevision {
  id: string;
  revisions: CplFieldObservationRevision[];
}
// Structurally matches the browser-safe artifact annotation contract. Validation
// belongs to the single shared artifact validator at the persistence boundary.
export type CplFieldPhotoShape =
  | {
      kind: "arrow";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
      strokeWidth: number;
    }
  | {
      kind: "rectangle" | "ellipse";
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
      strokeWidth: number;
    }
  | { kind: "label"; x: number; y: number; text: string; color: string; fontSize: number };
export interface CplFieldPhotoMetadata {
  caption: string;
  observationId: string | null;
  order: number;
  overview: boolean;
  reportEligible: boolean;
  annotations: { coordinateSpace: "upright-normalized-v1"; shapes: readonly CplFieldPhotoShape[] };
}
export interface CplFieldPhotoMetadataRevision extends CplFieldPhotoMetadata {
  revision: number;
  createdByIdentityId: string;
  createdAt: string;
}
export interface CplFieldPhotoDerivative {
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
  mimeType: "image/png";
  pipelineVersion: string;
}
export interface CplFieldPhoto {
  id: string;
  organizationId: string;
  projectId: string;
  visitId: string;
  revision: number;
  state: "reserved" | "original_ready" | "processing" | "ready" | "failed";
  failureCode:
    | "CPL_PHOTO_ORIGINAL_UNAVAILABLE"
    | "CPL_PHOTO_PROCESSING_FAILED"
    | "CPL_PHOTO_STORAGE_UNAVAILABLE"
    | null;
  attempts: number;
  processingExpiresAt: string | null;
  original: {
    filename: string;
    mimeType: "image/jpeg" | "image/png";
    sha256: string;
    byteLength: number;
    width: number | null;
    height: number | null;
    exifOrientation: number | null;
  };
  upright: { width: number; height: number } | null;
  thumbnail: CplFieldPhotoDerivative | null;
  report: CplFieldPhotoDerivative | null;
  metadata: CplFieldPhotoMetadataRevision;
  revisions: CplFieldPhotoMetadataRevision[];
  createdByIdentityId: string;
  createdAt: string;
  updatedAt: string;
}
export interface CplFieldReadinessItem {
  code: string;
  field: string;
  message: string;
}
export interface CplFieldChecklistRevision {
  revision: number;
  answers: CplFieldAnswer[];
  createdByIdentityId: string;
  createdAt: string;
}
export interface CplFieldEvent {
  id: string;
  action: string;
  revision: number;
  resourceId: string | null;
  actorIdentityId: string;
  createdAt: string;
  note: string;
}
export interface CplFieldWorkspace {
  projectId: string;
  visit: CplVisit;
  revision: number;
  template: CplFieldTemplateVersion | null;
  templates: CplFieldTemplateVersion[];
  answers: CplFieldAnswer[];
  checklistRevisions: CplFieldChecklistRevision[];
  observations: CplFieldObservation[];
  photos: CplFieldPhoto[];
  events: CplFieldEvent[];
  readiness: CplFieldReadinessItem[];
  permissions: {
    canManageTemplates: boolean;
    canAttachTemplate: boolean;
    canEdit: boolean;
    canReopen: boolean;
  };
}
export interface CplFieldPhotoUploadInput {
  filename: string;
  mimeType: "image/jpeg" | "image/png";
  sha256: string;
  byteLength: number;
}
export interface CplFieldEvidenceReference {
  organizationId: string;
  objectId: string;
  sha256: string;
  byteLength: number;
}
/** Server orchestration only. Never accept these object IDs from a browser. */
export interface CplFieldPhotoTransfer {
  photo: CplFieldPhoto;
  original: CplFieldEvidenceReference;
  thumbnailObjectId: string;
  reportObjectId: string;
}
export class CplFieldValidationError extends Error {
  constructor(readonly code = "CPL_FIELD_INVALID_INPUT") {
    super(code);
    this.name = "CplFieldValidationError";
  }
}
function fail(): never {
  throw new CplFieldValidationError();
}
export function cplFieldObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail();
  return input as Record<string, unknown>;
}
export function cplFieldText(value: unknown, maximum = 20000, required = false): string {
  if (value === undefined || value === null) value = "";
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
  )
    fail();
  const result = value.trim();
  if (required && !result) fail();
  return result;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    fail();
  return value;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail();
  return value;
}
function unique<T>(values: T[]): T[] {
  if (new Set(values).size !== values.length) fail();
  return values;
}
export function normalizeCplFieldTemplate(input: unknown): CplFieldTemplateInput {
  const v = cplFieldObject(input);
  const ids: string[] = [];
  const sections = list(v.sections, 20).map((s) => {
    const section = cplFieldObject(s),
      id = cplExecutionId(section.id);
    ids.push(id);
    return {
      id,
      title: cplFieldText(section.title, 240, true),
      items: list(section.items, 100).map((i) => {
        const item = cplFieldObject(i),
          itemId = cplExecutionId(item.id);
        ids.push(itemId);
        if (!CPL_FIELD_TYPES.includes(item.type as CplFieldType)) fail();
        const type = item.type as CplFieldType;
        const options = unique(list(item.options ?? [], 40).map((o) => cplFieldText(o, 200, true)));
        const unit = cplFieldText(item.unit, 60);
        const minimumPhotos = integer(item.minimumPhotos ?? (type === "photo" ? 1 : 0), 0, 20);
        if (
          (type === "choice" && !options.length) ||
          (type !== "choice" && options.length) ||
          (type !== "number" && unit) ||
          (type === "photo" && minimumPhotos < 1)
        )
          fail();
        return {
          id: itemId,
          label: cplFieldText(item.label, 240, true),
          instructions: cplFieldText(item.instructions, 4000),
          type,
          required: bool(item.required),
          unit,
          options,
          naReasonRequired: bool(item.naReasonRequired ?? true),
          minimumPhotos,
        };
      }),
    };
  });
  unique(ids);
  if (
    !sections.length ||
    sections.reduce((n, s) => n + s.items.length, 0) > 200 ||
    sections.every((s) => !s.items.length)
  )
    fail();
  return {
    name: cplFieldText(v.name, 240, true),
    description: cplFieldText(v.description, 4000),
    sections,
  };
}
export function normalizeCplFieldAnswers(
  input: unknown,
  template: CplFieldTemplateInput,
): CplFieldAnswer[] {
  const items = new Map(template.sections.flatMap((s) => s.items.map((i) => [i.id, i] as const)));
  const answers = list(input, 200).map((raw) => {
    const v = cplFieldObject(raw),
      itemId = cplExecutionId(v.itemId),
      item = items.get(itemId);
    if (!item) fail();
    if (!CPL_FIELD_RESULTS.includes(v.result as CplFieldResult)) fail();
    let value = v.value ?? null;
    if (value !== null) {
      if (item.type === "text" || item.type === "date" || item.type === "choice") {
        const textValue = cplFieldText(value, 8000);
        if (
          textValue &&
          item.type === "date" &&
          (!/^\d{4}-\d{2}-\d{2}$/u.test(textValue) ||
            !Number.isFinite(Date.parse(textValue)) ||
            new Date(textValue).toISOString().slice(0, 10) !== textValue)
        )
          fail();
        if (textValue && item.type === "choice" && !item.options.includes(textValue)) fail();
        value = textValue;
      } else if (item.type === "number") {
        if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1000000000)
          fail();
      } else if (item.type === "checkbox") value = bool(value);
      else fail();
    }
    return {
      itemId,
      result: v.result as CplFieldResult,
      value: value as CplFieldAnswer["value"],
      note: cplFieldText(v.note, 8000),
      photoIds: unique(list(v.photoIds ?? [], 20).map(cplExecutionId)),
    };
  });
  unique(answers.map((a) => a.itemId));
  return answers;
}
export function normalizeCplFieldObservation(input: unknown): CplFieldObservationInput {
  const v = cplFieldObject(input);
  return {
    title: cplFieldText(v.title, 240, true),
    location: cplFieldText(v.location, 1000),
    component: cplFieldText(v.component, 1000),
    description: cplFieldText(v.description),
    checklistItemId: v.checklistItemId ? cplExecutionId(v.checklistItemId) : null,
    category: cplFieldText(v.category, 120),
    priority: cplFieldText(v.priority, 120),
    followUp: cplFieldText(v.followUp),
    internalNotes: cplFieldText(v.internalNotes),
    reportEligible: bool(v.reportEligible),
  };
}
export function normalizeCplFieldPhotoUpload(input: unknown): CplFieldPhotoUploadInput {
  const v = cplFieldObject(input),
    filename = cplFieldText(v.filename, 160, true);
  if (
    /[\\/:\u0000-\u001f\u007f]/u.test(filename) ||
    filename === "." ||
    filename === ".." ||
    !/\.(?:png|jpe?g)$/iu.test(filename) ||
    !["image/jpeg", "image/png"].includes(String(v.mimeType))
  )
    fail();
  if (typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(v.sha256)) fail();
  if ((v.mimeType === "image/png") !== /\.png$/iu.test(filename)) fail();
  return {
    filename,
    mimeType: v.mimeType as CplFieldPhotoUploadInput["mimeType"],
    sha256: v.sha256,
    byteLength: integer(v.byteLength, 1, 12 * 1024 * 1024),
  };
}
export function normalizeCplFieldPhotoMetadata(
  input: unknown,
  validateAnnotations: (input: unknown) => CplFieldPhotoMetadata["annotations"],
): CplFieldPhotoMetadata {
  const v = cplFieldObject(input);
  return {
    caption: cplFieldText(v.caption, 4000),
    observationId: v.observationId ? cplExecutionId(v.observationId) : null,
    order: integer(v.order, 0, 9999),
    overview: bool(v.overview),
    reportEligible: bool(v.reportEligible),
    annotations: validateAnnotations(v.annotations),
  };
}
export function cplFieldReadiness(
  template: CplFieldTemplateInput | null,
  answers: readonly CplFieldAnswer[],
  photos: readonly Pick<CplFieldPhoto, "id" | "state">[],
): CplFieldReadinessItem[] {
  if (!template) return [];
  const rows: CplFieldReadinessItem[] = [],
    byId = new Map(answers.map((a) => [a.itemId, a])),
    ready = new Set(photos.filter((p) => p.state === "ready").map((p) => p.id));
  // Rendering/storage occurs outside the database transaction. Prevent visit
  // completion from locking a still-active upload out of its finalization or
  // recovery path. Optional failed uploads remain retained but do not deadlock
  // completion; a required checklist photo still must be ready below.
  for (const photo of photos)
    if (["reserved", "original_ready", "processing"].includes(photo.state))
      rows.push({
        code: "CPL_FIELD_PHOTO_PENDING",
        field: photo.id,
        message:
          "A photo upload is pending. Finish or retry processing before completing the visit.",
      });
  for (const item of template.sections.flatMap((s) => s.items)) {
    const answer = byId.get(item.id),
      add = (code: string, message: string) =>
        rows.push({ code, field: item.id, message: `${item.label}: ${message}` });
    if (!answer || answer.result === "not_inspected") {
      if (item.required) add("CPL_FIELD_REQUIRED", "not inspected");
      continue;
    }
    if (answer.result === "not_applicable") {
      if (item.naReasonRequired && !answer.note)
        add("CPL_FIELD_NA_REASON_REQUIRED", "explain why this is not applicable");
      continue;
    }
    if (answer.result === "issue" && !answer.note)
      add("CPL_FIELD_ISSUE_NOTE_REQUIRED", "describe the observed issue");
    if (
      item.required &&
      item.type !== "photo" &&
      (answer.value === null ||
        answer.value === "" ||
        (item.type === "checkbox" && answer.value !== true && answer.result === "complete"))
    )
      add("CPL_FIELD_VALUE_REQUIRED", "enter the recorded value");
    if (answer.photoIds.filter((id) => ready.has(id)).length < item.minimumPhotos)
      add("CPL_FIELD_PHOTOS_REQUIRED", `requires ${item.minimumPhotos} ready photo(s)`);
  }
  return rows;
}
export { cplExecutionRevision as cplFieldRevision };
