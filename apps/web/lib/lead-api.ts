import {
  LeadConcurrencyError,
  LeadDisqualificationReasonError,
  LeadReadinessError,
  LeadReadyStatusInvariantError,
  LeadRecordNotFoundError,
  LeadReviewerEligibilityError,
  LeadStatusTransitionError,
  LeadValidationError,
} from "@bea/database";
import { isLeadPartyRole, type LeadPartyInput } from "@bea/domain";

export function optionalLeadString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized || null : undefined;
}

export function optionalLeadDateTime(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function parseLeadParties(value: unknown): readonly LeadPartyInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const parties: LeadPartyInput[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return undefined;
    const record = entry as Record<string, unknown>;
    if (typeof record.role !== "string" || !isLeadPartyRole(record.role)) return undefined;
    const companyId = optionalLeadString(record.companyId, 36);
    const contactId = optionalLeadString(record.contactId, 36);
    const unmatchedCompanyName = optionalLeadString(record.unmatchedCompanyName, 240);
    const unmatchedContactName = optionalLeadString(record.unmatchedContactName, 240);
    const unmatchedEmail = optionalLeadString(record.unmatchedEmail, 240);
    const unmatchedPhone = optionalLeadString(record.unmatchedPhone, 64);
    const notes = optionalLeadString(record.notes ?? null, 4_000);
    if (
      companyId === undefined ||
      contactId === undefined ||
      unmatchedCompanyName === undefined ||
      unmatchedContactName === undefined ||
      unmatchedEmail === undefined ||
      unmatchedPhone === undefined ||
      notes === undefined
    ) {
      return undefined;
    }
    parties.push({
      role: record.role,
      companyId,
      contactId,
      unmatchedCompanyName,
      unmatchedContactName,
      unmatchedEmail,
      unmatchedPhone,
      notes,
    });
  }
  return parties;
}

export function leadMutationErrorStatus(
  error: unknown,
): { code: string; message: string; status: number } | null {
  if (error instanceof LeadValidationError) {
    return { code: "invalid-lead", message: error.message, status: 400 };
  }
  if (error instanceof LeadRecordNotFoundError) {
    return { code: "lead-not-found", message: error.message, status: 404 };
  }
  if (error instanceof LeadConcurrencyError) {
    return { code: "lead-conflict", message: error.message, status: 409 };
  }
  if (error instanceof LeadStatusTransitionError) {
    return { code: "invalid-lead-transition", message: error.message, status: 409 };
  }
  if (error instanceof LeadDisqualificationReasonError) {
    return { code: "disqualification-reason-required", message: error.message, status: 400 };
  }
  if (error instanceof LeadReadinessError) {
    return {
      code: "lead-not-ready",
      message: error.missing.map((item) => item.message).join(" "),
      status: 409,
    };
  }
  if (error instanceof LeadReadyStatusInvariantError) {
    return { code: "lead-ready-status-invariant", message: error.message, status: 409 };
  }
  if (error instanceof LeadReviewerEligibilityError) {
    return { code: "lead-reviewer-not-eligible", message: error.message, status: 400 };
  }
  return null;
}
