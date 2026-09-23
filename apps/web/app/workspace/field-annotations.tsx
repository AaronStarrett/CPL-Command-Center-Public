"use client";

import { useId, useRef, useState } from "react";
import {
  projectCplPhotoAnnotations,
  validateCplPhotoAnnotations,
  type CplPhotoAnnotation,
  type CplPhotoAnnotations,
} from "@bea/artifacts/cpl-photo-annotations";
import styles from "./workspace.module.css";
import forms from "./execution.module.css";
import css from "./field.module.css";

const shapeNames = {
  arrow: "Arrow",
  rectangle: "Rectangle",
  ellipse: "Circle / oval",
  label: "Text label",
};
const bounded = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;

export function PhotoAnnotations({
  value,
  src,
  width,
  height,
  disabled,
  onChange,
}: {
  value: CplPhotoAnnotations;
  src: string;
  width: number;
  height: number;
  disabled: boolean;
  onChange: (value: CplPhotoAnnotations) => void;
}) {
  const [selected, setSelected] = useState(0);
  const marker = useId().replaceAll(":", "");
  const drawing = useRef<{ x: number; y: number; index: number } | null>(null);
  const selectedShape = value.shapes[selected];
  let validation = "";
  let projected: readonly CplPhotoAnnotation[] = [];
  try {
    projected = projectCplPhotoAnnotations(value, { x: 0, y: 0, width, height });
  } catch {
    validation =
      "Keep coordinates inside the image, shapes larger than zero, arrow endpoints distinct, and labels between 1 and 80 characters.";
  }
  function replace(index: number, shape: CplPhotoAnnotation) {
    onChange({
      coordinateSpace: "upright-normalized-v1",
      shapes: value.shapes.map((item, i) => (i === index ? shape : item)),
    });
  }
  function update(key: string, field: number | string) {
    if (!selectedShape) return;
    replace(selected, { ...selectedShape, [key]: field } as CplPhotoAnnotation);
  }
  function add(kind: CplPhotoAnnotation["kind"]) {
    const color = "#D54032";
    const shape: CplPhotoAnnotation =
      kind === "arrow"
        ? { kind, x1: 0.2, y1: 0.65, x2: 0.6, y2: 0.35, color, strokeWidth: 0.006 }
        : kind === "label"
          ? { kind, x: 0.15, y: 0.2, text: "Observation", color, fontSize: 0.04 }
          : { kind, x: 0.25, y: 0.25, width: 0.3, height: 0.3, color, strokeWidth: 0.006 };
    setSelected(value.shapes.length);
    onChange({ coordinateSpace: "upright-normalized-v1", shapes: [...value.shapes, shape] });
  }
  function point(event: React.PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: bounded((event.clientX - box.left) / box.width),
      y: bounded((event.clientY - box.top) / box.height),
    };
  }
  function coordinate(
    label: string,
    key: string,
    current: number,
    minimum = 0,
    maximum = 100,
    step = 0.1,
  ) {
    return (
      <label className={forms.field}>
        <span>{label}</span>
        <input
          type="number"
          min={minimum}
          max={maximum}
          step={step}
          value={Math.round(current * 10000) / 100}
          onChange={(event) => update(key, Number(event.target.value) / 100)}
        />
      </label>
    );
  }
  return (
    <section className={css.annotation} aria-label="Photo annotation editor">
      <h3>Mark the photo</h3>
      <p className={forms.hint}>
        Annotations are separate from the original image. Add a shape, then drag on the photo or
        adjust its labeled percentage controls. Save the photo to retain these changes.
      </p>
      <div className={css.annotationImage} style={{ aspectRatio: `${width} / ${height}` }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Upright photo with editable annotations"
          className={css.annotationSvg}
          onPointerDown={(event) => {
            if (disabled || !selectedShape || validation) return;
            const start = point(event);
            if (!Number.isFinite(start.x) || !Number.isFinite(start.y)) return;
            if (selectedShape.kind === "label") {
              replace(selected, { ...selectedShape, ...start });
              return;
            }
            drawing.current = { ...start, index: selected };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = drawing.current;
            if (disabled || !start) return;
            const shape = value.shapes[start.index];
            if (!shape || shape.kind === "label") return;
            const end = point(event);
            if (
              !Number.isFinite(end.x) ||
              !Number.isFinite(end.y) ||
              (start.x === end.x && start.y === end.y)
            )
              return;
            if (shape.kind === "arrow")
              replace(start.index, { ...shape, x1: start.x, y1: start.y, x2: end.x, y2: end.y });
            else if (start.x !== end.x && start.y !== end.y)
              replace(start.index, {
                ...shape,
                x: Math.min(start.x, end.x),
                y: Math.min(start.y, end.y),
                width: Math.abs(start.x - end.x),
                height: Math.abs(start.y - end.y),
              });
          }}
          onPointerUp={() => {
            drawing.current = null;
          }}
          onPointerCancel={() => {
            drawing.current = null;
          }}
        >
          <defs>
            <marker
              id={marker}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>
          <image
            href={src}
            x={0}
            y={0}
            width={width}
            height={height}
            preserveAspectRatio="xMidYMid meet"
          />
          {projected.map((shape, index) => (
            <g key={index} data-annotation-kind={shape.kind}>
              {shape.kind === "arrow" ? (
                <line
                  x1={shape.x1}
                  y1={shape.y1}
                  x2={shape.x2}
                  y2={shape.y2}
                  stroke={shape.color}
                  strokeWidth={shape.strokeWidth}
                  markerEnd={`url(#${marker})`}
                />
              ) : shape.kind === "rectangle" ? (
                <rect
                  x={shape.x}
                  y={shape.y}
                  width={shape.width}
                  height={shape.height}
                  fill="none"
                  stroke={shape.color}
                  strokeWidth={shape.strokeWidth}
                />
              ) : shape.kind === "ellipse" ? (
                <ellipse
                  cx={shape.x + shape.width / 2}
                  cy={shape.y + shape.height / 2}
                  rx={shape.width / 2}
                  ry={shape.height / 2}
                  fill="none"
                  stroke={shape.color}
                  strokeWidth={shape.strokeWidth}
                />
              ) : shape.kind === "label" ? (
                <text
                  x={shape.x}
                  y={shape.y}
                  fill={shape.color}
                  fontSize={shape.fontSize}
                  fontFamily="Arial, sans-serif"
                  dominantBaseline="hanging"
                >
                  {shape.text}
                </text>
              ) : null}
            </g>
          ))}
        </svg>
      </div>
      {validation ? (
        <p role="alert" className={styles.warning}>
          {validation}
        </p>
      ) : null}
      <fieldset disabled={disabled} className={css.annotationControls}>
        <div className={styles.actions}>
          {(
            [
              ["arrow", "Add arrow"],
              ["ellipse", "Add circle / oval"],
              ["rectangle", "Add rectangle"],
              ["label", "Add text label"],
            ] as const
          ).map(([kind, label]) => (
            <button
              type="button"
              className={styles.secondary}
              key={kind}
              disabled={value.shapes.length >= 50}
              onClick={() => add(kind)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className={forms.hint}>
          {value.shapes.length}/50 annotations. Percentage positions refer to the upright image, so
          resizing does not move the markings.
        </p>
        {value.shapes.length ? (
          <label className={forms.field}>
            <span>Selected annotation</span>
            <select
              value={selectedShape ? selected : ""}
              onChange={(event) => setSelected(Number(event.target.value))}
            >
              {value.shapes.map((shape, index) => (
                <option key={index} value={index}>
                  {index + 1}. {shapeNames[shape.kind]}
                  {shape.kind === "label" ? `: ${shape.text}` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p>No annotations yet.</p>
        )}
        {selectedShape ? (
          <>
            <div className={forms.grid}>
              {selectedShape.kind === "arrow" ? (
                <>
                  {coordinate("Arrow start X (%)", "x1", selectedShape.x1)}
                  {coordinate("Arrow start Y (%)", "y1", selectedShape.y1)}
                  {coordinate("Arrow end X (%)", "x2", selectedShape.x2)}
                  {coordinate("Arrow end Y (%)", "y2", selectedShape.y2)}
                </>
              ) : (
                <>
                  {coordinate("Annotation X (%)", "x", selectedShape.x)}
                  {coordinate("Annotation Y (%)", "y", selectedShape.y)}
                  {selectedShape.kind !== "label" ? (
                    <>
                      {coordinate("Annotation width (%)", "width", selectedShape.width, 0.1)}
                      {coordinate("Annotation height (%)", "height", selectedShape.height, 0.1)}
                    </>
                  ) : null}
                </>
              )}
              <label className={forms.field}>
                <span>Annotation color</span>
                <input
                  type="color"
                  value={selectedShape.color}
                  onChange={(event) => update("color", event.target.value)}
                />
              </label>
              {selectedShape.kind === "label" ? (
                <>
                  {coordinate(
                    "Label size (% of shorter side)",
                    "fontSize",
                    selectedShape.fontSize,
                    2,
                    8,
                  )}
                  <label className={`${forms.field} ${forms.wide}`}>
                    <span>Annotation label text</span>
                    <input
                      required
                      maxLength={80}
                      value={selectedShape.text}
                      onChange={(event) => update("text", event.target.value)}
                    />
                  </label>
                </>
              ) : (
                coordinate(
                  "Stroke width (% of shorter side)",
                  "strokeWidth",
                  selectedShape.strokeWidth,
                  0.2,
                  2,
                )
              )}
            </div>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                onChange({
                  coordinateSpace: "upright-normalized-v1",
                  shapes: value.shapes.filter((_, index) => index !== selected),
                });
                setSelected(Math.max(0, selected - 1));
              }}
            >
              Remove selected annotation
            </button>
          </>
        ) : null}
      </fieldset>
    </section>
  );
}

export { validateCplPhotoAnnotations };
