import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { validateTaskRelationshipIdentifiers } from "../../apps/web/lib/company-contacts.js";

describe("task relationship API identifiers", () => {
  it("rejects malformed task relationship UUIDs before repository lookup", () => {
    expect(validateTaskRelationshipIdentifiers("not-a-uuid", null)).toEqual({
      ok: false,
      code: "invalid-company",
      field: "companyId",
      message: "The linked company is invalid.",
    });
    expect(
      validateTaskRelationshipIdentifiers(
        "90000000-0000-4000-8000-000000000001",
        "not-a-contact-uuid",
      ),
    ).toEqual({
      ok: false,
      code: "invalid-contact",
      field: "contactId",
      message: "The linked contact is invalid.",
    });
  });
});
