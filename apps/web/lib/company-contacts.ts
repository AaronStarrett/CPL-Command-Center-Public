import "server-only";

import type { BeaServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";

export interface CompanyContactOption {
  readonly id: string;
  readonly label: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isCanonicalUuid(value: string): boolean {
  return value.length === 36 && UUID_PATTERN.test(value);
}

export type TaskRelationshipIdentifierValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "invalid-company" | "invalid-contact";
      readonly field: "companyId" | "contactId";
      readonly message: string;
    };

export function validateTaskRelationshipIdentifiers(
  companyId: string | null,
  contactId: string | null,
): TaskRelationshipIdentifierValidation {
  if (contactId && !companyId) {
    return {
      ok: false,
      code: "invalid-contact",
      field: "contactId",
      message: "Select a company before linking a contact.",
    };
  }
  if (companyId && !isCanonicalUuid(companyId)) {
    return {
      ok: false,
      code: "invalid-company",
      field: "companyId",
      message: "The linked company is invalid.",
    };
  }
  if (contactId && !isCanonicalUuid(contactId)) {
    return {
      ok: false,
      code: "invalid-contact",
      field: "contactId",
      message: "The linked contact is invalid.",
    };
  }
  return { ok: true };
}

export type PermissionAwareCompanyContactsResult =
  | {
      readonly ok: true;
      readonly companyId: string;
      readonly contacts: readonly CompanyContactOption[];
    }
  | {
      readonly ok: false;
      readonly status: 403;
      readonly code: "permission-not-granted";
      readonly message: string;
      readonly reason: string;
    }
  | {
      readonly ok: false;
      readonly status: 400;
      readonly code: "invalid-company";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly status: 404;
      readonly code: "company-not-found";
      readonly message: string;
    };

export async function getPermissionAwareCompanyContacts(
  runtime: BeaServerRuntime,
  userId: string,
  companyId: string,
): Promise<PermissionAwareCompanyContactsResult> {
  const [companyAccess, contactAccess] = await Promise.all([
    runtime.authorization.authorizeUser(userId, PERMISSIONS.COMPANIES_VIEW),
    runtime.authorization.authorizeUser(userId, PERMISSIONS.CONTACTS_VIEW),
  ]);
  if (!companyAccess.allowed) {
    return {
      ok: false,
      status: 403,
      code: "permission-not-granted",
      message: "The current role cannot list company contacts.",
      reason: companyAccess.reason,
    };
  }
  if (!contactAccess.allowed) {
    return {
      ok: false,
      status: 403,
      code: "permission-not-granted",
      message: "The current role cannot list company contacts.",
      reason: contactAccess.reason,
    };
  }
  if (!isCanonicalUuid(companyId)) {
    return {
      ok: false,
      status: 400,
      code: "invalid-company",
      message: "The selected company is invalid.",
    };
  }
  const company = await runtime.phase1.getCompany(companyId);
  if (!company) {
    return {
      ok: false,
      status: 404,
      code: "company-not-found",
      message: "The selected company is unavailable.",
    };
  }
  const contacts = await runtime.phase1.listContacts({ companyId: company.id, limit: 250 });
  return {
    ok: true,
    companyId: company.id,
    contacts: contacts.map((contact) => ({
      id: contact.id,
      label: `${contact.firstName} ${contact.lastName}`.trim(),
    })),
  };
}
