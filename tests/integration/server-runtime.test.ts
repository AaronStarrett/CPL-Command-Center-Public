import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_PERSONAS, DEMO_ROLE_IDS } from "../../packages/domain/src/index.js";
import { PERMISSIONS } from "../../packages/security/src/index.js";
import { createServerRuntime, type BeaServerRuntime } from "../../packages/database/src/index.js";
import {
  confirmAiTaskActionWithRuntime,
  getAiCommandSnapshotWithRuntime,
  processAiCommandMessageWithRuntime,
  reserveAiCommandRequestWithRuntime,
} from "../../apps/web/lib/ai-command.js";
import { processAiCommandStream } from "../../apps/web/lib/ai-command-stream.js";
import { getPermissionAwareCompanyContacts } from "../../apps/web/lib/company-contacts.js";

vi.mock("server-only", () => ({}));

let runtime: BeaServerRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe("validated SQL server runtime", () => {
  it("preserves deterministic task company connector and action-preview routing through stream", async () => {
    runtime = await createServerRuntime({
      loadEnvFile: false,
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        DEMO_AUTH_ENABLED: "true",
        LOG_LEVEL: "silent",
        OPENAI_API_KEY: "",
      },
    });
    const owner = DEMO_PERSONAS.find((persona) =>
      persona.roleIds.includes(DEMO_ROLE_IDS.OWNER_ADMIN),
    );
    if (!owner) throw new Error("Owner persona is missing.");
    const conversation = await runtime.phase1.createConversation({
      ownerUserId: owner.id,
      title: "Stream legacy routing regression",
    });
    const providerStream = vi.spyOn(runtime.ai.registry.get("demo"), "streamResponse");
    const commands = [
      ["Show open tasks", "task-list"],
      ["Show all companies", "company-list"],
      ["Show connector health", "integration-health-summary"],
      ["Create an internal follow-up task", "action-preview"],
    ] as const;
    for (const [message, expectedArtifact] of commands) {
      const reservation = await reserveAiCommandRequestWithRuntime(runtime, {
        userId: owner.id,
        conversationId: conversation.id,
        correlationId: `legacy-reserve-${expectedArtifact}`,
      });
      const events = [];
      for await (const event of processAiCommandStream({
        runtime,
        userId: owner.id,
        conversationId: conversation.id,
        message,
        ...reservation,
        correlationId: `legacy-stream-${expectedArtifact}`,
        webSearch: false,
        builtInTools: [],
        confirmHighCostTools: false,
        inputMode: "text",
        inputArtifactIds: [],
      }))
        events.push(event);
      expect(events.at(-1)?.type).toBe("response.completed");
      const snapshot = await getAiCommandSnapshotWithRuntime(runtime, owner.id, conversation.id);
      expect(snapshot.artifact.type).toBe(expectedArtifact);
    }
    expect(providerStream).not.toHaveBeenCalled();
  }, 60_000);

  it("persists bounded partial and cancelled assistant states from terminal stream events", async () => {
    runtime = await createServerRuntime({
      loadEnvFile: false,
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        DEMO_AUTH_ENABLED: "true",
        LOG_LEVEL: "silent",
        OPENAI_API_KEY: "",
      },
    });
    const owner = DEMO_PERSONAS.find((persona) =>
      persona.roleIds.includes(DEMO_ROLE_IDS.OWNER_ADMIN),
    );
    if (!owner) throw new Error("Owner persona is missing.");
    const conversation = await runtime.phase1.createConversation({
      ownerUserId: owner.id,
      title: "Durable partial stream",
    });
    const provider = runtime.ai.registry.get("demo");
    const stream = vi.spyOn(provider, "streamResponse");
    stream.mockImplementationOnce(async function* (providerRequest) {
      yield {
        type: "response.started",
        requestId: providerRequest.options.requestId,
        providerResponseId: "demo-partial-response",
        model: providerRequest.model,
        simulated: true,
      };
      yield { type: "response.output_text.delta", delta: "Partial answer retained" };
      yield { type: "response.error", code: "timeout", safeMessage: "Timed out.", retryable: true };
    });
    const firstReservation = await reserveAiCommandRequestWithRuntime(runtime, {
      userId: owner.id,
      conversationId: conversation.id,
    });
    const firstEvents = [];
    for await (const event of processAiCommandStream({
      runtime,
      userId: owner.id,
      conversationId: conversation.id,
      message: "Explain the synthetic risk fixture",
      ...firstReservation,
      correlationId: "partial-stream-error",
      webSearch: false,
      builtInTools: [],
      confirmHighCostTools: false,
      inputMode: "text",
      inputArtifactIds: [],
    }))
      firstEvents.push(event);
    expect(firstEvents.at(-1)).toMatchObject({ type: "response.error", code: "timeout" });
    let messages = await runtime.phase1.listAssistantMessages(conversation.id, owner.id);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Partial answer retained",
      responseStatus: "incomplete",
      incompleteReason: "timeout",
    });

    stream.mockImplementationOnce(async function* (providerRequest) {
      yield {
        type: "response.started",
        requestId: providerRequest.options.requestId,
        providerResponseId: "demo-cancelled-response",
        model: providerRequest.model,
        simulated: true,
      };
      yield { type: "response.output_text.delta", delta: "Cancelled partial retained" };
      yield { type: "response.cancelled", requestId: providerRequest.options.requestId };
    });
    const secondReservation = await reserveAiCommandRequestWithRuntime(runtime, {
      userId: owner.id,
      conversationId: conversation.id,
    });
    const secondEvents = [];
    for await (const event of processAiCommandStream({
      runtime,
      userId: owner.id,
      conversationId: conversation.id,
      message: "Explain another synthetic risk fixture",
      ...secondReservation,
      correlationId: "partial-stream-cancel",
      webSearch: false,
      builtInTools: [],
      confirmHighCostTools: false,
      inputMode: "text",
      inputArtifactIds: [],
    }))
      secondEvents.push(event);
    expect(secondEvents.at(-1)?.type).toBe("response.cancelled");
    messages = await runtime.phase1.listAssistantMessages(conversation.id, owner.id);
    expect(messages.at(-1)).toMatchObject({
      content: "Cancelled partial retained",
      responseStatus: "cancelled",
      incompleteReason: "CANCELLED",
    });
    const runs = await runtime.database.query<{ status: string }>(
      "SELECT status FROM ai_response_runs ORDER BY started_at,id",
    );
    expect(runs.rows.map((row) => row.status)).toEqual(["incomplete", "cancelled"]);
    const artifacts = await runtime.phase1.listWorkspaceArtifacts(conversation.id, owner.id, 10);
    expect(artifacts.slice(0, 2).every((artifact) => artifact.state === "failed")).toBe(true);
  }, 60_000);

  it("persists a terminal failure when response-run creation fails after reservation consumption", async () => {
    runtime = await createServerRuntime({
      loadEnvFile: false,
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        DEMO_AUTH_ENABLED: "true",
        LOG_LEVEL: "silent",
        OPENAI_API_KEY: "",
      },
    });
    const owner = DEMO_PERSONAS.find((persona) =>
      persona.roleIds.includes(DEMO_ROLE_IDS.OWNER_ADMIN),
    );
    if (!owner) throw new Error("Owner persona is missing.");
    const conversation = await runtime.phase1.createConversation({
      ownerUserId: owner.id,
      title: "Response-run start failure",
    });
    const reservation = await reserveAiCommandRequestWithRuntime(runtime, {
      userId: owner.id,
      conversationId: conversation.id,
    });
    vi.spyOn(runtime.ai.persistence, "beginResponseRun").mockRejectedValueOnce(
      new Error("synthetic response-run start failure"),
    );

    await expect(
      (async () => {
        for await (const event of processAiCommandStream({
          runtime,
          userId: owner.id,
          conversationId: conversation.id,
          message: "Explain the synthetic risk fixture",
          ...reservation,
          correlationId: "response-run-start-failure",
          webSearch: false,
          builtInTools: [],
          confirmHighCostTools: false,
          inputMode: "text",
          inputArtifactIds: [],
        })) {
          void event;
          // The setup failure occurs before the provider can yield an event.
        }
      })(),
    ).rejects.toThrow("synthetic response-run start failure");

    const messages = await runtime.phase1.listAssistantMessages(conversation.id, owner.id);
    expect(messages.slice(-2)).toEqual([
      expect.objectContaining({ role: "user", content: "Explain the synthetic risk fixture" }),
      expect.objectContaining({
        role: "assistant",
        responseStatus: "failed",
        incompleteReason: "RESPONSE_RUN_START_FAILED",
      }),
    ]);
    const artifacts = await runtime.phase1.listWorkspaceArtifacts(conversation.id, owner.id, 1);
    expect(artifacts[0]).toMatchObject({
      state: "failed",
      errorCode: "RESPONSE_RUN_START_FAILED",
    });
    const runs = await runtime.database.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM ai_response_runs WHERE request_id=$1",
      [reservation.requestId],
    );
    expect(runs.rows[0]?.count).toBe(0);
  }, 60_000);

  it("executes no-key Demo web chart PDF and image flows through the shared stream", async () => {
    runtime = await createServerRuntime({
      loadEnvFile: false,
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        DEMO_AUTH_ENABLED: "true",
        LOG_LEVEL: "silent",
        OPENAI_API_KEY: "",
      },
    });
    expect(runtime.ai.secrets.status().openAiApiKey).toBe("not_configured");
    const owner = DEMO_PERSONAS.find((persona) =>
      persona.roleIds.includes(DEMO_ROLE_IDS.OWNER_ADMIN),
    );
    if (!owner) throw new Error("Owner persona is missing.");
    const conversation = await runtime.phase1.createConversation({
      ownerUserId: owner.id,
      title: "No-key Demo artifact parity",
    });
    const demoSnapshot = await getAiCommandSnapshotWithRuntime(runtime, owner.id, conversation.id);
    expect(demoSnapshot.provider).toMatchObject({
      mode: "demo",
      status: "SIMULATED",
      liveConnected: false,
      webSearchAllowed: true,
      webSearchDefault: false,
      codeInterpreterAllowed: true,
      imageGenerationAllowed: true,
      pdfGenerationAllowed: true,
    });
    const cases = [
      ["Research synthetic envelope sources", true, "source-board"],
      ["Build a chart from the synthetic fixture", false, "chart"],
      ["Prepare a PDF from the synthetic fixture", false, "pdf"],
      ["Generate an image from the synthetic fixture", false, "image"],
    ] as const;
    for (const [message, webSearch, renderer] of cases) {
      const reservation = await reserveAiCommandRequestWithRuntime(runtime, {
        userId: owner.id,
        conversationId: conversation.id,
      });
      const events = [];
      for await (const event of processAiCommandStream({
        runtime,
        userId: owner.id,
        conversationId: conversation.id,
        message,
        ...reservation,
        correlationId: `demo-${renderer}`,
        webSearch,
        builtInTools: webSearch ? ["web_search"] : [],
        confirmHighCostTools: false,
        inputMode: "text",
        inputArtifactIds: [],
      }))
        events.push(event);
      expect(events.at(-1)).toMatchObject({
        type: "response.completed",
        result: { simulated: true },
      });
      const artifact = (
        await runtime.phase1.listWorkspaceArtifacts(conversation.id, owner.id, 1)
      )[0];
      expect(artifact).toMatchObject({ state: "ready", payload: { renderer } });
      if (renderer === "source-board") {
        const sourceBoardRows = await runtime.database.query<{ kind: string; status: string }>(
          `SELECT kind,status FROM generated_artifacts WHERE response_run_id=(
             SELECT id FROM ai_response_runs WHERE correlation_id=$1 ORDER BY created_at DESC LIMIT 1
           ) ORDER BY kind`,
          [`demo-${renderer}`],
        );
        expect(sourceBoardRows.rows.length).toBeGreaterThanOrEqual(5);
        expect(sourceBoardRows.rows).toEqual(
          expect.arrayContaining([{ kind: "source_board", status: "ready" }]),
        );
        expect(sourceBoardRows.rows.every((row) => row.status === "ready")).toBe(true);
      }
    }
    const persisted = await runtime.database.query<{ status: string; simulated: boolean }>(
      "SELECT status,simulated FROM generated_artifacts ORDER BY created_at,id",
    );
    expect(persisted.rows.length).toBeGreaterThanOrEqual(4);
    expect(
      persisted.rows.every((artifact) => artifact.status === "ready" && artifact.simulated),
    ).toBe(true);
  }, 90_000);

  it("leaves no READY generated artifact orphan when completion metadata persistence fails", async () => {
    runtime = await createServerRuntime({
      loadEnvFile: false,
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        DEMO_AUTH_ENABLED: "true",
        LOG_LEVEL: "silent",
        OPENAI_API_KEY: "",
      },
    });
    const owner = DEMO_PERSONAS.find((persona) =>
      persona.roleIds.includes(DEMO_ROLE_IDS.OWNER_ADMIN),
    );
    if (!owner) throw new Error("Owner persona is missing.");
    const conversation = await runtime.phase1.createConversation({
      ownerUserId: owner.id,
      title: "Completion metadata atomicity",
    });
    const persistedCompleteResponseRun = runtime.ai.persistence.completeResponseRun.bind(
      runtime.ai.persistence,
    );
    vi.spyOn(runtime.ai.persistence, "completeResponseRun").mockImplementation(async (event) => {
      if (event.status === "completed") {
        throw new Error("synthetic response-run completion failure");
      }
      return persistedCompleteResponseRun(event);
    });
    const reservation = await reserveAiCommandRequestWithRuntime(runtime, {
      userId: owner.id,
      conversationId: conversation.id,
    });
    const events = [];
    await expect(
      (async () => {
        for await (const event of processAiCommandStream({
          runtime,
          userId: owner.id,
          conversationId: conversation.id,
          message: "Generate an image from the synthetic fixture",
          ...reservation,
          correlationId: "metadata-atomicity",
          webSearch: false,
          builtInTools: [],
          confirmHighCostTools: false,
          inputMode: "text",
          inputArtifactIds: [],
        }))
          events.push(event);
      })(),
    ).rejects.toThrow("synthetic response-run completion failure");
    const generated = await runtime.database.query<{
      status: string;
      storage_reference: string | null;
      error_code: string | null;
    }>(
      `SELECT status,storage_reference,error_code FROM generated_artifacts
       WHERE response_run_id=(
         SELECT id FROM ai_response_runs WHERE correlation_id=$1 ORDER BY created_at DESC LIMIT 1
       )`,
      ["metadata-atomicity"],
    );
    expect(generated.rows.length).toBeGreaterThan(0);
    expect(generated.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          storage_reference: null,
          error_code: "RESPONSE_METADATA_PERSISTENCE_FAILED",
        }),
      ]),
    );
    expect(generated.rows.some((artifact) => artifact.status === "ready")).toBe(false);
    const workspace = await runtime.phase1.listWorkspaceArtifacts(conversation.id, owner.id, 1);
    expect(workspace[0]).toMatchObject({
      state: "failed",
      errorCode: "RESPONSE_METADATA_PERSISTENCE_FAILED",
    });
  }, 90_000);

  it("backs sessions, database RBAC, settings, audit, workflow, and health with PGlite", async () => {
    runtime = await createServerRuntime({
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        DEMO_AUTH_ENABLED: "true",
        LOG_LEVEL: "silent",
      },
    });
    const signIn = await runtime.authentication.signIn("sales-specialist", "runtime-auth");
    expect(await runtime.repository.countActiveSessions()).toBe(1);
    expect(await runtime.authentication.authenticate(signIn.sessionToken)).toMatchObject({
      id: signIn.user.id,
    });
    expect(
      await runtime.authorization.authorizeUser(signIn.user.id, PERMISSIONS.ADMINISTRATION_VIEW),
    ).toMatchObject({ allowed: false });
    await runtime.database.query(
      `INSERT INTO role_permissions (role_id,permission_id,created_at)
       SELECT r.id,p.id,CURRENT_TIMESTAMP FROM roles r CROSS JOIN permissions p
       WHERE r.key='sales' AND p.key=$1 ON CONFLICT (role_id,permission_id) DO NOTHING`,
      [PERMISSIONS.ADMINISTRATION_VIEW],
    );
    expect(
      await runtime.authorization.authorizeUser(signIn.user.id, PERMISSIONS.ADMINISTRATION_VIEW),
    ).toEqual({ allowed: true });
    expect(
      (await runtime.repository.listRoleGrantSummaries()).find((role) => role.roleId === "sales")
        ?.permissionCount,
    ).toBeGreaterThan(0);
    expect(await runtime.featureFlags.isEnabled("lead-intake")).toBe(false);
    const flag = await runtime.featureFlags.setEnabled({
      key: "lead-intake",
      enabled: true,
      actorUserId: signIn.user.id,
      correlationId: "settings-correlation",
    });
    expect(flag.enabled).toBe(true);
    await expect(
      runtime.featureFlags.setEnabled({
        key: "lead-intake",
        enabled: false,
        actorUserId: signIn.user.id,
        expectedVersion: flag.version - 1,
      }),
    ).rejects.toMatchObject({ code: "CONCURRENT_UPDATE" });
    const setting = await runtime.settings.set({
      key: "product.legal-entity-name",
      value: "UNRESOLVED",
      actorUserId: signIn.user.id,
    });
    expect(setting.value).toBe("UNRESOLVED");
    await expect(
      runtime.settings.set({
        key: "product.legal-entity-name",
        value: "stale update",
        actorUserId: signIn.user.id,
        expectedVersion: setting.version - 1,
      }),
    ).rejects.toMatchObject({ code: "CONCURRENT_UPDATE" });
    const workflow = await runtime.workflow.execute({
      idempotencyKey: "runtime:health:v1",
      actorUserId: signIn.user.id,
    });
    expect(workflow.run.status).toBe("succeeded");
    expect(await runtime.repository.listWorkflowStepRuns(workflow.run.id)).toHaveLength(2);
    expect(
      (await runtime.repository.listAuditLogs()).some(
        (event) => event.eventType === "feature-flag.changed",
      ),
    ).toBe(true);
    expect((await runtime.health()).status).toBe("healthy");
    expect(await runtime.authentication.signOut(signIn.sessionToken)).toBe(true);
    await expect(
      runtime.authentication.switchPersona(signIn.sessionToken, "operations-coordinator"),
    ).rejects.toThrow("active demo session");
  }, 30_000);

  it("denies connector-only integration administrators before task preview state is created", async () => {
    runtime = await createServerRuntime({
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        DEMO_AUTH_ENABLED: "true",
        LOG_LEVEL: "silent",
      },
    });
    const integrationAdmin = DEMO_PERSONAS.find((persona) =>
      persona.roleIds.includes(DEMO_ROLE_IDS.INTEGRATION_ADMIN),
    );
    if (!integrationAdmin) throw new Error("Integration administrator persona is missing.");
    const conversation = await runtime.phase1.createConversation({
      ownerUserId: integrationAdmin.id,
      title: "Connector-only task preview denial",
    });
    const reservation = await reserveAiCommandRequestWithRuntime(runtime, {
      userId: integrationAdmin.id,
      conversationId: conversation.id,
      correlationId: "integration-admin-task-preview-denial-reservation",
    });

    await expect(
      processAiCommandMessageWithRuntime(runtime, {
        userId: integrationAdmin.id,
        conversationId: conversation.id,
        message: 'Create an internal task titled "Unauthorized connector task"',
        ...reservation,
        correlationId: "integration-admin-task-preview-denial",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(
      runtime.phase1.listSuggestedActions(conversation.id, integrationAdmin.id),
    ).resolves.toEqual([]);
    await expect(
      runtime.phase1.listWorkspaceArtifacts(conversation.id, integrationAdmin.id),
    ).resolves.toEqual([]);
    expect(
      (await runtime.repository.listAuditLogs()).some(
        (event) =>
          event.eventType === "authorization.denied" &&
          event.action === "ai-command.task.preview" &&
          event.actorUserId === integrationAdmin.id &&
          event.metadata.permission === PERMISSIONS.TASKS_VIEW,
      ),
    ).toBe(true);
  }, 30_000);

  it("keeps delayed older submission from replacing newer reserved AI state", async () => {
    runtime = await createServerRuntime({
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        DEMO_AUTH_ENABLED: "true",
        LOG_LEVEL: "silent",
      },
    });
    const owner = DEMO_PERSONAS.find((persona) =>
      persona.roleIds.includes(DEMO_ROLE_IDS.OWNER_ADMIN),
    );
    if (!owner) throw new Error("Owner persona is missing.");
    const conversation = await runtime.phase1.createConversation({
      ownerUserId: owner.id,
      title: "Out-of-order AI Command responses",
    });
    const older = await reserveAiCommandRequestWithRuntime(runtime, {
      userId: owner.id,
      conversationId: conversation.id,
      correlationId: "phase11-service-older-reservation",
    });
    const newer = await reserveAiCommandRequestWithRuntime(runtime, {
      userId: owner.id,
      conversationId: conversation.id,
      correlationId: "phase11-service-newest-reservation",
    });
    const newestSnapshot = await processAiCommandMessageWithRuntime(runtime, {
      userId: owner.id,
      conversationId: conversation.id,
      message: "Show all companies",
      ...newer,
      correlationId: "phase11-service-newest",
    });
    const olderHttpSnapshot = await processAiCommandMessageWithRuntime(runtime, {
      userId: owner.id,
      conversationId: conversation.id,
      message: 'Create an internal task titled "Delayed stale action"',
      ...older,
      correlationId: "phase11-service-older",
    });

    expect(olderHttpSnapshot.artifact.id).toBe(newestSnapshot.artifact.id);
    expect(olderHttpSnapshot.artifact.title).toBe(newestSnapshot.artifact.title);
    const messages = await runtime.phase1.listAssistantMessages(conversation.id, owner.id, 20);
    expect(messages.filter((message) => message.role === "assistant")).toEqual([
      expect.objectContaining({ correlationId: "phase11-service-newest" }),
    ]);
    expect(messages.filter((message) => message.role === "user")).toEqual([
      expect.objectContaining({ correlationId: "phase11-service-newest" }),
    ]);
    expect(await runtime.phase1.listWorkspaceArtifacts(conversation.id, owner.id)).toHaveLength(1);
    expect(await runtime.phase1.listSuggestedActions(conversation.id, owner.id)).toEqual([]);
  }, 30_000);

  it("enforces permission-aware company-scoped minimal contact options without full-list leakage", async () => {
    runtime = await createServerRuntime({
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        DEMO_AUTH_ENABLED: "true",
        LOG_LEVEL: "silent",
      },
    });
    const owner = DEMO_PERSONAS.find((persona) =>
      persona.roleIds.includes(DEMO_ROLE_IDS.OWNER_ADMIN),
    );
    const integrationAdmin = DEMO_PERSONAS.find((persona) =>
      persona.roleIds.includes(DEMO_ROLE_IDS.INTEGRATION_ADMIN),
    );
    if (!owner || !integrationAdmin) throw new Error("Required demo personas are missing.");

    const northstar = await getPermissionAwareCompanyContacts(
      runtime,
      owner.id,
      "90000000-0000-4000-8000-000000000001",
    );
    expect(northstar).toMatchObject({
      ok: true,
      companyId: "90000000-0000-4000-8000-000000000001",
      contacts: [
        { id: "91000000-0000-4000-8000-000000000001", label: "Morgan Demo" },
        { id: "91000000-0000-4000-8000-000000000004", label: "Casey Example" },
      ],
    });
    if (!northstar.ok) throw new Error("Owner contact lookup should be authorized.");
    expect(northstar.contacts).toHaveLength(2);
    for (const contact of northstar.contacts) {
      expect(Object.keys(contact).sort()).toEqual(["id", "label"]);
    }

    const harborview = await getPermissionAwareCompanyContacts(
      runtime,
      owner.id,
      "90000000-0000-4000-8000-000000000002",
    );
    expect(harborview).toMatchObject({
      ok: true,
      contacts: [{ label: "Taylor Sample" }],
    });
    expect(JSON.stringify(harborview)).not.toContain("Morgan Demo");

    const getCompany = vi.spyOn(runtime.phase1, "getCompany");
    const listContacts = vi.spyOn(runtime.phase1, "listContacts");
    const denied = await getPermissionAwareCompanyContacts(
      runtime,
      integrationAdmin.id,
      "90000000-0000-4000-8000-000000000001",
    );
    expect(denied).toMatchObject({ ok: false, status: 403, code: "permission-not-granted" });
    expect("contacts" in denied).toBe(false);
    expect(JSON.stringify(denied)).not.toMatch(/Morgan Demo|Casey Example|Taylor Sample/u);
    expect(getCompany).not.toHaveBeenCalled();
    expect(listContacts).not.toHaveBeenCalled();
  }, 30_000);

  it("rejects mismatched AI task contacts without creating an action or success evidence", async () => {
    runtime = await createServerRuntime({
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        DEMO_AUTH_ENABLED: "true",
        LOG_LEVEL: "silent",
      },
    });
    const owner = DEMO_PERSONAS.find((persona) =>
      persona.roleIds.includes(DEMO_ROLE_IDS.OWNER_ADMIN),
    );
    if (!owner) throw new Error("Owner persona is missing.");
    const conversation = await runtime.phase1.createConversation({
      ownerUserId: owner.id,
      title: "AI task relationship validation",
    });
    const correlationId = "phase11-ai-contact-mismatch";
    const reservation = await reserveAiCommandRequestWithRuntime(runtime, {
      userId: owner.id,
      conversationId: conversation.id,
      correlationId: `${correlationId}-reservation`,
    });
    const snapshot = await processAiCommandMessageWithRuntime(runtime, {
      userId: owner.id,
      conversationId: conversation.id,
      message:
        'Create an internal task titled "Relationship mismatch" for company Northstar Facade Group for contact Taylor Sample',
      ...reservation,
      correlationId,
    });

    expect(snapshot.artifact).toMatchObject({
      type: "error",
      state: "failed",
      payload: { field: "contactId", actionable: false },
    });
    expect(await runtime.phase1.listSuggestedActions(conversation.id, owner.id)).toEqual([]);
    const evidence = await runtime.database.query<{
      activities: string | number;
      audits: string | number;
      tasks: string | number;
    }>(
      `SELECT
       (SELECT COUNT(*) FROM tasks WHERE title='Relationship mismatch') AS tasks,
       (SELECT COUNT(*) FROM activities WHERE correlation_id=$1 AND type='action.previewed') AS activities,
       (SELECT COUNT(*) FROM audit_logs WHERE correlation_id=$1 AND outcome='succeeded') AS audits`,
      [correlationId],
    );
    expect({
      activities: Number(evidence.rows[0]?.activities ?? -1),
      audits: Number(evidence.rows[0]?.audits ?? -1),
      tasks: Number(evidence.rows[0]?.tasks ?? -1),
    }).toEqual({ activities: 0, audits: 0, tasks: 0 });
  }, 30_000);

  it("redacts historical entity turns and blocks linked task execution after permission revocation", async () => {
    runtime = await createServerRuntime({
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        DEMO_AUTH_ENABLED: "true",
        LOG_LEVEL: "silent",
      },
    });
    const owner = DEMO_PERSONAS.find((persona) =>
      persona.roleIds.includes(DEMO_ROLE_IDS.OWNER_ADMIN),
    );
    if (!owner) throw new Error("Owner persona is missing.");
    const conversation = await runtime.phase1.createConversation({
      ownerUserId: owner.id,
      title: "Permission provenance and revocation",
    });
    const send = async (message: string, correlationId: string) => {
      const reservation = await reserveAiCommandRequestWithRuntime(runtime as BeaServerRuntime, {
        userId: owner.id,
        conversationId: conversation.id,
        correlationId: `${correlationId}-reservation`,
      });
      return processAiCommandMessageWithRuntime(runtime as BeaServerRuntime, {
        userId: owner.id,
        conversationId: conversation.id,
        message,
        ...reservation,
        correlationId,
      });
    };
    await send("Show contacts for Northstar Facade Group", "phase11-sensitive-history");
    await send("Explain an unsupported demo capability", "phase11-ai-only-history");
    const beforePreviewConversation = await runtime.phase1.getConversation(
      conversation.id,
      owner.id,
    );
    if (!beforePreviewConversation) throw new Error("Expected owned conversation.");
    const previewPermissions = [
      PERMISSIONS.AI_COMMAND_VIEW,
      PERMISSIONS.TASKS_VIEW,
      PERMISSIONS.COMPANIES_VIEW,
      PERMISSIONS.CONTACTS_VIEW,
    ];
    const action = (
      await runtime.phase1.createSuggestedAction({
        conversationId: conversation.id,
        requestedByUserId: owner.id,
        actionType: "task.create",
        payload: {
          title: "Revoked relationship task",
          assigneeUserId: owner.id,
          companyId: "90000000-0000-4000-8000-000000000001",
          contactId: "91000000-0000-4000-8000-000000000001",
          requiredPermissions: [...previewPermissions, PERMISSIONS.TASK_ACTION_EXECUTE],
          previewConversationVersion: beforePreviewConversation.version + 2,
        },
        requiredPermission: PERMISSIONS.TASK_ACTION_EXECUTE,
        idempotencyKey: "phase11-revoked-preview-action",
        correlationId: "phase11-revoked-preview",
        expiresAt: "2099-12-31T23:59:59.000Z",
      })
    ).action;
    await runtime.phase1.createAssistantMessage({
      conversationId: conversation.id,
      ownerUserId: owner.id,
      role: "assistant",
      content: "Preview for Northstar Facade Group and Morgan Demo.",
      correlationId: "phase11-revoked-preview",
      requiredPermissions: previewPermissions,
    });
    await runtime.phase1.createWorkspaceArtifact({
      conversationId: conversation.id,
      requestedByUserId: owner.id,
      type: "action-preview",
      title: "Create relationship task",
      payload: {
        actionId: action.id,
        company: "Northstar Facade Group",
        contact: "Morgan Demo",
        executable: true,
      },
      sources: [
        {
          id: "90000000-0000-4000-8000-000000000001",
          type: "company",
          title: "Northstar Facade Group",
          href: "/companies/90000000-0000-4000-8000-000000000001",
        },
      ],
      requiredPermissions: previewPermissions,
    });
    const before = await runtime.phase1.listAssistantMessages(conversation.id, owner.id, 50);
    const sensitiveMessage = before.find(
      (message) =>
        message.role === "assistant" && message.correlationId === "phase11-sensitive-history",
    );
    const aiOnlyMessage = before.find(
      (message) =>
        message.role === "assistant" && message.correlationId === "phase11-ai-only-history",
    );
    const previewMessage = before.find(
      (message) =>
        message.role === "assistant" && message.correlationId === "phase11-revoked-preview",
    );
    if (!sensitiveMessage || !aiOnlyMessage || !previewMessage) {
      throw new Error("Expected persisted permission-provenance messages.");
    }
    expect(sensitiveMessage.requiredPermissions).toEqual(
      expect.arrayContaining([PERMISSIONS.COMPANIES_VIEW, PERMISSIONS.CONTACTS_VIEW]),
    );
    expect(aiOnlyMessage.requiredPermissions).toEqual([PERMISSIONS.AI_COMMAND_VIEW]);
    await runtime.database.query(
      `DELETE FROM role_permissions
         WHERE role_id=(SELECT id FROM roles WHERE key=$1)
           AND permission_id IN (SELECT id FROM permissions WHERE key IN ($2,$3))`,
      [DEMO_ROLE_IDS.OWNER_ADMIN, PERMISSIONS.COMPANIES_VIEW, PERMISSIONS.CONTACTS_VIEW],
    );
    const snapshot = await getAiCommandSnapshotWithRuntime(runtime, owner.id, conversation.id);
    expect(snapshot.artifact).toMatchObject({
      type: "empty",
      errorCode: "ARTIFACT_PERMISSION_NOT_GRANTED",
    });
    expect(snapshot.messages.find((message) => message.id === sensitiveMessage.id)?.content).toBe(
      "This persisted assistant response is hidden because its current permissions are not granted.",
    );
    expect(snapshot.messages.find((message) => message.id === previewMessage.id)?.content).toBe(
      "This persisted assistant response is hidden because its current permissions are not granted.",
    );
    expect(snapshot.messages.find((message) => message.id === aiOnlyMessage.id)?.content).toBe(
      aiOnlyMessage.content,
    );
    expect(
      JSON.stringify(snapshot.messages.filter((message) => message.role === "assistant")),
    ).not.toMatch(/Northstar Facade Group|Morgan Demo/u);
    expect(JSON.stringify(snapshot.artifact)).not.toMatch(/Northstar Facade Group|Morgan Demo/u);
    await expect(
      confirmAiTaskActionWithRuntime(runtime, {
        userId: owner.id,
        actionId: action.id,
        correlationId: "phase11-revoked-confirmation",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    const evidence = await runtime.database.query<{
      approvals: string | number;
      executions: string | number;
      tasks: string | number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM tasks WHERE title='Revoked relationship task') AS tasks,
         (SELECT COUNT(*) FROM action_approvals WHERE suggested_action_id=$1) AS approvals,
         (SELECT COUNT(*) FROM action_executions WHERE suggested_action_id=$1) AS executions`,
      [action.id],
    );
    expect(evidence.rows[0]).toMatchObject({ approvals: 0, executions: 0, tasks: 0 });
  }, 30_000);

  it("does not replace a newer reserved generation with task execution presentation", async () => {
    runtime = await createServerRuntime({
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        DEMO_AUTH_ENABLED: "true",
        LOG_LEVEL: "silent",
      },
    });
    const owner = DEMO_PERSONAS.find((persona) =>
      persona.roleIds.includes(DEMO_ROLE_IDS.OWNER_ADMIN),
    );
    if (!owner) throw new Error("Owner persona is missing.");
    const conversation = await runtime.phase1.createConversation({
      ownerUserId: owner.id,
      title: "Atomic confirmation presentation",
    });
    const previewReservation = await reserveAiCommandRequestWithRuntime(runtime, {
      userId: owner.id,
      conversationId: conversation.id,
      correlationId: "phase11-confirm-preview-reservation",
    });
    await processAiCommandMessageWithRuntime(runtime, {
      userId: owner.id,
      conversationId: conversation.id,
      message: 'Create an internal task titled "Interleaved confirmed task"',
      ...previewReservation,
      correlationId: "phase11-confirm-preview",
    });
    const [action] = await runtime.phase1.listSuggestedActions(conversation.id, owner.id);
    if (!action) throw new Error("Expected a task preview action.");
    const approve = runtime.phase1.approveAndExecuteTaskAction.bind(runtime.phase1);
    let newerReservation:
      Awaited<ReturnType<typeof reserveAiCommandRequestWithRuntime>> | undefined;
    vi.spyOn(runtime.phase1, "approveAndExecuteTaskAction").mockImplementationOnce(
      async (input) => {
        const result = await approve(input);
        newerReservation = await reserveAiCommandRequestWithRuntime(runtime as BeaServerRuntime, {
          userId: owner.id,
          conversationId: conversation.id,
          correlationId: "phase11-confirm-newer-reservation",
        });
        return result;
      },
    );
    await confirmAiTaskActionWithRuntime(runtime, {
      userId: owner.id,
      actionId: action.id,
      correlationId: "phase11-confirm-execution",
    });
    if (!newerReservation) throw new Error("Expected an interleaved newer reservation.");
    const [execution] = (
      await runtime.database.query<{ id: string }>(
        "SELECT id FROM action_executions WHERE suggested_action_id=$1",
        [action.id],
      )
    ).rows;
    if (!execution) throw new Error("Expected idempotent task execution evidence.");
    expect(await runtime.phase1.getWorkspaceArtifact(execution.id, owner.id)).toBeNull();
    expect(
      (await runtime.phase1.listAssistantMessages(conversation.id, owner.id, 50)).some(
        (message) => message.id === execution.id,
      ),
    ).toBe(false);
    const newestSnapshot = await processAiCommandMessageWithRuntime(runtime, {
      userId: owner.id,
      conversationId: conversation.id,
      message: "Show all companies",
      ...newerReservation,
      correlationId: "phase11-confirm-newer-message",
    });
    expect(newestSnapshot.artifact.type).toBe("company-list");
    expect(
      await runtime.phase1.listTasks({ query: "Interleaved confirmed task", limit: 10 }),
    ).toHaveLength(1);
  }, 30_000);

  it("rejects malformed AI Command request identifiers before persistence", async () => {
    runtime = await createServerRuntime({
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        DEMO_AUTH_ENABLED: "true",
        LOG_LEVEL: "silent",
      },
    });
    const owner = DEMO_PERSONAS.find((persona) =>
      persona.roleIds.includes(DEMO_ROLE_IDS.OWNER_ADMIN),
    );
    if (!owner) throw new Error("Owner persona is missing.");
    const conversation = await runtime.phase1.createConversation({
      ownerUserId: owner.id,
      title: "Invalid AI request identifier",
    });

    await expect(
      processAiCommandMessageWithRuntime(runtime, {
        userId: owner.id,
        conversationId: conversation.id,
        message: "Show all companies",
        requestId: "not-a-safe-request-id",
        generation: 1,
        correlationId: "phase11-invalid-request-id",
      }),
    ).rejects.toMatchObject({ code: "PHASE1_VALIDATION_FAILED" });
    expect(await runtime.phase1.listAssistantMessages(conversation.id, owner.id)).toEqual([]);
    expect(await runtime.phase1.listWorkspaceArtifacts(conversation.id, owner.id)).toEqual([]);
  }, 30_000);
});
