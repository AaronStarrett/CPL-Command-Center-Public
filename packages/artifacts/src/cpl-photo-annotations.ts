/** Pure annotation contract shared by browser UI, SQL services and PDF rendering. */
export const CPL_PHOTO_ANNOTATION_MAXIMUM_IMAGE_SIDE = 16_384;
export class CplPhotoAnnotationError extends Error {
  readonly code = "CPL_IMAGE_INVALID_ANNOTATIONS";
  constructor() {
    super("CPL_IMAGE_INVALID_ANNOTATIONS");
    this.name = "CplPhotoAnnotationError";
  }
}
function fail(): never {
  throw new CplPhotoAnnotationError();
}
interface AnnotationStyle {
  readonly color: string;
  /** Fraction of the upright image's shorter side. */
  readonly strokeWidth: number;
}
export type CplPhotoAnnotation =
  | (AnnotationStyle & {
      readonly kind: "arrow";
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
    })
  | (AnnotationStyle & {
      readonly kind: "rectangle" | "ellipse";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    })
  | {
      readonly kind: "label";
      readonly x: number;
      readonly y: number;
      readonly text: string;
      readonly color: string;
      readonly fontSize: number;
    };
export interface CplPhotoAnnotations {
  readonly coordinateSpace: "upright-normalized-v1";
  readonly shapes: readonly CplPhotoAnnotation[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    fail();
}
function fraction(value: unknown, minimum = 0, maximum = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)
    fail();
  return value;
}

/** JSON-only shapes; no markup, external resources, paths, or client-rendered image. */
export function validateCplPhotoAnnotations(input: unknown): CplPhotoAnnotations {
  const value = record(input);
  exactKeys(value, ["coordinateSpace", "shapes"]);
  if (
    value.coordinateSpace !== "upright-normalized-v1" ||
    !Array.isArray(value.shapes) ||
    value.shapes.length > 50
  )
    fail();
  const shapes = value.shapes.map((inputShape): CplPhotoAnnotation => {
    const shape = record(inputShape);
    if (typeof shape.color !== "string" || !/^#[0-9a-f]{6}$/iu.test(shape.color)) fail();
    const color = shape.color.toUpperCase();
    if (shape.kind === "label") {
      exactKeys(shape, ["kind", "x", "y", "text", "color", "fontSize"]);
      if (
        typeof shape.text !== "string" ||
        shape.text.trim().length < 1 ||
        shape.text.length > 80 ||
        /[\u0000-\u001f\u007f]/u.test(shape.text)
      )
        fail();
      return {
        kind: "label",
        x: fraction(shape.x),
        y: fraction(shape.y),
        text: shape.text,
        color,
        fontSize: fraction(shape.fontSize, 0.02, 0.08),
      };
    }
    const strokeWidth = fraction(shape.strokeWidth, 0.002, 0.02);
    if (shape.kind === "arrow") {
      exactKeys(shape, ["kind", "x1", "y1", "x2", "y2", "color", "strokeWidth"]);
      const x1 = fraction(shape.x1),
        y1 = fraction(shape.y1),
        x2 = fraction(shape.x2),
        y2 = fraction(shape.y2);
      if (x1 === x2 && y1 === y2) fail();
      return { kind: "arrow", x1, y1, x2, y2, color, strokeWidth };
    }
    if (shape.kind !== "rectangle" && shape.kind !== "ellipse") fail();
    exactKeys(shape, ["kind", "x", "y", "width", "height", "color", "strokeWidth"]);
    const x = fraction(shape.x),
      y = fraction(shape.y),
      width = fraction(shape.width, Number.EPSILON),
      height = fraction(shape.height, Number.EPSILON);
    if (x + width > 1 || y + height > 1) fail();
    return { kind: shape.kind, x, y, width, height, color, strokeWidth };
  });
  return { coordinateSpace: "upright-normalized-v1", shapes };
}

/** Rendering seam for a canvas/SVG UI or PDF vector renderer. Coordinates are
 * top-left/downward relative to the contained upright image, never its outer box.
 * Labels remain plain text and must use text APIs (not innerHTML/SVG concatenation).
 * PDF callers invert Y once at their own page-coordinate boundary. */
export function projectCplPhotoAnnotations(
  input: unknown,
  image: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): readonly CplPhotoAnnotation[] {
  if (
    ![image.x, image.y, image.width, image.height].every(Number.isFinite) ||
    image.width <= 0 ||
    image.height <= 0 ||
    image.width > CPL_PHOTO_ANNOTATION_MAXIMUM_IMAGE_SIDE ||
    image.height > CPL_PHOTO_ANNOTATION_MAXIMUM_IMAGE_SIDE
  )
    fail();
  const annotations = validateCplPhotoAnnotations(input);
  const scale = Math.min(image.width, image.height);
  return annotations.shapes.map((shape) => {
    if (shape.kind === "arrow")
      return {
        ...shape,
        x1: image.x + shape.x1 * image.width,
        y1: image.y + shape.y1 * image.height,
        x2: image.x + shape.x2 * image.width,
        y2: image.y + shape.y2 * image.height,
        strokeWidth: shape.strokeWidth * scale,
      };
    if (shape.kind === "label")
      return {
        ...shape,
        x: image.x + shape.x * image.width,
        y: image.y + shape.y * image.height,
        fontSize: shape.fontSize * scale,
      };
    return {
      ...shape,
      x: image.x + shape.x * image.width,
      y: image.y + shape.y * image.height,
      width: shape.width * image.width,
      height: shape.height * image.height,
      strokeWidth: shape.strokeWidth * scale,
    };
  });
}
