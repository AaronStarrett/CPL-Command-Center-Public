import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeCplCompanyProfile,
  normalizeCplCatalogInput,
  normalizeCplIntakePolicy,
  normalizeCplIntakeCustomValues,
  cplConfiguredIntakeIssues,
  normalizeCplDirectoryInput,
} from "../../packages/domain/src/cpl-company";
import { normalizeCplLeadFields } from "../../packages/domain/src/cpl-intake";
describe("typed company configuration", () => {
  const profile = {
    displayName: "Fictional",
    legalName: "",
    email: "office@example.invalid",
    phone: "",
    address: "",
    timeZone: "America/Chicago",
  };
  it("validates actual timezones and contact shape", () => {
    expect(normalizeCplCompanyProfile(profile)).toEqual(profile);
    for (const patch of [{ timeZone: "invented/zone" }, { displayName: "" }, { email: "broken" }])
      expect(() => normalizeCplCompanyProfile({ ...profile, ...patch })).toThrow();
  });
  it("supports optional unpriced services and exact minor-unit prices only", () => {
    const service = {
      code: "inspection",
      name: "Inspection",
      description: "",
      unit: "visit",
      unitPriceMinor: null,
      currency: "CAD",
    };
    expect(normalizeCplCatalogInput(service)).toMatchObject({
      unitPriceMinor: null,
      workflowKey: "inspection",
    });
    for (const price of [-1, 0.1, Number.NaN, 1e12])
      expect(() => normalizeCplCatalogInput({ ...service, unitPriceMinor: price })).toThrow();
    expect(() => normalizeCplCatalogInput({ ...service, currency: "unknown" })).toThrow();
  });
  it("permits only the typed required-field extension instead of replacing core rules", () => {
    expect(normalizeCplIntakePolicy({ requiredFields: [], customFields: [] })).toEqual({
      requiredFields: [],
      customFields: [],
    });
    for (const requiredFields of [["arbitrarySQL"], ["contactEmail", "contactEmail"]])
      expect(() => normalizeCplIntakePolicy({ requiredFields, customFields: [] })).toThrow();
  });
  it("uses stable unique typed field identities and bounded choice options", () => {
    const f = {
      id: randomUUID(),
      label: "Access",
      type: "choice",
      options: ["Available", "Restricted"],
      required: true,
      active: true,
    };
    expect(
      normalizeCplIntakePolicy({ requiredFields: [], customFields: [f] }).customFields[0],
    ).toEqual(f);
    for (const customFields of [
      [f, f],
      [{ ...f, options: [] }],
      [{ ...f, type: "script" }],
      [{ ...f, type: "text" }],
    ])
      expect(() => normalizeCplIntakePolicy({ requiredFields: [], customFields })).toThrow();
  });
  it("keeps false as an answered boolean and blocks missing or invalid selected answers", () => {
    const id = randomUUID(),
      policy = normalizeCplIntakePolicy({
        requiredFields: ["contactEmail"],
        customFields: [
          { id, label: "Access", type: "boolean", options: [], required: true, active: true },
        ],
      });
    const values = normalizeCplIntakeCustomValues({ [id]: false }, policy);
    expect(values[id]).toBe(false);
    expect(
      cplConfiguredIntakeIssues(
        normalizeCplLeadFields({ title: "Scope", contactEmail: "contact@example.invalid" }),
        policy,
        values,
      ),
    ).toEqual([]);
    expect(() => normalizeCplIntakeCustomValues({ [id]: "false" }, policy)).toThrow();
    expect(() => normalizeCplIntakeCustomValues({ [randomUUID()]: "unknown" }, policy)).toThrow();
  });
  it("retains retired answers but refuses editing them under an inactive definition", () => {
    const id = randomUUID(),
      policy = normalizeCplIntakePolicy({
        requiredFields: [],
        customFields: [
          { id, label: "Historical", type: "text", options: [], required: false, active: false },
        ],
      });
    expect(normalizeCplIntakeCustomValues({}, policy, { [id]: "Retained" })).toEqual({
      [id]: "Retained",
    });
    expect(() => normalizeCplIntakeCustomValues({ [id]: "Changed" }, policy)).toThrow();
  });
  it("normalizes only kind-specific directory fields", () => {
    expect(
      normalizeCplDirectoryInput("customer", {
        name: "Customer",
        email: "ignored@example.invalid",
      }),
    ).toEqual({ name: "Customer", customerId: null, email: null, phone: "", address: "" });
    expect(() =>
      normalizeCplDirectoryInput("contact", { name: "Contact", email: "not-email" }),
    ).toThrow();
    expect(() =>
      normalizeCplDirectoryInput("customer", { name: "Customer", customerId: randomUUID() }),
    ).toThrow();
  });
});
