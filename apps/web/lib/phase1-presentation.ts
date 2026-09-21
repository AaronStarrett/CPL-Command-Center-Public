import type { StatusTone } from "@bea/ui";

export function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("en-US") : "Not set";
}

export function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString("en-US") : "Not set";
}

export function statusTone(status: string): StatusTone {
  if (["active", "completed", "connected", "healthy", "succeeded"].includes(status)) {
    return "success";
  }
  if (["urgent", "failed", "unavailable", "inactive", "denied"].includes(status)) {
    return "danger";
  }
  if (["high", "open", "pending", "running", "degraded"].includes(status)) {
    return "warning";
  }
  if (["prospect", "simulated", "mock"].includes(status)) return "info";
  return "neutral";
}

export function displayContactName(contact: { firstName: string; lastName: string }): string {
  return `${contact.firstName} ${contact.lastName}`.trim();
}

export function safeText(value: string | null, fallback = "Not provided"): string {
  return value?.trim() || fallback;
}
