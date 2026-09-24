import { CPL_EXECUTION_TIME_ZONE, resolveCplLocalDateTime } from "./cpl-execution.js";
import type {
  FormBuiltin,
  FormField,
  FormInput,
  GmailConfiguration,
  GmailSelection,
  MappingInput,
  MappingRule,
  PublicInquiryInput,
} from "./cpl-integrations.js";
export type {
  InquiryForm,
  PublicInquiryForm,
  PublicInquiryInput,
  PublicReceipt,
  FormField,
  FormInput,
  FormBuiltin,
  MappingVersion,
  MappingInput,
  MappingRule,
  MappingSource,
  SourceReceiptSummary,
  SourceReceiptDetail,
  ReceiptState,
  Page,
  PageInput,
} from "./cpl-integrations.js";

export class CplInboundError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CplInboundError";
  }
}
export function inboundFail(code = "CPL_INBOUND_INVALID_INPUT"): never {
  throw new CplInboundError(code);
}
export function inboundObject(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) inboundFail();
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some(
      (key) =>
        ["__proto__", "prototype", "constructor"].includes(key) || (keys && !keys.includes(key)),
    )
  )
    inboundFail();
  return object;
}
export function inboundText(value: unknown, max: number, required = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
    inboundFail();
  const result = value.trim();
  if (required && !result) inboundFail();
  return result;
}
export function inboundId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value)
  )
    inboundFail();
  return value.toLowerCase();
}
export function inboundInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    inboundFail();
  return value as number;
}
export function inboundKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/u.test(value))
    inboundFail("CPL_INVALID_IDEMPOTENCY_KEY");
  return value;
}
export function inboundCanonical(value: unknown, depth = 0): string {
  if (depth > 16) inboundFail();
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => inboundCanonical(item, depth + 1)).join(",")}]`;
  const object = inboundObject(value);
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${inboundCanonical(object[key], depth + 1)}`)
    .join(",")}}`;
}
const builtins: readonly FormBuiltin[] = [
  "title",
  "contactName",
  "contactEmail",
  "contactPhone",
  "customerName",
  "siteName",
  "siteAddress",
  "details",
  "requestedDeadlineAt",
  "requestedVisitAt",
];
const fieldMaximum: Record<FormBuiltin, number> = {
  title: 240,
  contactName: 240,
  contactEmail: 254,
  contactPhone: 80,
  customerName: 240,
  siteName: 240,
  siteAddress: 2000,
  details: 20_000,
  requestedDeadlineAt: 10,
  requestedVisitAt: 10,
};
function target(value: unknown): FormField["target"] {
  const o = inboundObject(value, ["kind", "field", "fieldId"]);
  if (o.kind === "builtin" && builtins.includes(o.field as FormBuiltin) && o.fieldId === undefined)
    return { kind: "builtin", field: o.field as FormBuiltin };
  if (o.kind === "custom" && o.field === undefined)
    return { kind: "custom", fieldId: inboundId(o.fieldId) };
  return inboundFail();
}
function stringList(value: unknown, maxCount: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxCount) inboundFail();
  const result = value.map((item) => inboundText(item, maxLength, true));
  if (new Set(result).size !== result.length) inboundFail();
  return result;
}
function field(value: unknown): FormField {
  const o = inboundObject(value, [
    "key",
    "target",
    "label",
    "type",
    "required",
    "maxLength",
    "options",
  ]);
  if (typeof o.key !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(o.key)) inboundFail();
  if (
    !["text", "textarea", "email", "date", "boolean", "choice"].includes(String(o.type)) ||
    typeof o.required !== "boolean"
  )
    inboundFail();
  const destination = target(o.target);
  const type = o.type as FormField["type"];
  if (destination.kind === "builtin") {
    const expected =
      destination.field === "contactEmail"
        ? "email"
        : destination.field.startsWith("requested")
          ? "date"
          : null;
    if ((expected && type !== expected) || (!expected && type !== "text" && type !== "textarea"))
      inboundFail();
  }
  const options = stringList(o.options ?? [], 40, 240);
  if ((type === "choice" && options.length < 1) || (type !== "choice" && options.length !== 0))
    inboundFail();
  const textLike = type === "text" || type === "textarea" || type === "email";
  const maximum = destination.kind === "builtin" ? fieldMaximum[destination.field] : 2000;
  const maxLength = textLike ? inboundInteger(o.maxLength ?? maximum, 1, maximum) : null;
  if (!textLike && o.maxLength != null) inboundFail();
  return {
    key: o.key,
    target: destination,
    label: inboundText(o.label, 160, true),
    type,
    required: o.required,
    maxLength,
    options,
  };
}
export function normalizeCplInquiryForm(value: unknown): FormInput {
  const o = inboundObject(value, [
    "name",
    "title",
    "description",
    "fields",
    "publishedServiceIds",
    "confirmationText",
    "mappingId",
    "mappingVersion",
  ]);
  if (!Array.isArray(o.fields) || o.fields.length < 1 || o.fields.length > 32) inboundFail();
  const fields = o.fields.map(field);
  if (
    new Set(fields.map((f) => f.key)).size !== fields.length ||
    new Set(fields.map((f) => inboundCanonical(f.target))).size !== fields.length
  )
    inboundFail();
  if (!Array.isArray(o.publishedServiceIds) || o.publishedServiceIds.length > 30) inboundFail();
  const services = o.publishedServiceIds.map(inboundId);
  if (new Set(services).size !== services.length) inboundFail();
  return {
    name: inboundText(o.name, 160, true),
    title: inboundText(o.title, 240, true),
    description: inboundText(o.description ?? "", 2000),
    fields,
    publishedServiceIds: services,
    confirmationText: inboundText(
      o.confirmationText ?? "Your inquiry was received for review.",
      1000,
      true,
    ),
    mappingId: inboundId(o.mappingId),
    mappingVersion: inboundInteger(o.mappingVersion, 1, 1_000_000),
  };
}
function calendarDate(value: unknown): string {
  const text = inboundText(value, 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) inboundFail();
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text)
    inboundFail();
  return text;
}
export function normalizeCplPublicInquiry(
  value: unknown,
  form: FormInput,
  expectedVersion: number,
): PublicInquiryInput {
  const o = inboundObject(value, ["configurationVersion", "eventId", "values", "serviceId"]);
  const version = inboundInteger(o.configurationVersion, 1, 1_000_000);
  if (version !== expectedVersion) inboundFail("CPL_FORM_CONFIGURATION_CHANGED");
  const eventId = inboundKey(o.eventId);
  const supplied = inboundObject(
    o.values,
    form.fields.map((f) => f.key),
  );
  const values: PublicInquiryInput["values"] = {};
  for (const f of form.fields) {
    const v = supplied[f.key];
    if (v == null || v === "") {
      if (f.required) inboundFail("CPL_FORM_REQUIRED_FIELD");
      values[f.key] = null;
    } else if (f.type === "boolean") {
      if (typeof v !== "boolean") inboundFail();
      values[f.key] = v;
    } else {
      const text =
        f.type === "date" ? calendarDate(v) : inboundText(v, f.maxLength ?? 240, f.required);
      if (f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text)) inboundFail();
      if (f.type === "choice" && !f.options.includes(text)) inboundFail();
      values[f.key] = text;
    }
  }
  const serviceId = o.serviceId == null ? null : inboundId(o.serviceId);
  if (serviceId && !form.publishedServiceIds.includes(serviceId))
    inboundFail("CPL_FORM_SERVICE_UNAVAILABLE");
  return { configurationVersion: version, eventId, values, serviceId };
}
export function normalizeCplInboundMapping(value: unknown): MappingInput {
  const o = inboundObject(value, ["name", "sourceKind", "rules"]);
  if (
    !["form", "gmail"].includes(String(o.sourceKind)) ||
    !Array.isArray(o.rules) ||
    o.rules.length < 1 ||
    o.rules.length > 32
  )
    inboundFail();
  const rules: MappingRule[] = o.rules.map((value) => {
    const rule = inboundObject(value, ["source", "target", "transform"]);
    const source = inboundObject(rule.source, ["kind", "key", "field", "value"]);
    let from: MappingRule["source"];
    if (source.kind === "literal" && source.key === undefined && source.field === undefined)
      from = { kind: "literal", value: inboundText(source.value, 20_000) };
    else if (
      o.sourceKind === "form" &&
      source.kind === "form_field" &&
      source.value === undefined &&
      source.field === undefined &&
      typeof source.key === "string" &&
      /^[a-z][a-z0-9_]{0,63}$/u.test(source.key)
    )
      from = { kind: "form_field", key: source.key };
    else if (
      o.sourceKind === "gmail" &&
      source.kind === "gmail" &&
      source.value === undefined &&
      source.key === undefined &&
      ["subject", "senderNameClaim", "senderEmailClaim", "plainText"].includes(String(source.field))
    )
      from = {
        kind: "gmail",
        field: source.field as "subject" | "senderNameClaim" | "senderEmailClaim" | "plainText",
      };
    else return inboundFail();
    if (
      !["none", "trim", "collapse_whitespace", "lowercase_email"].includes(String(rule.transform))
    )
      inboundFail();
    const to = target(rule.target);
    if (
      rule.transform === "lowercase_email" &&
      (to.kind !== "builtin" || to.field !== "contactEmail")
    )
      inboundFail();
    return { source: from, target: to, transform: rule.transform as MappingRule["transform"] };
  });
  if (new Set(rules.map((r) => inboundCanonical(r.target))).size !== rules.length) inboundFail();
  return {
    name: inboundText(o.name, 160, true),
    sourceKind: o.sourceKind as "form" | "gmail",
    rules,
  };
}
export function applyCplInboundMapping(
  mapping: MappingInput,
  sample: Record<string, unknown>,
  timeZone = CPL_EXECUTION_TIME_ZONE,
) {
  const fields: Record<string, string | boolean | null> = {};
  const customValues: Record<string, string | boolean | null> = {};
  let dateOnlyTimeZone: string | null = null;
  for (const rule of mapping.rules) {
    let value: unknown =
      rule.source.kind === "literal"
        ? rule.source.value
        : sample[rule.source.kind === "form_field" ? rule.source.key : rule.source.field];
    if (value === undefined || value === null) value = null;
    else if (typeof value === "string") {
      value = inboundText(value, 20_000);
      if (rule.transform === "collapse_whitespace") value = (value as string).replace(/\s+/gu, " ");
      if (rule.transform === "lowercase_email") value = (value as string).toLowerCase();
    } else if (typeof value !== "boolean" || rule.transform !== "none")
      inboundFail("CPL_MAPPING_VALUE_INVALID");
    if (rule.target.kind === "custom")
      customValues[rule.target.fieldId] = value as string | boolean | null;
    else {
      if (typeof value === "boolean") inboundFail("CPL_MAPPING_VALUE_INVALID");
      if (typeof value === "string" && value.length > fieldMaximum[rule.target.field])
        inboundFail("CPL_MAPPING_VALUE_INVALID");
      if (
        typeof value === "string" &&
        value !== "" &&
        (rule.target.field === "requestedDeadlineAt" || rule.target.field === "requestedVisitAt")
      ) {
        // Date-only requests are represented as midnight in the configured company
        // zone, never the worker machine's zone. This is not a scheduled visit.
        // The exact source date remains immutable in the original receipt.
        try {
          value = resolveCplLocalDateTime(`${calendarDate(value)}T00:00`, timeZone)!.instant;
        } catch {
          inboundFail("CPL_MAPPING_VALUE_INVALID");
        }
        dateOnlyTimeZone = timeZone;
      }
      fields[rule.target.field] = value as string | null;
    }
  }
  return { fields, customValues, ...(dateOnlyTimeZone ? { dateOnlyTimeZone } : {}) };
}
export function normalizeCplGmailConfiguration(
  value: unknown,
  now = new Date(),
): GmailConfiguration {
  const o = inboundObject(value, ["displayName", "selection", "mappingId", "mappingVersion"]);
  let selection: GmailSelection | null = null;
  if (o.selection != null) {
    const s = inboundObject(o.selection, [
      "kind",
      "labelId",
      "labelName",
      "start",
      "cadenceMinutes",
    ]);
    if (
      s.kind !== "label" ||
      typeof s.labelId !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/u.test(s.labelId)
    )
      inboundFail();
    const start = inboundObject(s.start, ["kind", "after", "maxMessages"]);
    let policy: GmailSelection["start"];
    if (start.kind === "from_now" && start.after === undefined && start.maxMessages === undefined)
      policy = { kind: "from_now" };
    else if (start.kind === "bounded_backfill") {
      const text = inboundText(start.after, 40, true),
        date = new Date(text);
      if (
        !Number.isFinite(date.getTime()) ||
        date.getTime() > now.getTime() ||
        date.getTime() < now.getTime() - 90 * 86_400_000
      )
        inboundFail();
      policy = {
        kind: "bounded_backfill",
        after: date.toISOString(),
        maxMessages: inboundInteger(start.maxMessages, 1, 500),
      };
    } else return inboundFail();
    selection = {
      kind: "label",
      labelId: s.labelId,
      labelName: inboundText(s.labelName, 240, true),
      start: policy,
      cadenceMinutes: inboundInteger(s.cadenceMinutes, 5, 1440),
    };
  }
  if ((o.mappingId == null) !== (o.mappingVersion == null)) inboundFail();
  return {
    displayName: inboundText(o.displayName, 160, true),
    selection,
    mappingId: o.mappingId == null ? null : inboundId(o.mappingId),
    mappingVersion:
      o.mappingVersion == null ? null : inboundInteger(o.mappingVersion, 1, 1_000_000),
  };
}
