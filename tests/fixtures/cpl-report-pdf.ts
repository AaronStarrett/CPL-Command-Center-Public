import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type {
  CplApprovedReportPdf,
  CplReportPdfPhoto,
} from "../../packages/artifacts/src/cpl-report-pdf";

/** Synthetic pixel fixtures, not field photographs or physical camera evidence. */
async function photo(
  width: number,
  height: number,
  layout: CplReportPdfPhoto["layout"],
  caption: string,
): Promise<CplReportPdfPhoto> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const joint = Math.abs(x - width * 0.48 - Math.sin(y / 36) * 8) < 4;
      const tile = Math.floor(x / 80) % 2 === Math.floor(y / 65) % 2;
      const index = (y * width + x) * 3;
      pixels[index] = joint ? 35 : tile ? 191 : 175;
      pixels[index + 1] = joint ? 42 : tile ? 199 : 186;
      pixels[index + 2] = joint ? 46 : tile ? 204 : 196;
    }
  const bytes = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  return {
    caption,
    layout,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    annotations: {
      coordinateSpace: "upright-normalized-v1",
      shapes: [
        {
          kind: "arrow",
          x1: 0.18,
          y1: 0.2,
          x2: 0.49,
          y2: 0.48,
          color: "#BF263C",
          strokeWidth: 0.006,
        },
        {
          kind: "ellipse",
          x: 0.41,
          y: 0.4,
          width: 0.18,
          height: 0.2,
          color: "#BF263C",
          strokeWidth: 0.005,
        },
        {
          kind: "rectangle",
          x: 0.35,
          y: 0.7,
          width: 0.3,
          height: 0.15,
          color: "#1769AA",
          strokeWidth: 0.004,
        },
        {
          kind: "label",
          x: 0.04,
          y: 0.05,
          text: "Review joint",
          color: "#14394D",
          fontSize: 0.035,
        },
      ],
    },
  };
}
export async function cplReportPdfFixture(long = false): Promise<CplApprovedReportPdf> {
  const logo = await readFile(new URL("../../apps/web/public/brand/cpl-logo.png", import.meta.url));
  const expanded = long
    ? Array.from(
        { length: 70 },
        (_, index) =>
          `Caption detail ${index}: This synthetic inspection example records the visible joint and the boundary of the marked review area without claiming a confirmed cause.`,
      ).join("\n") + "\nLONG-CAPTION-END"
    : "Synthetic façade detail. The red arrow and ellipse identify the joint for human review; the blue rectangle marks a separate area.";
  return {
    reference: "RPT-2026-0042",
    version: 3,
    approvedAt: "2026-09-23T15:30:00.000Z",
    title: "Building envelope field observations",
    scope: long
      ? Array.from(
          { length: 42 },
          (_, index) =>
            `Scope paragraph ${index}: Accessible exterior areas were reviewed during the selected visits. These observations are limited to the visible condition at the recorded time.`,
        ).join("\n") + "\nSCOPE-END"
      : "Visual review of accessible exterior joints and roof-edge details during two scheduled site visits.",
    summary:
      "Two selected observations are presented for review. This document contains synthetic demonstration imagery and is not a real inspection finding.",
    limitations:
      "Visual observations only. Concealed conditions were not evaluated. No laboratory or destructive testing was performed.",
    conclusion:
      "Confirm the appropriate next step with the responsible reviewer. No repair authorization or delivery is implied by this PDF. CONCLUSION-END",
    company: {
      businessName: "Cyber Pirate Labs",
      email: "reports@example.invalid",
      phone: "",
      address: "",
      accentColor: "#0B506B",
      logoDataUrl: `data:image/png;base64,${logo.toString("base64")}`,
      brandingVersion: 2,
    },
    project: {
      reference: "PRJ-2026-0018",
      name: "Synthetic building envelope review",
      customerName: "Example Facility",
      siteName: "Demonstration site",
      siteAddress: "100 Example Way",
    },
    visits: [
      {
        title: "Initial exterior review",
        date: "2026-09-21",
        timeZone: "America/Indiana/Indianapolis",
        personnel: ["Synthetic Inspector"],
        observations: [
          {
            title: "Vertical joint condition",
            category: "Exterior wall",
            priority: "Review",
            location: "East elevation",
            description:
              "An irregular line is visible along the selected joint. The marked region is an observation requiring review, not a confirmed diagnosis.",
            followUp:
              "Compare with the approved detail and review adjacent conditions before recommending work.",
            revision: 4,
            photos: [
              await photo(960, 640, "pair", expanded),
              await photo(
                480,
                800,
                "pair",
                "Portrait view of the same synthetic joint. Proportions and the complete image are preserved. PORTRAIT-CAPTION-END",
              ),
              await photo(
                900,
                550,
                "appendix",
                "Selected context image retained in the appendix. APPENDIX-CAPTION-END",
              ),
            ],
          },
        ],
      },
      {
        title: "Follow-up visual review",
        date: "2026-09-23",
        timeZone: "America/Indiana/Indianapolis",
        personnel: [],
        observations: [
          {
            title: "Roof-edge transition",
            category: "Roof edge",
            priority: "",
            location: "",
            description:
              "A selected follow-up view records the transition for reviewer consideration. No concealed condition is inferred.",
            followUp: "",
            revision: 1,
            photos: [
              await photo(
                600,
                900,
                "large",
                "Full-height portrait image with no crop or stretch. The annotation stays tied to upright image coordinates. FINAL-PHOTO-CAPTION",
              ),
            ],
          },
        ],
      },
    ],
  };
}
