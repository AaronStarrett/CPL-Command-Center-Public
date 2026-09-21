import type { StatusTone } from "@bea/ui";

export function workflowStepTone(status: string): StatusTone {
  if (status === "succeeded") return "success";
  if (status === "degraded") return "warning";
  return "danger";
}
