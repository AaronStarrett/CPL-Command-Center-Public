import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgSqlDatabaseAdapter } from "../../packages/database/src/pg-sql-adapter";
import { migrateDatabase } from "../../packages/database/src/migrations";
import { configureHostedRuntimeRole } from "../../packages/database/src/hosted-database-role";
import { SqlCplHostedAuthStore } from "../../packages/database/src/hosted-auth-store";
import { SqlCplTenantRepository } from "../../packages/database/src/tenant-repository";
import { SqlCplWorkflowRepository } from "../../packages/database/src/hosted-workflow";
import { SqlCplCommercialRepository } from "../../packages/database/src/cpl-commercial-repository";
import { SqlCplCompanyRepository } from "../../packages/database/src/cpl-company-repository";
import { SqlCplDeliveryRepository } from "../../packages/database/src/cpl-delivery-repository";
import { defaultCplCommercialBranding } from "../../packages/domain/src/cpl-commercial";
import { normalizeCplLeadFields } from "../../packages/domain/src/cpl-intake";

const material = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG_JSON,
  configPath = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
(material || configPath ? describe : describe.skip)(
  "company configuration and directory on isolated real PostgreSQL",
  () => {
    let control: PgSqlDatabaseAdapter,
      admin: PgSqlDatabaseAdapter,
      web: PgSqlDatabaseAdapter,
      auth: SqlCplHostedAuthStore,
      tenants: SqlCplTenantRepository,
      intake: SqlCplWorkflowRepository,
      commercial: SqlCplCommercialRepository,
      company: SqlCplCompanyRepository;
    const db = `cpl_company_test_${randomBytes(6).toString("hex")}`;
    let created = false;
    beforeAll(async () => {
      const c = JSON.parse(material ?? readFileSync(configPath!, "utf8"));
      for (const raw of [c.adminUrl, c.webUrl])
        if (!["127.0.0.1", "localhost"].includes(new URL(raw).hostname))
          throw Error("Local isolated PostgreSQL only");
      const connection = (raw: string) => {
        const u = new URL(raw);
        u.pathname = "/" + db;
        return u.href;
      };
      control = new PgSqlDatabaseAdapter({ connectionString: c.adminUrl, max: 1 });
      await control.execute(`CREATE DATABASE "${db}"`);
      created = true;
      admin = new PgSqlDatabaseAdapter({ connectionString: connection(c.adminUrl), max: 2 });
      await migrateDatabase(admin);
      await configureHostedRuntimeRole(admin, new URL(c.webUrl).username, "web");
      web = new PgSqlDatabaseAdapter({ connectionString: connection(c.webUrl), max: 3 });
      auth = new SqlCplHostedAuthStore(web);
      tenants = new SqlCplTenantRepository(web);
      intake = new SqlCplWorkflowRepository(web, tenants);
      commercial = new SqlCplCommercialRepository(tenants);
      company = new SqlCplCompanyRepository(tenants);
    }, 180000);
    afterAll(async () => {
      await web?.close();
      await admin?.close();
      if (created) await control.execute(`DROP DATABASE "${db}" WITH(FORCE)`);
      await control?.close();
    }, 60000);
    async function actor() {
      const raw = randomBytes(32).toString("base64url"),
        now = new Date().toISOString();
      const session = await auth.createSession({
        identity: {
          issuer: "https://accounts.google.com",
          subject: randomUUID(),
          email: "fictional@example.invalid",
          emailVerified: true,
          hostedDomain: null,
          displayName: "Fictional company operator",
          authenticatedAt: now,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
        material: {
          tokenHash: sha(raw),
          csrfTokenHash: sha(randomUUID()),
          expiresAt: new Date(Date.now() + 3500000).toISOString(),
          absoluteExpiresAt: new Date(Date.now() + 28000000).toISOString(),
        },
        now,
      });
      return { raw, session };
    }
    async function fixture() {
      const a = await actor(),
        org = await tenants.createOrganization(a.raw, {
          slug: randomUUID(),
          displayName: "Fictional Company",
        }),
        request = { organizationId: org.id, sessionToken: a.raw };
      await admin.query(
        "UPDATE cpl_module_entitlements SET enabled=TRUE,usage_limit=NULL WHERE organization_id=$1",
        [org.id],
      );
      return { a, org, request };
    }
    async function lead(
      f: Awaited<ReturnType<typeof fixture>>,
      extra: Record<string, unknown> = {},
    ) {
      return intake.createLead({
        ...f.request,
        title: "Fictional unique scope",
        contactName: "Fictional contact",
        customerName: "Fictional customer",
        details: "Confirmed scope",
        requestedService: "Fictional service",
        nextAction: "Review the scope",
        assignedMemberIdentityId: f.a.session.identityId,
        idempotencyKey: randomUUID(),
        ...extra,
      });
    }
    const directoryInput = (name: string, extra: Record<string, unknown> = {}) => ({
      name,
      customerId: null,
      email: null,
      phone: "",
      address: "",
      ...extra,
    });
    const service = (code: string) => ({
      code,
      name: `Service ${code}`,
      description: "Fictional service",
      unit: "hour",
      unitPriceMinor: 10000,
      currency: "USD",
      workflowKey: code,
    });
    it("replays committed intake before mutable references while retaining live authorization and payload identity", async () => {
      const f = await fixture(),
        other = await fixture();
      const customer = await company.saveDirectory({
        ...f.request,
        kind: "customer",
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        input: directoryInput("Original retry customer"),
      });
      const item = await company.saveCatalog({
        ...f.request,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        input: service("retry-service"),
      });
      const input = {
        ...f.request,
        title: "Lost response retry",
        customerId: customer.id,
        catalogItemId: item.id,
        sourceReference: "Fictional original source",
        idempotencyKey: randomUUID(),
      };
      const saved = await intake.createLead(input);
      await company.saveDirectory({
        ...f.request,
        kind: "customer",
        entryId: customer.id,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        input: directoryInput("Renamed retry customer"),
      });
      await company.setCatalogStatus({
        ...f.request,
        itemId: item.id,
        expectedRevision: 1,
        status: "archived",
        reason: "Offering retired after capture",
        idempotencyKey: randomUUID(),
      });
      await company.saveIntakePolicy({
        ...f.request,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        input: { requiredFields: ["contactEmail"], customFields: [] },
      });
      const replayed = await intake.createLead(input);
      expect(replayed.id).toBe(saved.id);
      expect(replayed.customerName).toBe("Original retry customer");
      expect(replayed.configuration?.catalog).toEqual(saved.configuration?.catalog);
      expect(replayed.configuration?.policyVersion).toBe(1);
      expect(replayed.evidence).toEqual(saved.evidence);
      await expect(
        intake.createLead({ ...input, title: "Different payload" }),
      ).rejects.toMatchObject({
        code: "CPL_IDEMPOTENCY_CONFLICT",
      });
      await expect(
        intake.createLead({ ...input, customerName: "Different overridden text" }),
      ).rejects.toMatchObject({
        code: "CPL_IDEMPOTENCY_CONFLICT",
      });
      await expect(intake.createLead({ ...input, ...other.request })).rejects.toMatchObject({
        code: "CPL_RECORD_NOT_FOUND",
      });
      const counts = await admin.query<{
        leads: number;
        evidence: number;
        audits: number;
        receipts: number;
      }>(
        `SELECT
          (SELECT count(*)::int FROM cpl_workflow_leads WHERE organization_id=$1) AS leads,
          (SELECT count(*)::int FROM cpl_lead_evidence WHERE organization_id=$1) AS evidence,
          (SELECT count(*)::int FROM cpl_tenant_audit_events WHERE organization_id=$1 AND action='lead.created') AS audits,
          (SELECT count(*)::int FROM cpl_workflow_mutations WHERE organization_id=$1 AND mutation_kind='lead.create') AS receipts`,
        [f.org.id],
      );
      expect(counts.rows[0]).toEqual({ leads: 1, evidence: 1, audits: 1, receipts: 1 });
      await admin.query(
        "UPDATE cpl_memberships SET role='field-user',version=version+1 WHERE organization_id=$1 AND identity_id=$2",
        [f.org.id, f.a.session.identityId],
      );
      await expect(intake.createLead(input)).rejects.toThrow();
    });
    it.each(["phase4", "phase5"])(
      "preserves %s resolved-hash receipts after directory changes without rewriting history",
      async (format) => {
        const f = await fixture();
        const customer = await company.saveDirectory({
          ...f.request,
          kind: "customer",
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
          input: directoryInput("Historical customer"),
        });
        const item =
          format === "phase5"
            ? await company.saveCatalog({
                ...f.request,
                expectedRevision: 0,
                idempotencyKey: randomUUID(),
                input: service("historical-service"),
              })
            : null;
        const input = {
          ...f.request,
          title: "Historical lost response",
          customerId: customer.id,
          ...(item ? { catalogItemId: item.id.toUpperCase() } : {}),
          idempotencyKey: randomUUID(),
        };
        const saved = await intake.createLead(input);
        const capture = (
          await admin.query<{ capture_json: Record<string, unknown> }>(
            "SELECT capture_json FROM cpl_lead_evidence WHERE organization_id=$1 AND lead_id=$2 AND kind='initial_capture'",
            [f.org.id, saved.id],
          )
        ).rows[0]!.capture_json;
        // Model the exact two previously shipped receipt formats in this disposable DB.
        const oldIntent = {
          ...normalizeCplLeadFields(capture),
          receivedAt: null,
          sourceReference: null,
          evidenceNote: null,
          ...(format === "phase5" ? { catalogItemId: input.catalogItemId, customValues: {} } : {}),
        };
        const oldHash = sha(JSON.stringify(oldIntent));
        await admin.query(
          "UPDATE cpl_workflow_mutations SET request_hash=$3 WHERE organization_id=$1 AND resource_id=$2 AND mutation_kind='lead.create'",
          [f.org.id, saved.id, oldHash],
        );
        await company.saveDirectory({
          ...f.request,
          kind: "customer",
          entryId: customer.id,
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
          input: directoryInput("Changed historical customer"),
        });
        if (item)
          await company.setCatalogStatus({
            ...f.request,
            itemId: item.id,
            expectedRevision: 1,
            status: "archived",
            reason: "Retired after capture",
            idempotencyKey: randomUUID(),
          });
        expect((await intake.createLead(input)).id).toBe(saved.id);
        await expect(
          intake.createLead({ ...input, title: "Different request" }),
        ).rejects.toMatchObject({ code: "CPL_IDEMPOTENCY_CONFLICT" });
        expect(
          (
            await admin.query<{ request_hash: string }>(
              "SELECT request_hash FROM cpl_workflow_mutations WHERE organization_id=$1 AND resource_id=$2",
              [f.org.id, saved.id],
            )
          ).rows[0]!.request_hash,
        ).toBe(oldHash);
        expect((await intake.getLead({ ...f.request, leadId: saved.id })).evidence).toEqual(
          saved.evidence,
        );
      },
    );
    it("isolates settings, persists revisions, rejects stale writes and replays exactly", async () => {
      const a = await fixture(),
        b = await fixture(),
        input = {
          displayName: "Fictional North",
          legalName: "Fictional North LLC",
          email: "office@example.invalid",
          phone: "",
          address: "",
          timeZone: "America/Chicago",
        },
        key = randomUUID();
      const saved = await company.saveProfile({
        ...a.request,
        expectedVersion: 0,
        idempotencyKey: key,
        input,
      });
      expect(saved.version).toBe(1);
      expect(
        await company.saveProfile({ ...a.request, expectedVersion: 0, idempotencyKey: key, input }),
      ).toEqual(saved);
      await expect(
        company.saveProfile({
          ...a.request,
          expectedVersion: 0,
          idempotencyKey: randomUUID(),
          input,
        }),
      ).rejects.toMatchObject({ code: "CPL_COMPANY_VERSION_CONFLICT" });
      expect((await company.readWorkspace(b.request)).profile.version).toBe(0);
      expect((await tenants.getOrganization(a.request)).displayName).toBe(input.displayName);
      expect(
        (
          await admin.query(
            "SELECT count(*)::integer AS count FROM cpl_company_setting_versions WHERE organization_id=$1",
            [a.org.id],
          )
        ).rows[0]?.count,
      ).toBe(1);
    });
    it("retains immutable directory captures and lead snapshots until explicit refresh", async () => {
      const f = await fixture();
      let customer = await company.saveDirectory({
        ...f.request,
        kind: "customer",
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        input: directoryInput("Original customer"),
      });
      let l = await lead(f, { customerId: customer.id });
      expect(l.customerName).toBe("Original customer");
      customer = await company.saveDirectory({
        ...f.request,
        kind: "customer",
        entryId: customer.id,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        input: directoryInput("Current customer"),
      });
      expect(customer.revisions).toHaveLength(2);
      l = await intake.updateLead({
        ...f.request,
        leadId: l.id,
        expectedVersion: l.version,
        details: "Corrected request",
      });
      expect(l.customerName).toBe("Original customer");
      l = await intake.updateLead({
        ...f.request,
        leadId: l.id,
        expectedVersion: l.version,
        refreshDirectory: true,
      });
      expect(l.customerName).toBe("Current customer");
      expect(
        (
          await admin.query("SELECT name FROM cpl_customers WHERE organization_id=$1 AND id=$2", [
            f.org.id,
            customer.id,
          ])
        ).rows[0]?.name,
      ).toBe("Original customer");
      const capture = (
        await admin.query(
          "SELECT capture_json FROM cpl_lead_evidence WHERE organization_id=$1 AND lead_id=$2",
          [f.org.id, l.id],
        )
      ).rows[0]?.capture_json as { customerName: string };
      expect(capture.customerName).toBe("Original customer");
      await company.setDirectoryStatus({
        ...f.request,
        kind: "customer",
        entryId: customer.id,
        expectedRevision: customer.revision,
        status: "archived",
        reason: "No new work",
        idempotencyKey: randomUUID(),
      });
      expect((await company.listDirectory({ ...f.request, kind: "customer" })).items).toHaveLength(
        0,
      );
      await expect(lead(f, { customerId: customer.id })).rejects.toMatchObject({
        code: "CPL_DIRECTORY_ARCHIVED",
      });
      expect((await intake.getLead({ ...f.request, leadId: l.id })).customerName).toBe(
        "Current customer",
      );
    });
    it("uses current contact parent including explicit unlink and rejects cross-company references", async () => {
      const f = await fixture(),
        other = await fixture();
      const c = await company.saveDirectory({
        ...f.request,
        kind: "customer",
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        input: directoryInput("Customer"),
      });
      const contact = await company.saveDirectory({
        ...f.request,
        kind: "contact",
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        input: directoryInput("Contact", { customerId: c.id, email: "contact@example.invalid" }),
      });
      await company.saveDirectory({
        ...f.request,
        kind: "contact",
        entryId: contact.id,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        input: directoryInput("Contact", { customerId: null, email: "updated@example.invalid" }),
      });
      expect(
        (await company.listDirectory({ ...f.request, kind: "contact", customerId: c.id })).total,
      ).toBe(0);
      expect((await intake.getIntakeDirectory(f.request)).contacts[0]?.customerId).toBeNull();
      await company.saveDirectory({
        ...f.request,
        kind: "contact",
        entryId: contact.id,
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
        input: directoryInput("Contact", { customerId: null, email: null }),
      });
      expect(
        (
          await company.listDirectory({
            ...f.request,
            kind: "contact",
            q: "contact@example.invalid",
          })
        ).total,
      ).toBe(0);
      expect(
        (
          await company.listDirectory({
            ...f.request,
            kind: "contact",
            q: "updated@example.invalid",
          })
        ).total,
      ).toBe(0);
      await expect(
        company.getDirectory({ ...other.request, kind: "contact", entryId: contact.id }),
      ).rejects.toMatchObject({ code: "CPL_RECORD_NOT_FOUND" });
      await expect(
        company.saveDirectory({
          ...other.request,
          kind: "site",
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
          input: directoryInput("Foreign site", { customerId: c.id }),
        }),
      ).rejects.toMatchObject({ code: "CPL_RECORD_NOT_FOUND" });
    });
    it("paginates complete filtered records with tenant/query-bound cursors and accurate total", async () => {
      const f = await fixture(),
        other = await fixture();
      for (let i = 0; i < 6; i++)
        await company.saveDirectory({
          ...f.request,
          kind: "customer",
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
          input: directoryInput(`Page ${i}`),
        });
      const first = await company.listDirectory({
        ...f.request,
        kind: "customer",
        q: "Page",
        limit: 2,
      });
      expect(first.total).toBe(6);
      expect(first.hasMore).toBe(true);
      const second = await company.listDirectory({
          ...f.request,
          kind: "customer",
          q: "Page",
          limit: 2,
          cursor: first.nextCursor!,
        }),
        third = await company.listDirectory({
          ...f.request,
          kind: "customer",
          q: "Page",
          limit: 2,
          cursor: second.nextCursor!,
        });
      expect(new Set([...first.items, ...second.items, ...third.items].map((x) => x.id)).size).toBe(
        6,
      );
      expect(third.nextCursor).toBeNull();
      await expect(
        company.listDirectory({
          ...other.request,
          kind: "customer",
          q: "Page",
          limit: 2,
          cursor: first.nextCursor!,
        }),
      ).rejects.toMatchObject({ code: "CPL_COMPANY_INVALID_INPUT" });
      await expect(
        company.listDirectory({
          ...f.request,
          kind: "customer",
          q: "different",
          limit: 2,
          cursor: first.nextCursor!,
        }),
      ).rejects.toMatchObject({ code: "CPL_COMPANY_INVALID_INPUT" });
    });
    it("pins catalog identity and fixed recipe key while allowing deliberate snapshot refresh", async () => {
      const f = await fixture();
      let item = await company.saveCatalog({
        ...f.request,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        input: service("stable-service"),
      });
      let l = await lead(f, { catalogItemId: item.id });
      expect(l.requestedService).toBe("stable-service");
      expect(l.configuration?.catalog?.revision).toBe(1);
      item = await company.saveCatalog({
        ...f.request,
        itemId: item.id,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        input: {
          ...service("renamed-code"),
          name: "Renamed service",
          workflowKey: "stable-service",
          unitPriceMinor: 18000,
        },
      });
      l = await intake.updateLead({
        ...f.request,
        leadId: l.id,
        expectedVersion: l.version,
        details: "Revised scope",
      });
      expect(l.configuration?.catalog?.name).toBe("Service stable-service");
      l = await intake.updateLead({
        ...f.request,
        leadId: l.id,
        expectedVersion: l.version,
        refreshCatalog: true,
      });
      expect(l.configuration?.catalog?.revision).toBe(2);
      expect(l.requestedService).toBe("stable-service");
      await expect(
        company.saveCatalog({
          ...f.request,
          itemId: item.id,
          expectedRevision: 2,
          idempotencyKey: randomUUID(),
          input: service("other-key"),
        }),
      ).rejects.toMatchObject({ code: "CPL_COMPANY_WORKFLOW_KEY_IMMUTABLE" });
      await company.setCatalogStatus({
        ...f.request,
        itemId: item.id,
        expectedRevision: 2,
        status: "archived",
        reason: "Retired offering",
        idempotencyKey: randomUUID(),
      });
      await expect(lead(f, { catalogItemId: item.id })).rejects.toMatchObject({
        code: "CPL_CATALOG_ARCHIVED",
      });
    });
    it("enforces current required and typed custom answers and demands review after policy change", async () => {
      const f = await fixture(),
        field = randomUUID();
      let l = await lead(f);
      l = await intake.updateLead({
        ...f.request,
        leadId: l.id,
        expectedVersion: l.version,
        status: "ready_for_proposal",
      });
      await company.saveIntakePolicy({
        ...f.request,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        input: {
          requiredFields: ["contactEmail"],
          customFields: [
            {
              id: field,
              label: "Access confirmed",
              type: "boolean",
              required: true,
              active: true,
              options: [],
            },
          ],
        },
      });
      l = await intake.getLead({ ...f.request, leadId: l.id });
      expect(l.readiness.readyForProposal).toBe(false);
      expect(l.readiness.conflicts.map((x) => x.code)).toContain("company.policy_review_required");
      await expect(
        commercial.createProposal({ ...f.request, leadId: l.id, idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({ code: "CPL_LEAD_NOT_READY" });
      l = await intake.updateLead({
        ...f.request,
        leadId: l.id,
        expectedVersion: l.version,
        status: "needs_info",
        contactEmail: "valid@example.invalid",
        customValues: { [field]: false },
      });
      l = await intake.updateLead({
        ...f.request,
        leadId: l.id,
        expectedVersion: l.version,
        status: "ready_for_proposal",
      });
      expect(l.readiness.readyForProposal).toBe(true);
      expect(l.configuration?.customValues[field]).toBe(false);
      const proposal = await commercial.createProposal({
        ...f.request,
        leadId: l.id,
        idempotencyKey: randomUUID(),
      });
      expect(proposal.leadId).toBe(l.id);
      await expect(
        company.saveIntakePolicy({
          ...f.request,
          expectedVersion: 1,
          idempotencyKey: randomUUID(),
          input: { requiredFields: [], customFields: [] },
        }),
      ).rejects.toMatchObject({ code: "CPL_COMPANY_FIELD_IDENTITY_CONFLICT" });
    });
    it("denies field users intake, financial views, configuration, directory and audit", async () => {
      const f = await fixture();
      let l = await lead(f);
      l = await intake.updateLead({
        ...f.request,
        leadId: l.id,
        expectedVersion: l.version,
        status: "ready_for_proposal",
      });
      const p = await commercial.createProposal({
          ...f.request,
          leadId: l.id,
          idempotencyKey: randomUUID(),
        }),
        field = await actor();
      await admin.query(
        "INSERT INTO cpl_memberships(organization_id,identity_id,role) VALUES($1,$2,'field-user')",
        [f.org.id, field.session.identityId],
      );
      const request = { ...f.request, sessionToken: field.raw };
      const operations = [
        () => intake.listLeads(request),
        () => intake.getLead({ ...request, leadId: l.id }),
        () => lead({ ...f, request }),
        () =>
          intake.updateLead({
            ...request,
            leadId: l.id,
            expectedVersion: l.version,
            title: "Forbidden",
          }),
        () => intake.getIntakeDirectory(request),
        () => commercial.readWorkspace(request),
        () => commercial.getProposal({ ...request, proposalId: p.id }),
        () => commercial.getCustomerPreview({ ...request, proposalId: p.id, version: 1 }),
        () => commercial.getPdfArtifact({ ...request, proposalId: p.id, version: 1 }),
        () => commercial.getProject({ ...request, projectId: randomUUID() }),
        () => company.readWorkspace(request),
        () => company.listCatalog(request),
        () => company.listDirectory({ ...request, kind: "customer" }),
        () => company.listAudit(request),
      ];
      for (const operation of operations)
        await expect(operation()).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
      await expect(intake.readWorkspace(request)).rejects.toMatchObject({
        code: "CPL_ACCESS_DENIED",
      });
    });
    it("filters safe audit metadata and limits it to administrators", async () => {
      const f = await fixture();
      await company.saveDirectory({
        ...f.request,
        kind: "customer",
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        input: directoryInput("PRIVATE customer content"),
      });
      const page = await company.listAudit({
        ...f.request,
        action: "directory.customer.saved",
        limit: 1,
      });
      expect(page.total).toBe(1);
      expect(page.items[0]?.target?.kind).toBe("customer");
      expect(JSON.stringify(page)).not.toContain("PRIVATE customer content");
      const member = await actor();
      await admin.query(
        "INSERT INTO cpl_memberships(organization_id,identity_id,role) VALUES($1,$2,'member')",
        [f.org.id, member.session.identityId],
      );
      const req = { ...f.request, sessionToken: member.raw };
      expect((await company.listDirectory({ ...req, kind: "customer" })).total).toBe(1);
      await expect(company.listAudit(req)).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
      await expect(company.readConfiguration(req)).rejects.toMatchObject({
        code: "CPL_ACCESS_DENIED",
      });
    });
    it("pins new template and catalog currencies while keeping old proposal versions unchanged", async () => {
      const f = await fixture(),
        brand = {
          ...defaultCplCommercialBranding(),
          businessName: "Fictional company",
          defaultCurrency: "CAD",
        };
      await commercial.saveBranding({ ...f.request, expectedRevision: 0, input: brand });
      const template = await commercial.createTemplate({
        ...f.request,
        idempotencyKey: randomUUID(),
        input: {
          name: "Canadian services",
          summary: "",
          scope: "",
          schedule: "",
          deliverables: "",
          assumptions: "",
          exclusions: "",
          terms: "",
          paymentTerms: "",
          sections: [],
          catalog: [
            {
              serviceCode: "service",
              description: "Service",
              unit: "visit",
              unitPriceMinor: 12500,
            },
          ],
        },
      });
      expect(template.currency).toBe("CAD");
      let l = await lead(f);
      l = await intake.updateLead({
        ...f.request,
        leadId: l.id,
        expectedVersion: l.version,
        status: "ready_for_proposal",
      });
      const first = await commercial.createProposal({
        ...f.request,
        leadId: l.id,
        templateId: template.id,
        idempotencyKey: randomUUID(),
      });
      await commercial.saveBranding({
        ...f.request,
        expectedRevision: 1,
        input: { ...brand, defaultCurrency: "EUR" },
      });
      const second = await commercial.createProposal({
        ...f.request,
        leadId: l.id,
        templateId: template.id,
        allowAdditional: true,
        idempotencyKey: randomUUID(),
      });
      expect(second.versions[0]?.content.currency).toBe("CAD");
      expect(second.versions[0]?.totals.totalMinor).toBe(12500);
      expect(
        (await commercial.getProposal({ ...f.request, proposalId: first.id })).versions,
      ).toEqual(first.versions);
      const item = await company.saveCatalog({
        ...f.request,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        input: { ...service("euro-service"), currency: "EUR" },
      });
      let catalogLead = await lead(f, {
        catalogItemId: item.id,
        title: "A different catalog request",
        customerName: "Other fictional customer",
      });
      catalogLead = await intake.updateLead({
        ...f.request,
        leadId: catalogLead.id,
        expectedVersion: catalogLead.version,
        status: "ready_for_proposal",
      });
      const catalogProposal = await commercial.createProposal({
        ...f.request,
        leadId: catalogLead.id,
        idempotencyKey: randomUUID(),
      });
      expect(catalogProposal.versions[0]?.content.currency).toBe("EUR");
      expect(catalogProposal.versions[0]?.sourceLead.configuration?.catalog).toEqual(
        catalogLead.configuration?.catalog,
      );
    });
    it("requires a deliberate currency on preserved unpinned templates after a company currency change", async () => {
      const f = await fixture(),
        templateId = randomUUID();
      const snapshot = {
        name: "Legacy prices",
        summary: "",
        scope: "",
        schedule: "",
        deliverables: "",
        assumptions: "",
        exclusions: "",
        terms: "",
        paymentTerms: "",
        sections: [],
        catalog: [
          {
            serviceCode: "legacy",
            description: "Legacy service",
            unit: "visit",
            unitPriceMinor: 12000,
          },
        ],
      };
      await admin.query(
        "INSERT INTO cpl_commercial_templates(id,organization_id,name,snapshot,created_by_identity_id) VALUES($1,$2,$3,$4::jsonb,$5)",
        [templateId, f.org.id, snapshot.name, JSON.stringify(snapshot), f.a.session.identityId],
      );
      await commercial.saveBranding({
        ...f.request,
        expectedRevision: 0,
        input: {
          ...defaultCplCommercialBranding(),
          businessName: "Fictional",
          defaultCurrency: "EUR",
        },
      });
      let l = await lead(f);
      l = await intake.updateLead({
        ...f.request,
        leadId: l.id,
        expectedVersion: l.version,
        status: "ready_for_proposal",
      });
      await expect(
        commercial.createProposal({
          ...f.request,
          leadId: l.id,
          templateId,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "CPL_TEMPLATE_CURRENCY_CONFIRMATION_REQUIRED" });
      const p = await commercial.createProposal({
        ...f.request,
        leadId: l.id,
        templateId,
        legacyTemplateCurrency: "USD",
        idempotencyKey: randomUUID(),
      });
      expect(p.versions[0]?.content.currency).toBe("USD");
      expect(p.versions[0]?.totals.totalMinor).toBe(12000);
    });
    it("reads and saves existing company-wide configuration without creating projects", async () => {
      const f = await fixture(),
        delivery = new SqlCplDeliveryRepository(tenants),
        config = await company.readConfiguration(f.request);
      expect(config.modules).toEqual({ proposal: true, field: true, report: true, delivery: true });
      const input = {
        serviceKey: "*",
        name: "Fictional closeout",
        requireAward: true,
        requireWorkCompleted: true,
        requireApprovedReport: false,
        requireDelivery: false,
        requirePurchaseOrder: false,
        requireIssuesDisposed: true,
      };
      await delivery.saveCompanyPolicy({
        ...f.request,
        expectedVersion: 0,
        input,
        idempotencyKey: randomUUID(),
      });
      expect((await company.listPolicies({ ...f.request, limit: 1 })).items[0]?.name).toBe(
        input.name,
      );
      expect((await company.readConfiguration(f.request)).closeoutPolicies[0]?.version).toBe(1);
      expect((await company.listTemplates({ ...f.request, kind: "proposal" })).total).toBe(0);
      expect((await company.listTemplates({ ...f.request, kind: "field" })).total).toBe(0);
      expect((await company.listTemplates({ ...f.request, kind: "report" })).total).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT count(*)::integer AS count FROM cpl_commercial_projects WHERE organization_id=$1",
            [f.org.id],
          )
        ).rows[0]?.count,
      ).toBe(0);
    });
    it("projects only this company's provisioning event with a masked platform actor", async () => {
      const a = await fixture(),
        b = await fixture(),
        operator = await actor();
      for (const [org, action] of [
        [a.org.id, "company.provisioned"],
        [b.org.id, "company.provisioned"],
        [a.org.id, "platform.private-operation"],
      ])
        await admin.query(
          "INSERT INTO cpl_platform_audit_events(id,actor_identity_id,organization_id,action,resource_id) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), operator.session.identityId, org, action, "private-platform-resource"],
        );
      const page = await company.listAudit({ ...a.request, action: "company.provisioned" });
      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        actorIdentityId: null,
        actorName: "Platform operator",
        action: "company.provisioned",
        resourceId: a.org.id,
      });
      expect(JSON.stringify(page)).not.toContain(operator.session.identityId);
      expect(JSON.stringify(page)).not.toContain(b.org.id);
      expect(JSON.stringify(await company.listAudit(a.request))).not.toContain(
        "platform.private-operation",
      );
    });
    it("never applies legacy template currency to a catalog price or catalog currency to legacy template prices", async () => {
      const f = await fixture(),
        item = await company.saveCatalog({
          ...f.request,
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
          input: { ...service("canadian-service"), currency: "CAD" },
        });
      let l = await lead(f, { catalogItemId: item.id });
      l = await intake.updateLead({
        ...f.request,
        leadId: l.id,
        expectedVersion: l.version,
        status: "ready_for_proposal",
      });
      await expect(
        commercial.createProposal({
          ...f.request,
          leadId: l.id,
          legacyTemplateCurrency: "EUR",
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "CPL_INVALID_INPUT" });
      const templateId = randomUUID(),
        snapshot = {
          name: "Unpinned legacy USD",
          summary: "",
          scope: "",
          schedule: "",
          deliverables: "",
          assumptions: "",
          exclusions: "",
          terms: "",
          paymentTerms: "",
          sections: [],
          catalog: [
            {
              serviceCode: "legacy",
              description: "Legacy amount",
              unit: "visit",
              unitPriceMinor: 12000,
            },
          ],
        };
      await admin.query(
        "INSERT INTO cpl_commercial_templates(id,organization_id,name,snapshot,created_by_identity_id) VALUES($1,$2,$3,$4::jsonb,$5)",
        [templateId, f.org.id, snapshot.name, JSON.stringify(snapshot), f.a.session.identityId],
      );
      const p = await commercial.createProposal({
        ...f.request,
        leadId: l.id,
        templateId,
        idempotencyKey: randomUUID(),
      });
      expect(p.versions[0]?.content.currency).toBe("USD");
      expect(p.versions[0]?.totals.totalMinor).toBe(12000);
    });
    it("treats a zero module allowance as disabled for every company configuration read", async () => {
      const f = await fixture();
      await commercial.saveBranding({
        ...f.request,
        expectedRevision: 0,
        input: {
          ...defaultCplCommercialBranding(),
          businessName: "PRIVATE unavailable brand",
          defaultCurrency: "EUR",
        },
      });
      await admin.query(
        "UPDATE cpl_module_entitlements SET usage_limit=0 WHERE organization_id=$1",
        [f.org.id],
      );
      expect(await company.readConfiguration(f.request)).toMatchObject({
        modules: { proposal: false, field: false, report: false, delivery: false },
        commercialBranding: null,
        reportBranding: null,
        closeoutPolicies: [],
      });
      expect((await company.readWorkspace(f.request)).defaultCurrency).toBe("USD");
      for (const kind of ["proposal", "field", "report"] as const)
        await expect(company.listTemplates({ ...f.request, kind })).rejects.toMatchObject({
          code: "CPL_MODULE_DISABLED",
        });
      await expect(company.listPolicies(f.request)).rejects.toMatchObject({
        code: "CPL_MODULE_DISABLED",
      });
    });
    it("derives persisted setup readiness while keeping disabled modules and owner-only teams optional", async () => {
      const f = await fixture();
      expect((await company.readWorkspace(f.request)).setup.status).toBe("incomplete");
      await company.saveProfile({
        ...f.request,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        input: {
          displayName: "Fictional configured",
          legalName: "",
          email: "",
          phone: "",
          address: "",
          timeZone: "UTC",
        },
      });
      const configured = await company.readWorkspace(f.request);
      expect(configured.setup.status).toBe("configured");
      expect(configured.setup.checks.find((x) => x.key === "field-templates")?.status).toBe(
        "missing",
      );
      expect(configured.setup.checks.find((x) => x.key === "workflow")?.status).toBe("disabled");
      await admin.query(
        "UPDATE cpl_module_entitlements SET usage_limit=0 WHERE organization_id=$1",
        [f.org.id],
      );
      const basic = await company.readWorkspace(f.request);
      expect(basic.setup.status).toBe("operationally_ready");
      expect(basic.setup.checks.some((x) => x.blocking)).toBe(false);
      expect(basic.setup.checks.find((x) => x.key === "team")?.status).toBe("optional");
    });
  },
);
