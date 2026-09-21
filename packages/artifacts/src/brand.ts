import type { ArtifactBrandMetadata, ArtifactRenderer } from "./contracts.js";

export const ARTIFACT_BRAND_POLICY_VERSION = "bea-artifact-brand-v1";
export const ARTIFACT_TEMPLATE_VERSION = "bea-artifact-template-v1";

export const BEA_CHART_PALETTE = Object.freeze([
  "#08304A",
  "#4AA346",
  "#1769AA",
  "#6F8797",
  "#8ABF86",
  "#9BBBCB",
] as const);

export const BEA_ARTIFACT_THEME = Object.freeze({
  background: "#FFFFFF",
  surface: "#F3F8FA",
  grid: "#DCE7EC",
  ink: "#0A2538",
  mutedInk: "#526875",
  navy: "#08304A",
  green: "#4AA346",
  blue: "#1769AA",
  fontFamily: "Inter, Segoe UI, Arial, sans-serif",
  palette: BEA_CHART_PALETTE,
});

export function artifactBrandMetadata(renderer: ArtifactRenderer): ArtifactBrandMetadata {
  return {
    organization: "Cyber Pirate Labs",
    policyVersion: ARTIFACT_BRAND_POLICY_VERSION,
    templateVersion: ARTIFACT_TEMPLATE_VERSION,
    theme: "cpl-light-premium",
    renderer,
    logoPath: "/brand/cpl-logo.png",
    palette: BEA_CHART_PALETTE,
    normalizedByApplication: true,
  };
}
