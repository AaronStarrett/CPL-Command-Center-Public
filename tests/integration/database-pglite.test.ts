import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PGliteDatabaseAdapter,
  countRows,
  loadMigrations,
  migrateDatabase,
  resetDemoDatabase,
  seedDatabase,
  seedDatabaseOnExecutor,
  SqlFoundationRepository,
  SqlAiProviderRepository,
  SqlPhase1Repository,
  DEMO_RESET_CONFIRMATION,
} from "../../packages/database/src/index.js";

let database: PGliteDatabaseAdapter | undefined;
afterEach(async () => {
  await database?.close();
  database = undefined;
});

describe("shared PostgreSQL migration in PGlite", () => {
  it("migrates, seeds repeatably, resets safely, and exposes health", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    expect((await migrateDatabase(database)).applied).toEqual([
      "0001_phase0_foundation.sql",
      "0002_phase1_core.sql",
      "0003_assistant_message_permissions.sql",
      "0004_phase1_2_openai_provider.sql",
      "0005_phase1_3_live_openai.sql",
      "0006_phase1_3_1_policy_provenance.sql",
      "0007_phase1_3_3_production_ai_routing.sql",
      "0008_phase1_3_3_connection_fingerprint.sql",
      "0009_phase1_3_3_realtime_route_provenance.sql",
      "0010_phase1_3_4_local_owner.sql",
      "0011_phase2_leads.sql",
      "0012_phase2_1_presentation.sql",
      "0013_phase2_2_executive_documents.sql",
      "0014_phase2_3_digital_workforce.sql",
      "0015_phase3_inspection_report_core.sql",
      "0016_phase3_delivery_authorization.sql",
      "0017_phase31a_configuration_release.sql",
      "0018_phase31a_source_integrity_and_staging_repair.sql",
      "0019_phase32a_operational_work_control_plane.sql",
      "0020_phase32a_projection_reliability_and_cycle_integrity.sql",
      "0021_phase32a_terminal_projection_and_schedule_failure.sql",
      "0022_phase33a_service_catalog_and_proposals.sql",
      "0023_phase33a_commercial_integrity_and_override_cycles.sql",
      "0024_phase34a_guided_meridian_experience.sql",
      "0025_cpl_tenant_foundation.sql",
      "0026_cpl_hosted_workflow.sql",
    ]);
    expect((await migrateDatabase(database)).alreadyApplied).toEqual([
      "0001_phase0_foundation.sql",
      "0002_phase1_core.sql",
      "0003_assistant_message_permissions.sql",
      "0004_phase1_2_openai_provider.sql",
      "0005_phase1_3_live_openai.sql",
      "0006_phase1_3_1_policy_provenance.sql",
      "0007_phase1_3_3_production_ai_routing.sql",
      "0008_phase1_3_3_connection_fingerprint.sql",
      "0009_phase1_3_3_realtime_route_provenance.sql",
      "0010_phase1_3_4_local_owner.sql",
      "0011_phase2_leads.sql",
      "0012_phase2_1_presentation.sql",
      "0013_phase2_2_executive_documents.sql",
      "0014_phase2_3_digital_workforce.sql",
      "0015_phase3_inspection_report_core.sql",
      "0016_phase3_delivery_authorization.sql",
      "0017_phase31a_configuration_release.sql",
      "0018_phase31a_source_integrity_and_staging_repair.sql",
      "0019_phase32a_operational_work_control_plane.sql",
      "0020_phase32a_projection_reliability_and_cycle_integrity.sql",
      "0021_phase32a_terminal_projection_and_schedule_failure.sql",
      "0022_phase33a_service_catalog_and_proposals.sql",
      "0023_phase33a_commercial_integrity_and_override_cycles.sql",
      "0024_phase34a_guided_meridian_experience.sql",
      "0025_cpl_tenant_foundation.sql",
      "0026_cpl_hosted_workflow.sql",
    ]);
    await seedDatabase(database);
    await seedDatabase(database);
    expect(await countRows(database, "users")).toBe(6);
    expect(await countRows(database, "roles")).toBe(5);
    expect(await countRows(database, "feature_flags")).toBe(8);
    expect(await countRows(database, "integration_connections")).toBe(15);
    expect((await database.health()).status).toBe("healthy");
    const repository = new SqlFoundationRepository(database);
    expect(await repository.findActiveUserByPersonaKey("owner-administrator")).toMatchObject({
      email: "owner.admin@example.invalid",
      roleIds: ["owner-admin"],
    });
    await resetDemoDatabase(database, {
      appMode: "demo",
      nodeEnv: "test",
      confirmation: DEMO_RESET_CONFIRMATION,
    });
    expect(await countRows(database, "users")).toBe(6);
  });

  it("commits OpenAI connection state, provider settings, and activation audit together", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedDatabase(database);
    const repository = new SqlAiProviderRepository(database);
    const foundation = new SqlFoundationRepository(database);
    const actorUserId = "10000000-0000-4000-8000-000000000001";
    const credentialFingerprint = "sha256:000000000001";
    const evidence = await repository.recordConnectionTest({
      provider: "openai",
      actorUserId,
      outcome: "succeeded",
      authenticated: true,
      safeMessage: "Authenticated synthetic activation evidence.",
      modelCount: 1,
      latencyMs: 37,
      credentialFingerprint,
      correlationId: "activation-atomic-evidence",
    });
    expect(evidence.latencyMs).toBe(37);
    expect(evidence.credentialFingerprint).toBe(credentialFingerprint);
    const snapshot = await repository.getProviderSettingsSnapshot();
    const authorizationAudit = await foundation.record({
      eventType: "ai-provider.activation-authorized",
      action: "openai.activate",
      outcome: "allowed",
      actorUserId,
      resourceType: "integration-provider",
      correlationId: "activation-atomic-success",
      metadata: {
        provider: "openai",
        evidenceId: evidence.id,
        credentialFingerprint,
        model: "gpt-verified",
      },
    });

    await expect(
      repository.activateOpenAiAtomically({
        actorUserId,
        evidenceId: evidence.id,
        credentialFingerprint: "sha256:000000000002",
        settings: {
          ...snapshot.settings,
          mode: "openai",
          defaultTextModel: "gpt-verified",
          defaultRealtimeModel: "gpt-verified",
        },
        expectedSettingsVersion: snapshot.version,
        correlationId: "activation-atomic-success",
        authorizationAuditId: authorizationAudit.id,
      }),
    ).resolves.toBe(false);
    await expect(
      database.query<{ connection_status: string }>(
        "SELECT connection_status FROM integration_connections WHERE provider_type='ai'",
      ),
    ).resolves.toMatchObject({ rows: [{ connection_status: "simulated" }] });

    await expect(
      repository.activateOpenAiAtomically({
        actorUserId,
        evidenceId: evidence.id,
        credentialFingerprint,
        settings: {
          ...snapshot.settings,
          mode: "openai",
          defaultTextModel: "gpt-verified",
          defaultRealtimeModel: "gpt-verified",
        },
        expectedSettingsVersion: snapshot.version,
        correlationId: "activation-atomic-success",
        authorizationAuditId: authorizationAudit.id,
      }),
    ).resolves.toBe(true);

    await expect(
      database.query<{
        connection_mode: string;
        setting_mode: string;
        event_type: string;
        outcome: string;
        authorization_audit_id: string;
      }>(
        `SELECT c.mode AS connection_mode,s.value_json->>'mode' AS setting_mode,
                a.event_type,a.outcome,a.metadata->>'authorizationAuditId' AS authorization_audit_id
         FROM integration_connections c
         JOIN system_settings s ON s.key='ai.provider.settings'
         JOIN audit_logs a ON a.resource_id=c.id
         WHERE c.provider_type='ai' AND a.correlation_id='activation-atomic-success'`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          connection_mode: "live",
          setting_mode: "openai",
          event_type: "ai-provider.activated",
          outcome: "succeeded",
          authorization_audit_id: authorizationAudit.id,
        },
      ],
    });
  });

  it("rolls connection and setting state back when the activation success audit cannot persist", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedDatabase(database);
    const repository = new SqlAiProviderRepository(database);
    const foundation = new SqlFoundationRepository(database);
    const actorUserId = "10000000-0000-4000-8000-000000000001";
    const credentialFingerprint = "sha256:000000000003";
    const evidence = await repository.recordConnectionTest({
      provider: "openai",
      actorUserId,
      outcome: "succeeded",
      authenticated: true,
      safeMessage: "Authenticated synthetic rollback evidence.",
      modelCount: 1,
      credentialFingerprint,
      correlationId: "activation-atomic-rollback-evidence",
    });
    const snapshot = await repository.getProviderSettingsSnapshot();
    const authorizationAudit = await foundation.record({
      eventType: "ai-provider.activation-authorized",
      action: "openai.activate",
      outcome: "allowed",
      actorUserId,
      resourceType: "integration-provider",
      correlationId: "activation-atomic-audit-failure",
      metadata: {
        provider: "openai",
        evidenceId: evidence.id,
        credentialFingerprint,
        model: "gpt-rollback",
      },
    });
    const beforeConnection = await database.query<{
      mode: string;
      connection_status: string;
      version: number;
    }>(
      `SELECT mode,connection_status,version
       FROM integration_connections WHERE provider_type='ai'`,
    );
    const beforeSetting = await database.query<{ value_json: unknown; version: number }>(
      "SELECT value_json,version FROM system_settings WHERE key='ai.provider.settings'",
    );
    await database.execute(
      `ALTER TABLE audit_logs ADD CONSTRAINT activation_atomic_audit_failure_check
       CHECK (event_type<>'ai-provider.activated' OR
              correlation_id IS DISTINCT FROM 'activation-atomic-audit-failure')`,
    );

    await expect(
      repository.activateOpenAiAtomically({
        actorUserId,
        evidenceId: evidence.id,
        credentialFingerprint,
        settings: {
          ...snapshot.settings,
          mode: "openai",
          defaultTextModel: "gpt-rollback",
          defaultRealtimeModel: "gpt-rollback",
        },
        expectedSettingsVersion: snapshot.version,
        correlationId: "activation-atomic-audit-failure",
        authorizationAuditId: authorizationAudit.id,
      }),
    ).rejects.toThrow();

    await expect(
      database.query(
        "SELECT mode,connection_status,version FROM integration_connections WHERE provider_type='ai'",
      ),
    ).resolves.toMatchObject(beforeConnection);
    await expect(
      database.query(
        "SELECT value_json,version FROM system_settings WHERE key='ai.provider.settings'",
      ),
    ).resolves.toMatchObject(beforeSetting);
    await expect(
      database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_logs
         WHERE correlation_id='activation-atomic-audit-failure'
           AND event_type='ai-provider.activated'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("0004 persists every generated-artifact kind, application-owned upload attribution, and owner-scoped reopen", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedDatabase(database);
    const tables = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name IN
       ('ai_provider_connection_tests','ai_response_runs','ai_message_citations','ai_tool_calls',
        'ai_realtime_sessions','ai_usage_records','ai_model_cache','generated_artifacts',
        'api_rate_limit_windows') ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      [
        "ai_message_citations",
        "ai_model_cache",
        "ai_provider_connection_tests",
        "api_rate_limit_windows",
        "ai_realtime_sessions",
        "ai_response_runs",
        "ai_tool_calls",
        "ai_usage_records",
        "generated_artifacts",
      ].sort(),
    );

    const ownership = await database.query<{
      conversation_id: string;
      owner_user_id: string;
    }>(
      `SELECT c.id::text AS conversation_id,c.owner_user_id::text AS owner_user_id
       FROM conversations c ORDER BY c.created_at,c.id LIMIT 1`,
    );
    const otherOwner = await database.query<{ id: string }>(
      `SELECT id::text AS id FROM users WHERE id<>$1 ORDER BY id LIMIT 1`,
      [ownership.rows[0]?.owner_user_id],
    );
    const owned = ownership.rows[0];
    if (!owned || !otherOwner.rows[0]) throw new Error("Expected seeded owners and conversation.");
    const repository = new SqlAiProviderRepository(database);
    const kinds = [
      "research_report",
      "source_board",
      "chart",
      "graph",
      "table",
      "metric_summary",
      "timeline",
      "comparison",
      "pdf",
      "image",
      "data_file",
      "text_document",
      "analysis_result",
      "web_search_result",
      "code_interpreter_output",
    ] as const;
    const statuses = [
      "preparing",
      "generating",
      "ready",
      "partial",
      "failed",
      "expired",
      "archived",
    ] as const;
    for (const [index, kind] of kinds.entries()) {
      await repository.recordGeneratedArtifact({
        conversationId: owned.conversation_id,
        responseRunId: null,
        requestedByUserId: owned.owner_user_id,
        kind,
        title: `Synthetic ${kind}`,
        status: statuses[index % statuses.length] ?? "preparing",
        artifactVersion: index + 1,
        provider: "demo",
        providerItemId: `provider-item-${index}`,
        providerContainerId: `container-${index}`,
        providerFileId: `file-${index}`,
        filename: `artifact-${index}.txt`,
        mediaType: "text/plain",
        storageReference: `stored-artifact-${index}`,
        specification: { kind, schemaVersion: 1 },
        sourceMetadata: { source: "synthetic" },
        citationIds: [`citation-${index}`],
        fileMetadata: { sha256: "0".repeat(64), size: 1 },
        renderMetadata: { renderer: "data" },
        generationMetadata: { run: index },
        requiredPermissions: ["documents.view"],
        simulated: true,
        errorCode: null,
      });
    }
    await repository.recordGeneratedArtifact({
      conversationId: owned.conversation_id,
      responseRunId: null,
      requestedByUserId: owned.owner_user_id,
      kind: "pdf",
      title: "Owner upload",
      status: "ready",
      artifactVersion: 1,
      provider: "application",
      providerItemId: null,
      providerContainerId: null,
      providerFileId: null,
      filename: "owner-upload.pdf",
      mediaType: "application/pdf",
      storageReference: "art_application_upload_round_trip",
      specification: { renderer: "pdf", schemaVersion: 1 },
      sourceMetadata: { origin: "restricted_upload" },
      citationIds: [],
      fileMetadata: { sha256: "1".repeat(64), size: 100 },
      renderMetadata: { renderer: "pdf" },
      generationMetadata: { applicationGenerated: false },
      requiredPermissions: ["documents.view"],
      simulated: true,
      errorCode: null,
    });
    const persisted = await database.query<{ kind_count: string; status_count: string }>(
      `SELECT COUNT(DISTINCT kind)::text AS kind_count,
              COUNT(DISTINCT status)::text AS status_count
       FROM generated_artifacts WHERE requested_by_user_id=$1`,
      [owned.owner_user_id],
    );
    expect(persisted.rows[0]).toEqual({ kind_count: "15", status_count: "7" });
    await expect(
      repository.getGeneratedArtifactByStorageReference("stored-artifact-0", owned.owner_user_id),
    ).resolves.toMatchObject({
      kind: "research_report",
      storageReference: "stored-artifact-0",
      requestedByUserId: owned.owner_user_id,
    });
    await expect(
      repository.getGeneratedArtifactByStorageReference("stored-artifact-0", otherOwner.rows[0].id),
    ).resolves.toBeNull();
    await expect(
      repository.getGeneratedArtifactByStorageReference(
        "art_application_upload_round_trip",
        owned.owner_user_id,
      ),
    ).resolves.toMatchObject({
      provider: "application",
      sourceMetadata: { origin: "restricted_upload" },
      storageReference: "art_application_upload_round_trip",
    });

    const failedRun = await repository.beginResponseRun({
      conversationId: owned.conversation_id,
      requestedByUserId: owned.owner_user_id,
      requestId: "request-generated-artifact-cleanup",
      provider: "demo",
      model: "demo-artifact-runner",
      correlationId: "correlation-generated-artifact-cleanup",
    });
    await repository.recordGeneratedArtifacts(
      ["art_cleanup_image", "art_cleanup_pdf"].map((storageReference, index) => ({
        conversationId: owned.conversation_id,
        responseRunId: failedRun.id,
        requestedByUserId: owned.owner_user_id,
        kind: index === 0 ? ("image" as const) : ("pdf" as const),
        title: `Cleanup artifact ${index + 1}`,
        status: "ready" as const,
        artifactVersion: 1,
        provider: "demo" as const,
        providerItemId: null,
        providerContainerId: null,
        providerFileId: null,
        filename: index === 0 ? "cleanup.png" : "cleanup.pdf",
        mediaType: index === 0 ? "image/png" : "application/pdf",
        storageReference,
        specification: { renderer: index === 0 ? "image" : "pdf", schemaVersion: 1 },
        sourceMetadata: { origin: "failed_generation_fixture" },
        citationIds: [],
        fileMetadata: { sha256: String(index).repeat(64), size: 100 + index },
        renderMetadata: { renderer: index === 0 ? "image" : "pdf" },
        generationMetadata: { run: "failure-cleanup" },
        requiredPermissions: ["documents.view"],
        simulated: true,
        errorCode: null,
      })),
    );
    await expect(
      repository.failGeneratedArtifactsForResponseRun({
        responseRunId: failedRun.id,
        requestedByUserId: otherOwner.rows[0].id,
        errorCode: "WRONG_OWNER",
      }),
    ).resolves.toEqual([]);
    await expect(
      repository.getGeneratedArtifactByStorageReference("art_cleanup_pdf", owned.owner_user_id),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(
      repository.failGeneratedArtifactsForResponseRun({
        responseRunId: failedRun.id,
        requestedByUserId: owned.owner_user_id,
        errorCode: "GENERATION_PERSISTENCE_FAILED",
      }),
    ).resolves.toEqual(expect.arrayContaining(["art_cleanup_image", "art_cleanup_pdf"]));
    const failedArtifacts = await database.query<{
      error_code: string;
      file_metadata: Record<string, never>;
      status: string;
      storage_reference: string | null;
      version: number;
    }>(
      `SELECT status,storage_reference,file_metadata,error_code,version
       FROM generated_artifacts WHERE response_run_id=$1 ORDER BY filename`,
      [failedRun.id],
    );
    expect(failedArtifacts.rows).toHaveLength(2);
    expect(failedArtifacts.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: "GENERATION_PERSISTENCE_FAILED",
          file_metadata: {},
          status: "failed",
          storage_reference: null,
          version: 2,
        }),
        expect.objectContaining({
          error_code: "GENERATION_PERSISTENCE_FAILED",
          file_metadata: {},
          status: "failed",
          storage_reference: null,
          version: 2,
        }),
      ]),
    );
  });

  it("rolls a failed transaction back", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await expect(
      database.transaction(async (transaction) => {
        await transaction.query(
          "INSERT INTO roles (id,key,name,description,status) VALUES ($1,$2,$3,$4,'active')",
          ["aaaaaaaa-0000-4000-8000-000000000001", "rollback-test", "Rollback", "Rollback test"],
        );
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await countRows(database, "roles")).toBe(0);
  });

  it("serializes concurrent transactions so one rollback cannot erase another committed write", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await database.execute("CREATE TABLE transaction_probe (id integer PRIMARY KEY)");

    let releaseFirstTransaction!: () => void;
    const firstTransactionMayCommit = new Promise<void>((resolve) => {
      releaseFirstTransaction = resolve;
    });
    let reportFirstInsert!: () => void;
    const firstInsertCompleted = new Promise<void>((resolve) => {
      reportFirstInsert = resolve;
    });
    const clientExec = vi.spyOn(database.client, "exec");

    const firstTransaction = database.transaction(async (transaction) => {
      await transaction.query("INSERT INTO transaction_probe (id) VALUES (1)");
      reportFirstInsert();
      await firstTransactionMayCommit;
      return "first-committed";
    });
    await firstInsertCompleted;

    const secondTransaction = database.transaction(async (transaction) => {
      await transaction.query("INSERT INTO transaction_probe (id) VALUES (2)");
      throw new Error("second transaction rolls back");
    });
    const secondTransactionFailure = secondTransaction.catch((error: unknown) => error);

    expect(clientExec.mock.calls.filter(([sql]) => sql === "BEGIN")).toHaveLength(1);
    releaseFirstTransaction();

    await expect(firstTransaction).resolves.toBe("first-committed");
    await expect(secondTransactionFailure).resolves.toEqual(
      expect.objectContaining({ message: "second transaction rolls back" }),
    );
    expect(clientExec.mock.calls.filter(([sql]) => sql === "BEGIN")).toHaveLength(2);
    await expect(
      database.query<{ id: number }>("SELECT id FROM transaction_probe ORDER BY id"),
    ).resolves.toMatchObject({ rows: [{ id: 1 }] });
  });

  it("keeps top-level queries outside an active transaction boundary", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await database.execute("CREATE TABLE query_probe (id integer PRIMARY KEY)");

    let releaseTransaction!: () => void;
    const transactionMayCommit = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    let reportTransactionReady!: () => void;
    const transactionReady = new Promise<void>((resolve) => {
      reportTransactionReady = resolve;
    });
    let rowsVisibleInsideTransaction = -1;

    const transaction = database.transaction(async (executor) => {
      await executor.query("INSERT INTO query_probe (id) VALUES (1)");
      reportTransactionReady();
      await transactionMayCommit;
      const visible = await executor.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM query_probe",
      );
      rowsVisibleInsideTransaction = Number(visible.rows[0]?.count ?? -1);
    });
    await transactionReady;

    const clientQuery = vi.spyOn(database.client, "query");
    const outsideQuery = database.query("INSERT INTO query_probe (id) VALUES (2)");
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes("VALUES (2)"))).toBe(false);
    releaseTransaction();

    await transaction;
    await outsideQuery;
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes("VALUES (2)"))).toBe(true);
    expect(rowsVisibleInsideTransaction).toBe(1);
    await expect(
      database.query<{ id: number }>("SELECT id FROM query_probe ORDER BY id"),
    ).resolves.toMatchObject({ rows: [{ id: 1 }, { id: 2 }] });
  });

  it("serializes the overlapping begin-and-reserve transactions used by rapid AI requests", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedDatabase(database);
    const repository = new SqlPhase1Repository(database);
    const ownerUserId = "10000000-0000-4000-8000-000000000001";
    const conversation = await repository.createConversation({
      ownerUserId,
      title: "Rapid request transaction boundary",
    });
    const firstReservation = await repository.reserveAiCommandRequest({
      conversationId: conversation.id,
      ownerUserId,
      correlationId: "rapid-request-first-reservation",
    });

    const [begunRequest, secondReservation] = await Promise.all([
      repository.beginAiCommandRequest({
        requestId: firstReservation.requestId,
        generation: firstReservation.generation,
        conversationId: conversation.id,
        ownerUserId,
        content: "Show all companies",
        correlationId: "rapid-request-first-message",
      }),
      repository.reserveAiCommandRequest({
        conversationId: conversation.id,
        ownerUserId,
        correlationId: "rapid-request-second-reservation",
      }),
    ]);

    expect(begunRequest).toMatchObject({
      status: "accepted",
      requestId: firstReservation.requestId,
      generation: firstReservation.generation,
    });
    expect(secondReservation.generation).toBe(firstReservation.generation + 1);
    await expect(repository.getConversation(conversation.id, ownerUserId)).resolves.toMatchObject({
      version: secondReservation.generation,
    });
    await expect(repository.listAssistantMessages(conversation.id, ownerUserId)).resolves.toEqual([
      expect.objectContaining({
        id: firstReservation.requestId,
        role: "user",
        content: "Show all companies",
      }),
    ]);
  });

  it("backfills pre-provenance assistant messages fail closed on Phase 1.1 upgrade", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    const migrations = await loadMigrations();
    const phase0 = migrations.find((migration) => migration.id === "0001_phase0_foundation.sql");
    const phase1 = migrations.find((migration) => migration.id === "0002_phase1_core.sql");
    const phase11 = migrations.find(
      (migration) => migration.id === "0003_assistant_message_permissions.sql",
    );
    if (!phase0 || !phase1 || !phase11) throw new Error("Expected ordered migrations.");
    await database.execute(phase0.sql);
    await database.execute(phase1.sql);
    const userId = "10000000-0000-4000-8000-000000000099";
    const conversationId = "95000000-0000-4000-8000-000000000099";
    await database.query(
      `INSERT INTO users (id,persona_key,email,display_name,title,status)
       VALUES ($1,'upgrade-user','upgrade@example.invalid','Upgrade User','Test','active')`,
      [userId],
    );
    await database.query(
      `INSERT INTO conversations
       (id,owner_user_id,title,provider,model,router_version,status)
       VALUES ($1,$2,'Legacy sensitive turn','simulated','deterministic-demo-router','phase1-demo-router-v1','active')`,
      [conversationId, userId],
    );
    await database.query(
      `INSERT INTO assistant_messages
       (id,conversation_id,role,content,provider,model,router_version,correlation_id)
       VALUES ('96000000-0000-4000-8000-000000000099',$1,'assistant',
               'Legacy company Northstar Facade Group','simulated','deterministic-demo-router',
               'phase1-demo-router-v1','legacy-sensitive-turn')`,
      [conversationId],
    );
    await database.execute(phase11.sql);
    const repository = new SqlPhase1Repository(database);
    await expect(repository.listAssistantMessages(conversationId, userId)).resolves.toEqual([
      expect.objectContaining({
        content: "Legacy company Northstar Facade Group",
        requiredPermissions: [],
      }),
    ]);
  });

  it("rolls a reset back when deterministic reseeding fails", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedDatabase(database);
    await database.query(
      "UPDATE users SET display_name=$1 WHERE persona_key='owner-administrator'",
      ["Owner before failed reset"],
    );

    await expect(
      resetDemoDatabase(
        database,
        {
          appMode: "demo",
          nodeEnv: "test",
          confirmation: DEMO_RESET_CONFIRMATION,
        },
        async (transaction) => {
          await seedDatabaseOnExecutor(transaction);
          throw new Error("synthetic reseed failure");
        },
      ),
    ).rejects.toThrow("synthetic reseed failure");

    const owner = await database.query<{ display_name: string }>(
      "SELECT display_name FROM users WHERE persona_key='owner-administrator'",
    );
    expect(owner.rows[0]?.display_name).toBe("Owner before failed reset");
    expect(await countRows(database, "users")).toBe(6);
    expect(await countRows(database, "audit_logs")).toBe(1);
  });
});
