import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cplFieldReadiness,
  normalizeCplFieldAnswers,
  normalizeCplFieldObservation,
  normalizeCplFieldPhotoMetadata,
  normalizeCplFieldPhotoUpload,
  normalizeCplFieldTemplate,
  type CplFieldTemplateItem,
} from "../../packages/domain/src/cpl-field";
import { validateCplPhotoAnnotations } from "../../packages/artifacts/src/cpl-photo-annotations";
const item = (patch: Partial<CplFieldTemplateItem> = {}): CplFieldTemplateItem => ({
  id: randomUUID(),
  label: "Human measurement",
  instructions: "Record actual evidence",
  type: "text",
  required: true,
  unit: "",
  options: [],
  naReasonRequired: true,
  minimumPhotos: 0,
  ...patch,
});
const template = (...items: CplFieldTemplateItem[]) =>
  normalizeCplFieldTemplate({
    name: "Fictional service",
    description: "Explicit human configuration",
    sections: [{ id: randomUUID(), title: "Observations", items }],
  });
describe("versioned field pure validation", () => {
  it("accepts all six configured field types without severity inference", () => {
    const fields = [
      item(),
      item({ type: "number", unit: "mm" }),
      item({ type: "date" }),
      item({ type: "choice", options: ["A", "B"] }),
      item({ type: "checkbox" }),
      item({ type: "photo", minimumPhotos: 1 }),
    ];
    const t = template(...fields);
    const answers = normalizeCplFieldAnswers(
      fields.map((f, i) => ({
        itemId: f.id,
        result: "complete",
        value: ["Observed", 0, "2026-09-23", "A", true, null][i],
        photoIds: [],
        note: "",
      })),
      t,
    );
    expect(answers.map((a) => a.value)).toEqual(["Observed", 0, "2026-09-23", "A", true, null]);
    expect(cplFieldReadiness(t, answers, [])).toMatchObject([
      { code: "CPL_FIELD_PHOTOS_REQUIRED" },
    ]);
  });
  it("never treats unchecked or missing required answers as pass", () => {
    const checkbox = item({ type: "checkbox" }),
      text = item(),
      t = template(checkbox, text);
    expect(cplFieldReadiness(t, [], [])).toHaveLength(2);
    const answers = normalizeCplFieldAnswers(
      [{ itemId: checkbox.id, result: "complete", value: false, note: "", photoIds: [] }],
      t,
    );
    expect(cplFieldReadiness(t, answers, []).map((v) => v.code)).toEqual([
      "CPL_FIELD_VALUE_REQUIRED",
      "CPL_FIELD_REQUIRED",
    ]);
  });
  it("saves incomplete drafts but requires issue and configured NA explanations", () => {
    const a = item(),
      b = item(),
      t = template(a, b);
    const answers = normalizeCplFieldAnswers(
      [
        { itemId: a.id, result: "issue", value: "Human finding", note: "" },
        { itemId: b.id, result: "not_applicable", value: null, note: "" },
      ],
      t,
    );
    expect(cplFieldReadiness(t, answers, []).map((v) => v.code)).toEqual([
      "CPL_FIELD_ISSUE_NOTE_REQUIRED",
      "CPL_FIELD_NA_REASON_REQUIRED",
    ]);
    expect(
      cplFieldReadiness(
        t,
        answers.map((v) => ({ ...v, note: "Human explanation" })),
        [],
      ),
    ).toEqual([]);
  });
  it("uses only ready evidence for photo requirements", () => {
    const a = item({ type: "photo", minimumPhotos: 1 }),
      t = template(a),
      photoId = randomUUID();
    const answers = normalizeCplFieldAnswers(
      [{ itemId: a.id, result: "complete", value: null, photoIds: [photoId] }],
      t,
    );
    expect(cplFieldReadiness(t, answers, [{ id: photoId, state: "failed" }])).toHaveLength(1);
    expect(cplFieldReadiness(t, answers, [{ id: photoId, state: "ready" }])).toEqual([]);
  });
  it("rejects reused template IDs and invalid choice/unit configuration", () => {
    const a = item();
    expect(() => template(a, a)).toThrow();
    expect(() => template(item({ type: "choice", options: [] }))).toThrow();
    expect(() => template(item({ unit: "mm" }))).toThrow();
    expect(() => template(item({ type: "photo", minimumPhotos: 0 }))).toThrow();
  });
  it.each(["2026-02-30", "2026-13-01", "23/09/2026"])(
    "rejects invalid recorded date %s",
    (value) => {
      const a = item({ type: "date" }),
        t = template(a);
      expect(() =>
        normalizeCplFieldAnswers([{ itemId: a.id, result: "complete", value }], t),
      ).toThrow();
    },
  );
  it("rejects unsupported values, duplicated answers and foreign item IDs", () => {
    const a = item({ type: "number" }),
      t = template(a),
      answer = { itemId: a.id, result: "complete", value: 1 };
    expect(() => normalizeCplFieldAnswers([{ ...answer, value: "1" }], t)).toThrow();
    expect(() => normalizeCplFieldAnswers([{ ...answer, value: Infinity }], t)).toThrow();
    expect(() => normalizeCplFieldAnswers([answer, answer], t)).toThrow();
    expect(() => normalizeCplFieldAnswers([{ ...answer, itemId: randomUUID() }], t)).toThrow();
  });
  it("keeps human observation and internal/report decisions explicit", () => {
    const saved = normalizeCplFieldObservation({
      title: "Observed condition",
      reportEligible: false,
      priority: "",
      internalNotes: "Private",
      recommendation: "UNTRUSTED",
    });
    expect(saved).toMatchObject({
      priority: "",
      followUp: "",
      category: "",
      internalNotes: "Private",
      reportEligible: false,
    });
    expect(saved).not.toHaveProperty("recommendation");
  });
  it("rejects upload paths/mismatches/oversize and has bounded annotation metadata", () => {
    const raw = {
      filename: "photo.png",
      mimeType: "image/png",
      sha256: "a".repeat(64),
      byteLength: 10,
    };
    expect(normalizeCplFieldPhotoUpload(raw)).toEqual(raw);
    for (const patch of [
      { filename: "../photo.png" },
      { filename: "photo.jpg" },
      { byteLength: 13 * 1024 * 1024 },
      { sha256: "invalid" },
    ])
      expect(() => normalizeCplFieldPhotoUpload({ ...raw, ...patch })).toThrow();
    const metadata = {
      caption: "Human caption",
      observationId: null,
      order: 1,
      overview: true,
      reportEligible: false,
      annotations: {
        coordinateSpace: "upright-normalized-v1",
        shapes: [
          { kind: "label", x: 0.1, y: 0.2, text: "Human label", color: "#ff0000", fontSize: 0.03 },
        ],
      },
    };
    expect(
      normalizeCplFieldPhotoMetadata(metadata, validateCplPhotoAnnotations).annotations.shapes,
    ).toHaveLength(1);
    expect(() =>
      normalizeCplFieldPhotoMetadata(
        { ...metadata, annotations: { ...metadata.annotations, svg: "<script>" } },
        validateCplPhotoAnnotations,
      ),
    ).toThrow();
  });
});
