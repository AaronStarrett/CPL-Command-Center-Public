export const CONFIGURATION_STUDIO_LINKS = [
  { href: "/configuration", label: "Readiness" },
  { href: "/configuration/releases", label: "Releases" },
  { href: "/configuration/schemas", label: "Inspection schemas" },
  { href: "/configuration/mappings", label: "Mapping profiles" },
  { href: "/configuration/validation", label: "Validation rules" },
  { href: "/configuration/templates", label: "Report templates" },
  { href: "/configuration/policies", label: "Review, storage, delivery, SLA" },
  { href: "/configuration/lab", label: "Synthetic lab" },
  { href: "/configuration/catalog", label: "Service catalog" },
  { href: "/configuration/intake", label: "Thursday intake" },
] as const;

export function configurationStatusLabel(status: string): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "validation_failed":
      return "Validation failed";
    case "validated":
      return "Validated";
    case "published":
      return "Published";
    case "active":
      return "Active";
    case "superseded":
      return "Superseded";
    case "archived":
      return "Archived";
    case "unknown":
      return "Unknown";
    case "assumed_for_demo":
      return "Assumed for demo";
    case "awaiting_bea_confirmation":
      return "Awaiting BEA confirmation";
    case "confirmed":
      return "Confirmed";
    case "configured":
      return "Configured";
    case "tested":
      return "Tested";
    case "approved":
      return "Approved";
    default:
      return status;
  }
}

export function configurationStatusTone(
  status: string,
): "neutral" | "info" | "success" | "warning" | "danger" {
  if (status === "active" || status === "approved" || status === "configured") return "success";
  if (status === "published" || status === "validated" || status === "tested") return "info";
  if (status === "draft" || status === "assumed_for_demo" || status === "unknown") return "neutral";
  if (status === "validation_failed" || status === "awaiting_bea_confirmation") return "warning";
  return "danger";
}
