import { cplExecutionId, cplExecutionRevision } from "./cpl-execution.js";
import {
  cplFieldObject,
  cplFieldText,
  type CplFieldEvidenceReference,
  type CplFieldPhotoMetadata,
} from "./cpl-field.js";

export const CPL_REPORT_SECTION_KEYS = [
  "scope",
  "summary",
  "limitations",
  "visits",
  "conclusion",
  "sections",
] as const;
export type CplReportSectionKey = (typeof CPL_REPORT_SECTION_KEYS)[number];
export type CplReportState = "draft" | "in_review" | "changes_requested" | "approved";
export type CplReportPhotoLayout = "large" | "pair" | "appendix";
export interface CplReportPhotoSelection {
  photoId: string;
  layout: CplReportPhotoLayout;
}
export interface CplReportObservationSelection {
  observationId: string;
  titleOverride: string | null;
  descriptionOverride: string | null;
  followUpOverride: string | null;
  photos: CplReportPhotoSelection[];
}
export interface CplReportVisitSelection {
  visitId: string;
  observations: CplReportObservationSelection[];
  overviewPhotos: CplReportPhotoSelection[];
}
export interface CplReportTemplateInput {
  name: string;
  description: string;
  title: string;
  scope: string;
  summary: string;
  limitations: string;
  conclusion: string;
  sections: { id: string; title: string; body: string }[];
  sectionOrder: CplReportSectionKey[];
}
export interface CplReportTemplateVersion extends CplReportTemplateInput {
  id: string;
  organizationId: string;
  version: number;
  createdByIdentityId: string;
  createdAt: string;
}
export interface CplReportContent extends Omit<CplReportTemplateInput, "name" | "description"> {
  visits: CplReportVisitSelection[];
}
export interface CplReportBranding {
  revision: number;
  businessName: string;
  email: string;
  phone: string;
  address: string;
  accentColor: string;
  logoDataUrl: string | null;
}
export interface CplReportSourcePhoto {
  id: string;
  metadataRevision: number;
  originalSha256: string;
  caption: string;
  annotations: CplFieldPhotoMetadata["annotations"];
  layout: CplReportPhotoLayout;
  report: CplFieldEvidenceReference & { width: number; height: number; pipelineVersion: string };
}
export interface CplReportSourceObservation {
  id: string;
  revision: number;
  title: string;
  category: string;
  priority: string;
  location: string;
  description: string;
  followUp: string;
  photos: CplReportSourcePhoto[];
}
export interface CplReportSourceVisit {
  id: string;
  revision: number;
  fieldRevision: number;
  templateId: string;
  templateVersion: number;
  status: string;
  readiness: string[];
  title: string;
  date: string | null;
  timeZone: string;
  personnel: string[];
  observations: CplReportSourceObservation[];
  overviewPhotos: CplReportSourcePhoto[];
}
export interface CplReportSources {
  project: {
    reference: string;
    name: string;
    customerName: string;
    siteName: string;
    siteAddress: string;
  };
  visits: CplReportSourceVisit[];
}
export interface CplReportVersion {
  version: number;
  content: CplReportContent;
  template: CplReportTemplateVersion;
  branding: CplReportBranding;
  sources: CplReportSources;
  sourceHash: string;
  createdByIdentityId: string;
  createdAt: string;
}
/** Public projection is deliberately independent of complete project/field rows.
 * The API server supplies verified derivative bytes to the renderer separately. */
export interface CplReportPublicProjection {
  reference: string;
  version: number;
  approvedAt: string;
  title: string;
  scope: string;
  summary: string;
  limitations: string;
  conclusion: string;
  sections: CplReportContent["sections"];
  sectionOrder: CplReportSectionKey[];
  company: Omit<CplReportBranding, "revision"> & { brandingVersion: number };
  project: CplReportSources["project"];
  visits: {
    visitId: string;
    title: string;
    date: string | null;
    timeZone: string;
    personnel: string[];
    observations: {
      title: string;
      category: string;
      priority: string;
      location: string;
      description: string;
      followUp: string;
      revision: number;
      photos: {
        photoId: string;
        caption: string;
        layout: CplReportPhotoLayout;
        sha256: string;
        width: number;
        height: number;
        annotations: CplFieldPhotoMetadata["annotations"];
      }[];
    }[];
  }[];
}
export interface CplReportArtifact {
  reportId: string;
  version: number;
  reference: CplFieldEvidenceReference;
  rendererVersion: string;
  approvedAt: string;
  approvedByIdentityId: string;
  sourceHash: string;
}
export interface CplReportEvent {
  id: string;
  action: string;
  revision: number;
  version: number;
  actorIdentityId: string;
  note: string;
  createdAt: string;
}
export interface CplReportSummary {
  id: string;
  organizationId: string;
  projectId: string;
  reference: string;
  revision: number;
  currentVersion: number;
  state: CplReportState;
  title: string;
  createdAt: string;
  updatedAt: string;
}
export interface CplReportDetail extends CplReportSummary {
  versions: CplReportVersion[];
  artifacts: CplReportArtifact[];
  events: CplReportEvent[];
  sourcesStale: boolean;
  readiness: { code: string; message: string }[];
  permissions: { canWrite: boolean; canReview: boolean; canConfigure: boolean };
}
export interface CplReportSourceOption {
  visitId: string;
  title: string;
  status: string;
  revision: number;
  fieldRevision: number;
  observations: {
    id: string;
    revision: number;
    title: string;
    description: string;
    followUp: string;
    reportEligible: boolean;
  }[];
  photos: {
    id: string;
    caption: string;
    observationId: string | null;
    overview: boolean;
    reportEligible: boolean;
    state: string;
    metadataRevision: number;
  }[];
}
export interface CplReportWorkspace {
  projectId: string;
  reports: CplReportSummary[];
  templates: CplReportTemplateVersion[];
  branding: CplReportBranding | null;
  sources: CplReportSourceOption[];
  permissions: CplReportDetail["permissions"];
}
export type CplReportApprovalPreparation =
  | { status: "completed"; artifact: CplReportArtifact; version: CplReportVersion }
  | {
      status: "prepared";
      attemptId: string;
      approvedAt: string;
      artifactObjectId: string;
      sourceHash: string;
      projection: CplReportPublicProjection;
      photoReferences: { photoId: string; reference: CplFieldEvidenceReference }[];
    };
export class CplReportValidationError extends Error {
  constructor(readonly code = "CPL_REPORT_INVALID_INPUT") {
    super(code);
    this.name = "CplReportValidationError";
  }
}
function fail(): never {
  throw new CplReportValidationError();
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail();
  return value;
}
function unique<T>(items: T[]): T[] {
  if (new Set(items).size !== items.length) fail();
  return items;
}
function fields(input: unknown): Omit<CplReportContent, "visits"> {
  const v = cplFieldObject(input);
  const sectionOrder = unique(
    list(v.sectionOrder, 6).map((k) => {
      if (!CPL_REPORT_SECTION_KEYS.includes(k as CplReportSectionKey)) fail();
      return k as CplReportSectionKey;
    }),
  );
  if (!sectionOrder.length) fail();
  const sections = list(v.sections ?? [], 20).map((s) => {
    const section = cplFieldObject(s);
    return {
      id: cplExecutionId(section.id),
      title: cplFieldText(section.title, 240, true),
      body: cplFieldText(section.body, 30000),
    };
  });
  unique(sections.map((s) => s.id));
  return {
    title: cplFieldText(v.title, 240, true),
    scope: cplFieldText(v.scope, 30000),
    summary: cplFieldText(v.summary, 30000),
    limitations: cplFieldText(v.limitations, 30000),
    conclusion: cplFieldText(v.conclusion, 30000),
    sections,
    sectionOrder,
  };
}
export function normalizeCplReportTemplate(input: unknown): CplReportTemplateInput {
  const v = cplFieldObject(input);
  return {
    name: cplFieldText(v.name, 240, true),
    description: cplFieldText(v.description, 4000),
    ...fields(v),
  };
}
export function normalizeCplReportContent(input: unknown): CplReportContent {
  const v = cplFieldObject(input),
    photoIds: string[] = [],
    observationIds: string[] = [];
  const photos = (raw: unknown): CplReportPhotoSelection[] =>
    list(raw, 100).map((p) => {
      const photo = cplFieldObject(p),
        photoId = cplExecutionId(photo.photoId);
      photoIds.push(photoId);
      if (!["large", "pair", "appendix"].includes(String(photo.layout))) fail();
      return { photoId, layout: photo.layout as CplReportPhotoLayout };
    });
  const override = (value: unknown, maximum: number) =>
    value === null || value === undefined ? null : cplFieldText(value, maximum);
  const visits = list(v.visits ?? [], 50).map((raw) => {
    const visit = cplFieldObject(raw),
      visitId = cplExecutionId(visit.visitId);
    const observations = list(visit.observations ?? [], 200).map((rawObservation) => {
      const observation = cplFieldObject(rawObservation),
        observationId = cplExecutionId(observation.observationId);
      observationIds.push(observationId);
      return {
        observationId,
        titleOverride: override(observation.titleOverride, 240),
        descriptionOverride: override(observation.descriptionOverride, 30000),
        followUpOverride: override(observation.followUpOverride, 30000),
        photos: photos(observation.photos ?? []),
      };
    });
    return { visitId, observations, overviewPhotos: photos(visit.overviewPhotos ?? []) };
  });
  unique(visits.map((s) => s.visitId));
  unique(observationIds);
  unique(photoIds);
  if (photoIds.length > 100 || observationIds.length > 200) fail();
  return { ...fields(v), visits };
}
export function normalizeCplReportBranding(input: unknown): Omit<CplReportBranding, "revision"> {
  const v = cplFieldObject(input),
    accentColor = cplFieldText(v.accentColor, 7, true),
    email = cplFieldText(v.email, 254);
  if (
    !/^#[a-f0-9]{6}$/iu.test(accentColor) ||
    (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
  )
    fail();
  const logoDataUrl =
    v.logoDataUrl === null || v.logoDataUrl === undefined
      ? null
      : cplFieldText(v.logoDataUrl, 2800000);
  if (
    logoDataUrl !== null &&
    !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/u.test(logoDataUrl)
  )
    fail();
  return {
    businessName: cplFieldText(v.businessName, 240, true),
    email,
    phone: cplFieldText(v.phone, 80),
    address: cplFieldText(v.address, 2000),
    accentColor: accentColor.toUpperCase(),
    logoDataUrl,
  };
}
export { cplExecutionRevision as cplReportRevision };
