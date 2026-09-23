import { describe, expect, it } from "vitest";
import { projectCplPhotoAnnotations, validateCplPhotoAnnotations } from "./cpl-photo-annotations";
const annotations = () => ({
  coordinateSpace: "upright-normalized-v1",
  shapes: [
    { kind: "arrow", x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9, color: "#ee1100", strokeWidth: 0.01 },
    {
      kind: "rectangle",
      x: 0.2,
      y: 0.3,
      width: 0.3,
      height: 0.4,
      color: "#00aaee",
      strokeWidth: 0.01,
    },
    {
      kind: "ellipse",
      x: 0.2,
      y: 0.3,
      width: 0.3,
      height: 0.4,
      color: "#00aaee",
      strokeWidth: 0.01,
    },
    { kind: "label", x: 0.1, y: 0.2, text: "Roof edge", color: "#112233", fontSize: 0.04 },
  ],
});
describe("normalized photo annotation rendering seam", () => {
  it("projects all supported primitives against upright image geometry at different sizes", () => {
    const small = projectCplPhotoAnnotations(annotations(), {
      x: 10,
      y: 20,
      width: 200,
      height: 100,
    });
    const large = projectCplPhotoAnnotations(annotations(), {
      x: 0,
      y: 0,
      width: 2000,
      height: 1000,
    });
    expect(small[0]).toMatchObject({
      x1: 30,
      y1: 40,
      x2: 170,
      y2: 110,
      strokeWidth: 1,
      color: "#EE1100",
    });
    expect(large[0]).toMatchObject({ x1: 200, y1: 200, x2: 1600, y2: 900, strokeWidth: 10 });
    expect(small[1]).toMatchObject({ x: 50, y: 50, width: 60, height: 40 });
    expect(small[3]).toMatchObject({ x: 30, y: 40, text: "Roof edge", fontSize: 4 });
  });
  it.each([
    { ...annotations(), coordinateSpace: "raw-exif" },
    { ...annotations(), url: "https://untrusted.invalid" },
    { ...annotations(), shapes: Array(51).fill(annotations().shapes[0]) },
    { ...annotations(), shapes: [{ ...annotations().shapes[0], x1: Number.NaN }] },
    { ...annotations(), shapes: [{ ...annotations().shapes[1], width: 0.9 }] },
    { ...annotations(), shapes: [{ ...annotations().shapes[0], color: "url(external)" }] },
    { ...annotations(), shapes: [{ ...annotations().shapes[0], svg: "<script/>" }] },
    { ...annotations(), shapes: [{ ...annotations().shapes[3], text: "bad\nlabel" }] },
    { ...annotations(), shapes: [{ ...annotations().shapes[3], text: "x".repeat(81) }] },
  ])("rejects unbounded or non-typed annotation input %#", (value) => {
    expect(() => validateCplPhotoAnnotations(value)).toThrow("CPL_IMAGE_INVALID_ANNOTATIONS");
  });
});
