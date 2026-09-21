import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  applySourceMapping,
  assertArtifactSafeToSave,
  assertStagingSourceSize,
  buildReportDocument,
  compareMappingProfiles,
  compareReportTemplates,
  ConfigurationValidationError,
  defaultReviewPolicy,
  evaluateValidationRules,
  hashRawSourceText,
  MAX_STAGING_SOURCE_BYTES,
  parseStagingSource,
  ProductionMappingNotConfiguredError,
  StagingSourceTooLargeError,
  SYNTHETIC_ALTERNATE_COLLECTION_FIXTURE,
  SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE,
  SYNTHETIC_EXTERIOR_JSON_FIXTURE,
  SYNTHETIC_EXTERIOR_PACKAGE,
  SYNTHETIC_MOISTURE_CSV_FIXTURE,
  SYNTHETIC_MOISTURE_PACKAGE,
  validateBoundPackage,
  DEMO_ROLE_IDS,
} from "../../packages/domain/src/index.js";
import { renderReportDocumentToPdf } from "../../packages/automation/src/configurable-report-renderer.js";
import { PERMISSIONS, authorize } from "../../packages/security/src/index.js";

describe("Phase 3.1A configuration engines", () => {
  it("maps two synthetic families through the same engine without fixture-id branches", () => {
    const exterior = applySourceMapping(
      SYNTHETIC_EXTERIOR_JSON_FIXTURE,
      SYNTHETIC_EXTERIOR_PACKAGE.mapping,
      SYNTHETIC_EXTERIOR_PACKAGE.schema,
    );
    const moistureParsed = parseStagingSource("csv", SYNTHETIC_MOISTURE_CSV_FIXTURE);
    const moisture = applySourceMapping(
      moistureParsed.source,
      SYNTHETIC_MOISTURE_PACKAGE.mapping,
      SYNTHETIC_MOISTURE_PACKAGE.schema,
    );
    expect(exterior.canonical.fields.client_name).toBeTruthy();
    expect(moisture.canonical.fields.client_name).toBeTruthy();
    expect(exterior.unmappedSourceFields).toContain("unused_source_note");
    expect(validateBoundPackage(SYNTHETIC_EXTERIOR_PACKAGE).passed).toBe(true);
    expect(validateBoundPackage(SYNTHETIC_MOISTURE_PACKAGE).passed).toBe(true);
  });

  it("renders configuration-driven report documents with different filenames", () => {
    const exteriorMapped = applySourceMapping(
      SYNTHETIC_EXTERIOR_JSON_FIXTURE,
      SYNTHETIC_EXTERIOR_PACKAGE.mapping,
      SYNTHETIC_EXTERIOR_PACKAGE.schema,
    );
    const moistureMapped = applySourceMapping(
      parseStagingSource("csv", SYNTHETIC_MOISTURE_CSV_FIXTURE).source,
      SYNTHETIC_MOISTURE_PACKAGE.mapping,
      SYNTHETIC_MOISTURE_PACKAGE.schema,
    );
    const exteriorDoc = buildReportDocument({
      template: SYNTHETIC_EXTERIOR_PACKAGE.template,
      record: exteriorMapped.canonical,
      schema: SYNTHETIC_EXTERIOR_PACKAGE.schema,
      mapping: SYNTHETIC_EXTERIOR_PACKAGE.mapping,
      ruleSet: SYNTHETIC_EXTERIOR_PACKAGE.validation,
      configurationReleaseId: SYNTHETIC_EXTERIOR_PACKAGE.release.id,
      configurationReleaseVersion: 1,
      inspectionReference: "BEA-IN-EXT",
      reportReference: "BEA-RP-EXT",
      projectReference: "BEA-PR-EXT",
    });
    const moistureDoc = buildReportDocument({
      template: SYNTHETIC_MOISTURE_PACKAGE.template,
      record: moistureMapped.canonical,
      schema: SYNTHETIC_MOISTURE_PACKAGE.schema,
      mapping: SYNTHETIC_MOISTURE_PACKAGE.mapping,
      ruleSet: SYNTHETIC_MOISTURE_PACKAGE.validation,
      configurationReleaseId: SYNTHETIC_MOISTURE_PACKAGE.release.id,
      configurationReleaseVersion: 1,
      inspectionReference: "BEA-IN-MOI",
      reportReference: "BEA-RP-MOI",
      projectReference: "BEA-PR-MOI",
    });
    expect(exteriorDoc.filename).toContain("BEA-SYN-EXT");
    expect(moistureDoc.filename).toContain("BEA-SYN-MOI");
    expect(exteriorDoc.nodes.some((node) => node.kind === "photo_grid")).toBe(true);
    expect(
      moistureDoc.nodes.some((node) => node.kind === "table" || node.kind === "evidence_block"),
    ).toBe(true);
    const first = renderReportDocumentToPdf(exteriorDoc, "2026-09-01T00:00:00.000Z");
    const second = renderReportDocumentToPdf(exteriorDoc, "2026-09-01T00:00:00.000Z");
    expect(first.checksumSha256).toBe(second.checksumSha256);
    expect(
      compareReportTemplates(
        SYNTHETIC_EXTERIOR_PACKAGE.template,
        SYNTHETIC_MOISTURE_PACKAGE.template,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      compareMappingProfiles(SYNTHETIC_EXTERIOR_PACKAGE.mapping, SYNTHETIC_MOISTURE_PACKAGE.mapping)
        .length,
    ).toBeGreaterThan(0);
  });

  it("keeps warnings from blocking and quarantines unsupported formats", () => {
    const mapped = applySourceMapping(
      parseStagingSource("csv", SYNTHETIC_MOISTURE_CSV_FIXTURE).source,
      SYNTHETIC_MOISTURE_PACKAGE.mapping,
      SYNTHETIC_MOISTURE_PACKAGE.schema,
    );
    const result = evaluateValidationRules(mapped.canonical, SYNTHETIC_MOISTURE_PACKAGE.validation);
    expect(result.blocking.every((item) => item.blocking)).toBe(true);
    const quarantined = parseStagingSource("pdf", "%PDF-fake");
    expect(quarantined.quarantined).toBe(true);
    const scripted = parseStagingSource("json", '{"x":"<script>alert(1)</script>"}');
    expect(scripted.warnings.some((item) => /script/i.test(item))).toBe(true);
  });

  it("keeps configuration RBAC deny-by-default", () => {
    const owner = { roleIds: [DEMO_ROLE_IDS.OWNER_ADMIN] };
    const sales = { roleIds: [DEMO_ROLE_IDS.SALES] };
    const operations = { roleIds: [DEMO_ROLE_IDS.OPERATIONS] };
    const integration = { roleIds: [DEMO_ROLE_IDS.INTEGRATION_ADMIN] };
    expect(authorize(owner, PERMISSIONS.CONFIGURATION_ACTIVATE)).toEqual({ allowed: true });
    expect(authorize(sales, PERMISSIONS.CONFIGURATION_VIEW)).toMatchObject({ allowed: false });
    expect(authorize(operations, PERMISSIONS.CONFIGURATION_VIEW)).toEqual({ allowed: true });
    expect(authorize(operations, PERMISSIONS.CONFIGURATION_PUBLISH)).toMatchObject({
      allowed: false,
    });
    expect(authorize(integration, PERMISSIONS.CONFIGURATION_DRAFT)).toEqual({ allowed: true });
    expect(authorize(integration, PERMISSIONS.CONFIGURATION_ACTIVATE)).toMatchObject({
      allowed: false,
    });
    expect(authorize(integration, PERMISSIONS.CONFIGURATION_POLICY_APPROVE)).toMatchObject({
      allowed: false,
    });
    expect(authorize(integration, PERMISSIONS.CONFIGURATION_PUBLISH)).toMatchObject({
      allowed: false,
    });
    expect(authorize(owner, PERMISSIONS.CONFIGURATION_POLICY_APPROVE)).toEqual({ allowed: true });
  });

  it("hashes the complete UTF-8 source and distinguishes shared prefixes", () => {
    const prefix = "x".repeat(12_000);
    const left = `${prefix}-alpha`;
    const right = `${prefix}-beta`;
    const hashedLeft = hashRawSourceText(left);
    const hashedRight = hashRawSourceText(right);
    expect(hashedLeft.sha256).not.toBe(hashedRight.sha256);
    expect(hashedLeft.byteLength).toBe(new TextEncoder().encode(left).byteLength);
    expect(hashRawSourceText('{"a":1}').sha256).not.toBe(hashRawSourceText('{ "a": 1 }').sha256);
    const csv = SYNTHETIC_MOISTURE_CSV_FIXTURE + "extra-row-not-in-prefix\n";
    expect(hashRawSourceText(csv).sha256).toBe(hashRawSourceText(csv).sha256);
    expect(hashRawSourceText("abc").sha256).toBe(
      createHash("sha256").update("abc", "utf8").digest("hex"),
    );
    expect(hashRawSourceText(left).sha256).toBe(
      createHash("sha256").update(left, "utf8").digest("hex"),
    );
    expect(() => assertStagingSourceSize("a".repeat(MAX_STAGING_SOURCE_BYTES))).not.toThrow();
    expect(() => assertStagingSourceSize("a".repeat(MAX_STAGING_SOURCE_BYTES + 1))).toThrow(
      StagingSourceTooLargeError,
    );
  });

  it("maps alternate collection roots without hardcoded engine source names", async () => {
    const engineSource = await readFile(
      new URL("../../packages/domain/src/configuration-engines.ts", import.meta.url),
      "utf8",
    );
    expect(engineSource).not.toMatch(/["']observations["']/u);
    expect(engineSource).not.toMatch(/["']images["']/u);
    expect(engineSource).not.toMatch(/["']signoff["']/u);
    expect(engineSource).not.toMatch(/\breadings\b/u);
    const mapped = applySourceMapping(
      SYNTHETIC_ALTERNATE_COLLECTION_FIXTURE,
      SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.mapping,
      SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.schema,
    );
    expect(mapped.canonical.findings).toHaveLength(2);
    expect(mapped.canonical.findings.map((item) => item.code).sort()).toEqual(["OBS-1", "OBS-2"]);
    const photos = mapped.canonical.evidence.filter((item) => item.kind === "photo");
    expect(photos).toHaveLength(2);
    expect(photos.every((item) => item.findingCode === "OBS-1")).toBe(true);
    expect(mapped.canonical.evidence.some((item) => item.kind === "signature")).toBe(true);
    expect(mapped.canonical.groups.meter_readings).toHaveLength(1);
    expect(mapped.blockingIssues).toEqual([]);
    const missing = applySourceMapping(
      {
        inspection: {
          client: "A",
          site: "B",
          inspector: "C",
          completed_at: "2026-08-31T00:00:00.000Z",
          attestation: true,
        },
      },
      SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.mapping,
      SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.schema,
    );
    expect(
      missing.blockingIssues.some((item) => item.code === "mapping.required_collection_missing"),
    ).toBe(true);
    const optionalMissing = applySourceMapping(
      {
        job: { client: "Northstar Facade Group", site: "Northstar Tower" },
        inspector: { name: "Operations Coordinator" },
        completed_at: "2026-08-31T14:30:00.000Z",
        weather: "Clear",
        elevation: "South",
        attestation: true,
        findings: SYNTHETIC_EXTERIOR_JSON_FIXTURE.findings,
        photos: SYNTHETIC_EXTERIOR_JSON_FIXTURE.photos,
        signature: SYNTHETIC_EXTERIOR_JSON_FIXTURE.signature,
      },
      SYNTHETIC_EXTERIOR_PACKAGE.mapping,
      SYNTHETIC_EXTERIOR_PACKAGE.schema,
    );
    expect(
      optionalMissing.blockingIssues.filter((item) => item.canonicalField === "summary"),
    ).toHaveLength(0);
  });

  it("enforces required sources and CSV row modes without discarding rows", () => {
    const requiredMissing = applySourceMapping(
      { job: { site: "X" } },
      SYNTHETIC_EXTERIOR_PACKAGE.mapping,
      SYNTHETIC_EXTERIOR_PACKAGE.schema,
    );
    expect(
      requiredMissing.blockingIssues.some(
        (item) => item.code === "mapping.required_source_missing" && item.ruleKey === "client",
      ),
    ).toBe(true);
    const oneRow = parseStagingSource("csv", SYNTHETIC_MOISTURE_CSV_FIXTURE, {
      csvRowMode: "single_record",
    });
    expect(oneRow.quarantined).toBe(false);
    expect(oneRow.rowCount).toBe(1);
    const twoRowCsv = `${SYNTHETIC_MOISTURE_CSV_FIXTURE.trim()}\nHarborview Property Partners,Harborview Plaza,Operations Coordinator,2026-08-31T14:30:00.000Z,62,48,West wall,18.2,Ceiling cavity,22.4,MOI-1,Elevated moisture,Meter reading indicates elevated moisture at the west wall.,west-wall.jpg,cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc,West wall meter,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,true\n`;
    const blocked = parseStagingSource("csv", twoRowCsv, { csvRowMode: "single_record" });
    expect(blocked.quarantined).toBe(true);
    expect(blocked.rowCount).toBe(2);
    expect(blocked.warnings.join(" ")).toMatch(/2 row/i);
    expect(blocked.warnings.join(" ")).not.toMatch(/ignored/i);
    const collected = parseStagingSource("csv", twoRowCsv, { csvRowMode: "record_collection" });
    expect(collected.quarantined).toBe(false);
    expect(collected.rowCount).toBe(2);
    expect(Array.isArray(collected.source.rows)).toBe(true);
    const collectionProfile = {
      ...SYNTHETIC_MOISTURE_PACKAGE.mapping,
      csvRowMode: "record_collection" as const,
      csvScalarStrategy: "all_rows_must_match" as const,
      collections: [
        {
          collectionKey: "csv_rows",
          collectionKind: "repeatable_group" as const,
          sourcePath: "rows",
          cardinality: "many" as const,
          destinationGroupKey: "moisture_readings",
          requiredSource: true,
          emptyBehavior: "block" as const,
          itemBindings: [
            {
              destination: "location",
              sourcePath: "reading1_location",
              transforms: [],
              required: true,
            },
            {
              destination: "percent",
              sourcePath: "reading1_pct",
              transforms: [{ kind: "parse_decimal" as const }],
              required: true,
            },
          ],
        },
      ],
    };
    const mappedRows = applySourceMapping(
      collected.source,
      collectionProfile,
      SYNTHETIC_MOISTURE_PACKAGE.schema,
    );
    expect(mappedRows.canonical.groups.moisture_readings).toHaveLength(2);
    expect(hashRawSourceText(twoRowCsv).sha256).not.toBe(
      hashRawSourceText(SYNTHETIC_MOISTURE_CSV_FIXTURE).sha256,
    );
  });

  it("fails closed on unknown validation kinds and incomplete reviewer context", () => {
    expect(() =>
      assertArtifactSafeToSave("validation_rule_set", {
        ...SYNTHETIC_EXTERIOR_PACKAGE.validation,
        rules: [
          {
            ruleKey: "bad",
            label: "Bad",
            description: "Unknown",
            severity: "blocking",
            blocking: true,
            sectionKey: "site",
            trigger: { kind: "always" },
            expression: { kind: "llm_judge" },
            remediation: "Do not use this.",
          },
        ],
      }),
    ).toThrow(ConfigurationValidationError);
    const mapped = applySourceMapping(
      SYNTHETIC_EXTERIOR_JSON_FIXTURE,
      SYNTHETIC_EXTERIOR_PACKAGE.mapping,
      SYNTHETIC_EXTERIOR_PACKAGE.schema,
    );
    const withRole = {
      ...SYNTHETIC_EXTERIOR_PACKAGE.validation,
      rules: [
        ...SYNTHETIC_EXTERIOR_PACKAGE.validation.rules,
        {
          ruleKey: "reviewer_role",
          label: "Reviewer role",
          description: "Reviewer role must match.",
          severity: "blocking" as const,
          blocking: true,
          sectionKey: "fieldwork",
          trigger: { kind: "always" as const },
          expression: { kind: "required_reviewer_role" as const, role: "operations" },
          remediation: "Assign an operations reviewer.",
        },
      ],
    };
    const absent = evaluateValidationRules(mapped.canonical, withRole);
    expect(absent.passed).toBe(false);
    const wrong = evaluateValidationRules(mapped.canonical, withRole, { reviewerRole: "sales" });
    expect(wrong.passed).toBe(false);
    const ok = evaluateValidationRules(mapped.canonical, withRole, { reviewerRole: "operations" });
    expect(ok.blocking.some((item) => item.ruleKey === "reviewer_role")).toBe(false);
    expect(() =>
      evaluateValidationRules(mapped.canonical, {
        ...withRole,
        rules: [
          {
            ruleKey: "injected",
            label: "Injected",
            description: "Unknown kind injected after load.",
            severity: "blocking",
            blocking: true,
            sectionKey: "site",
            trigger: { kind: "always" },
            expression: { kind: "not_a_real_kind" } as never,
            remediation: "Remove it.",
          },
        ],
      }),
    ).toThrow(ConfigurationValidationError);
  });

  it("rejects the configuration validation matrix without publishing", () => {
    const saveProbes: Array<{
      kind:
        | "mapping_profile"
        | "inspection_schema"
        | "validation_rule_set"
        | "report_template"
        | "sla_policy"
        | "review_policy"
        | "delivery_policy";
      payload: unknown;
    }> = [
      {
        kind: "mapping_profile",
        payload: { ...SYNTHETIC_EXTERIOR_PACKAGE.mapping, rules: undefined },
      },
      {
        kind: "mapping_profile",
        payload: { ...SYNTHETIC_EXTERIOR_PACKAGE.mapping, rules: "not-array" },
      },
      {
        kind: "inspection_schema",
        payload: {
          ...SYNTHETIC_EXTERIOR_PACKAGE.schema,
          fields: [
            ...SYNTHETIC_EXTERIOR_PACKAGE.schema.fields,
            SYNTHETIC_EXTERIOR_PACKAGE.schema.fields[0],
          ],
        },
      },
      {
        kind: "inspection_schema",
        payload: {
          ...SYNTHETIC_EXTERIOR_PACKAGE.schema,
          sections: [
            ...SYNTHETIC_EXTERIOR_PACKAGE.schema.sections,
            SYNTHETIC_EXTERIOR_PACKAGE.schema.sections[0],
          ],
        },
      },
      {
        kind: "mapping_profile",
        payload: {
          ...SYNTHETIC_EXTERIOR_PACKAGE.mapping,
          rules: [{ ...SYNTHETIC_EXTERIOR_PACKAGE.mapping.rules[0], sourcePath: "" }],
        },
      },
      {
        kind: "mapping_profile",
        payload: {
          ...SYNTHETIC_EXTERIOR_PACKAGE.mapping,
          rules: [{ ...SYNTHETIC_EXTERIOR_PACKAGE.mapping.rules[0], sourcePath: "__proto__.x" }],
        },
      },
      {
        kind: "mapping_profile",
        payload: {
          ...SYNTHETIC_EXTERIOR_PACKAGE.mapping,
          rules: [
            {
              ...SYNTHETIC_EXTERIOR_PACKAGE.mapping.rules[0],
              transforms: [{ kind: "concat", sources: ["__proto__.x"] }],
            },
          ],
        },
      },
      {
        kind: "mapping_profile",
        payload: {
          ...SYNTHETIC_EXTERIOR_PACKAGE.mapping,
          rules: [
            { ...SYNTHETIC_EXTERIOR_PACKAGE.mapping.rules[0], transforms: [{ kind: "eval_js" }] },
          ],
        },
      },
      {
        kind: "mapping_profile",
        payload: {
          ...SYNTHETIC_EXTERIOR_PACKAGE.mapping,
          rules: [
            {
              ...SYNTHETIC_EXTERIOR_PACKAGE.mapping.rules[0],
              transforms: [{ kind: "unit_conversion" }],
            },
          ],
        },
      },
      {
        kind: "validation_rule_set",
        payload: {
          ...SYNTHETIC_EXTERIOR_PACKAGE.validation,
          rules: [
            {
              ...SYNTHETIC_EXTERIOR_PACKAGE.validation.rules[0],
              expression: { kind: "unknown_kind" },
            },
          ],
        },
      },
      {
        kind: "report_template",
        payload: {
          ...SYNTHETIC_EXTERIOR_PACKAGE.template,
          sections: [
            { key: "x", title: "X", displayOrder: 1, nodes: [{ kind: "javascript", key: "x" }] },
          ],
        },
      },
      {
        kind: "report_template",
        payload: { ...SYNTHETIC_EXTERIOR_PACKAGE.template, rendererAdapter: "docx" },
      },
      {
        kind: "sla_policy",
        payload: { ...SYNTHETIC_EXTERIOR_PACKAGE.sla, targetMinutes: -1 },
      },
      {
        kind: "sla_policy",
        payload: {
          ...SYNTHETIC_EXTERIOR_PACKAGE.sla,
          warningThresholdMinutes: 100,
          breachThresholdMinutes: 10,
        },
      },
      {
        kind: "sla_policy",
        payload: { ...SYNTHETIC_EXTERIOR_PACKAGE.sla, workdays: [9] },
      },
      {
        kind: "sla_policy",
        payload: {
          ...SYNTHETIC_EXTERIOR_PACKAGE.sla,
          workdayStartMinute: 800,
          workdayEndMinute: 100,
        },
      },
      {
        kind: "review_policy",
        payload: Object.fromEntries(
          Object.entries(defaultReviewPolicy()).filter(([key]) => key !== "deliveryAuthorizerRole"),
        ),
      },
      {
        kind: "review_policy",
        payload: { ...defaultReviewPolicy(), selfReviewPermitted: "yes" },
      },
      {
        kind: "delivery_policy",
        payload: { ...SYNTHETIC_EXTERIOR_PACKAGE.delivery, deliveryAuthorizerRole: "operations" },
      },
    ];
    for (const probe of saveProbes) {
      expect(() => assertArtifactSafeToSave(probe.kind, probe.payload)).toThrow(
        ConfigurationValidationError,
      );
    }
    const ghostMapping = validateBoundPackage({
      ...SYNTHETIC_EXTERIOR_PACKAGE,
      mapping: {
        ...SYNTHETIC_EXTERIOR_PACKAGE.mapping,
        rules: [
          ...SYNTHETIC_EXTERIOR_PACKAGE.mapping.rules,
          {
            ...SYNTHETIC_EXTERIOR_PACKAGE.mapping.rules[0],
            ruleKey: "ghost",
            canonicalField: "not_a_field",
          },
        ],
      },
    });
    expect(ghostMapping.passed).toBe(false);
    expect(
      ghostMapping.issues.some((item) => item.code === "mapping.unknown_canonical_field"),
    ).toBe(true);
    const missingValidationField = validateBoundPackage({
      ...SYNTHETIC_EXTERIOR_PACKAGE,
      validation: {
        ...SYNTHETIC_EXTERIOR_PACKAGE.validation,
        rules: [
          ...SYNTHETIC_EXTERIOR_PACKAGE.validation.rules,
          {
            ...SYNTHETIC_EXTERIOR_PACKAGE.validation.rules[0],
            ruleKey: "ghost-field",
            expression: { kind: "required", field: "missing_field" },
          },
        ],
      },
    });
    expect(missingValidationField.passed).toBe(false);
    expect(
      missingValidationField.issues.some((item) => item.code === "validation.unknown_field"),
    ).toBe(true);
    const missingTemplateField = validateBoundPackage({
      ...SYNTHETIC_EXTERIOR_PACKAGE,
      template: {
        ...SYNTHETIC_EXTERIOR_PACKAGE.template,
        sections: [
          {
            key: "ghost-section",
            title: "Ghost",
            displayOrder: 99,
            nodes: [{ kind: "label_value", key: "ghost-node", fieldKey: "nope" }],
          },
        ],
      },
    });
    expect(missingTemplateField.passed).toBe(false);
    expect(missingTemplateField.issues.some((item) => item.code === "template.unknown_field")).toBe(
      true,
    );
    const missingTemplateGroup = validateBoundPackage({
      ...SYNTHETIC_EXTERIOR_PACKAGE,
      template: {
        ...SYNTHETIC_EXTERIOR_PACKAGE.template,
        sections: [
          {
            key: "ghost-group-section",
            title: "Ghost group",
            displayOrder: 100,
            nodes: [{ kind: "table", key: "ghost-table", groupKey: "not_a_group", columns: ["a"] }],
          },
        ],
      },
    });
    expect(missingTemplateGroup.passed).toBe(false);
    expect(missingTemplateGroup.issues.some((item) => item.code === "template.unknown_group")).toBe(
      true,
    );
    const inconsistent = validateBoundPackage({
      ...SYNTHETIC_EXTERIOR_PACKAGE,
      release: { ...SYNTHETIC_EXTERIOR_PACKAGE.release, synthetic: false },
    });
    expect(inconsistent.passed).toBe(false);
    expect(
      inconsistent.issues.some((item) => item.code === "release.synthetic_inconsistency"),
    ).toBe(true);
    const mixedArtifact = validateBoundPackage({
      ...SYNTHETIC_EXTERIOR_PACKAGE,
      mapping: { ...SYNTHETIC_EXTERIOR_PACKAGE.mapping, synthetic: false },
    });
    expect(mixedArtifact.passed).toBe(false);
    expect(
      mixedArtifact.issues.some((item) => item.code === "release.synthetic_inconsistency"),
    ).toBe(true);
    expect(() =>
      applySourceMapping(
        SYNTHETIC_EXTERIOR_JSON_FIXTURE,
        { ...SYNTHETIC_EXTERIOR_PACKAGE.mapping, synthetic: false },
        SYNTHETIC_EXTERIOR_PACKAGE.schema,
      ),
    ).toThrow(ProductionMappingNotConfiguredError);
    const official = buildReportDocument({
      template: {
        ...SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.template,
        filenamePattern: "OFFICIAL-{reportRef}-{inspectionRef}-{projectRef}.pdf",
      },
      record: applySourceMapping(
        SYNTHETIC_ALTERNATE_COLLECTION_FIXTURE,
        SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.mapping,
        SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.schema,
      ).canonical,
      schema: SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.schema,
      mapping: SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.mapping,
      ruleSet: SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.validation,
      configurationReleaseId: "rel-1",
      configurationReleaseVersion: 1,
      inspectionReference: "BEA-IN-000001",
      reportReference: "BEA-RP-000001",
      projectReference: "BEA-PR-000001",
    });
    expect(official.filename).toBe("OFFICIAL-BEA-RP-000001-BEA-IN-000001-BEA-PR-000001.pdf");
    expect(official.reportReference).toBe("BEA-RP-000001");
    expect(official.preview).toBe(false);
    const first = renderReportDocumentToPdf(official, "2026-09-01T00:00:00.000Z");
    const second = renderReportDocumentToPdf(official, "2026-09-01T00:00:00.000Z");
    expect(first.checksumSha256).toBe(second.checksumSha256);
    expect(renderReportDocumentToPdf(official, "2026-09-02T00:00:00.000Z").checksumSha256).not.toBe(
      first.checksumSha256,
    );
  });
});
