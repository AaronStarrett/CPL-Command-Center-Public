import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeterministicDemoMalwareScanner,
  RepositoryArtifactFileStore,
  validateArtifactUploadWithScanner,
} from "../../packages/artifacts/src/index.js";
import {
  PGliteDatabaseAdapter,
  SqlAiProviderRepository,
  SqlFoundationRepository,
  SqlPhase1Repository,
  migrateDatabase,
  seedDatabase,
} from "../../packages/database/src/index.js";
import {
  DEMO_ROLE_IDS,
  PERMISSIONS,
  PersistentAuthorizationService,
} from "../../packages/security/src/index.js";
import {
  requirePersistedArtifactAccess,
  type PersistedArtifactAccessContext,
} from "../../apps/web/lib/artifact-access.js";
import { createArtifactAuditSink } from "../../apps/web/lib/artifact-audit.js";
import { createUploadedArtifactManifest } from "../../apps/web/lib/artifact-upload-manifest.js";
import { persistUploadedArtifact } from "../../apps/web/lib/artifact-upload-persistence.js";

vi.mock("server-only", () => ({}));

let database: PGliteDatabaseAdapter | undefined;
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const cleanupDirectories: string[] = [];

afterEach(async () => {
  await database?.close();
  database = undefined;
  for (const directory of cleanupDirectories.splice(0).reverse()) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("artifact route audit persistence", () => {
  it("stores safe artifact-file linkage without writing a non-UUID file ID into resource_id", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedDatabase(database);
    const repository = new SqlFoundationRepository(database);
    const audit = createArtifactAuditSink(repository);
    const artifactFileId = "art_0123456789abcdef0123456789abcdef";

    await audit.record({
      action: "download",
      actorId: "10000000-0000-4000-8000-000000000001",
      artifactId: artifactFileId,
      correlationId: "artifact-route-audit-pglite",
      outcome: "allowed",
      ownerId: "10000000-0000-4000-8000-000000000001",
    });

    await expect(repository.listAuditLogs(1)).resolves.toEqual([
      expect.objectContaining({
        action: "artifact.download",
        correlationId: "artifact-route-audit-pglite",
        metadata: {
          artifactFileId,
          artifactOutcome: "allowed",
          ownerScoped: true,
        },
        outcome: "allowed",
        resourceId: null,
        resourceType: "artifact",
      }),
    ]);
  });

  it("rechecks every persisted artifact permission and hides same-owner access after role revocation", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedDatabase(database);
    const repository = new SqlFoundationRepository(database);
    const phase1 = new SqlPhase1Repository(database);
    const persistence = new SqlAiProviderRepository(database);
    const authorization = new PersistentAuthorizationService(repository, repository);
    const ownerId = "10000000-0000-4000-8000-000000000001";
    const artifactFileId = "art_abcdef0123456789abcdef0123456789";
    const conversation = await phase1.createConversation({
      ownerUserId: ownerId,
      title: "Persisted artifact permission revocation",
    });
    await persistence.recordGeneratedArtifact({
      conversationId: conversation.id,
      responseRunId: null,
      requestedByUserId: ownerId,
      kind: "pdf",
      title: "Permission-bound synthetic PDF",
      status: "ready",
      artifactVersion: 1,
      provider: "demo",
      providerItemId: null,
      providerContainerId: null,
      providerFileId: null,
      filename: "permission-bound.pdf",
      mediaType: "application/pdf",
      storageReference: artifactFileId,
      specification: { renderer: "pdf", schemaVersion: 1 },
      sourceMetadata: { dataStatus: "synthetic" },
      citationIds: [],
      fileMetadata: { artifactFileId },
      renderMetadata: { renderer: "pdf" },
      generationMetadata: { mode: "deterministic_demo" },
      requiredPermissions: [PERMISSIONS.DOCUMENTS_VIEW, PERMISSIONS.SEARCH_VIEW],
      simulated: true,
      errorCode: null,
    });
    const context = {
      authorization: {
        actorId: ownerId,
        correlationId: "artifact-required-permission-revocation",
        ownerId,
        permissions: ["artifacts:read", "artifacts:download"],
      },
      correlationId: "artifact-required-permission-revocation",
      ok: true,
      runtime: {
        ai: { persistence },
        authorization,
        repository,
      },
    } as unknown as PersistedArtifactAccessContext;

    await expect(
      requirePersistedArtifactAccess(context, artifactFileId, "preview"),
    ).resolves.toBeNull();
    await database.query(
      `DELETE FROM role_permissions
       WHERE role_id=(SELECT id FROM roles WHERE key=$1)
         AND permission_id=(SELECT id FROM permissions WHERE key=$2)`,
      [DEMO_ROLE_IDS.OWNER_ADMIN, PERMISSIONS.SEARCH_VIEW],
    );

    const deniedPayloads: unknown[] = [];
    for (const action of ["preview", "download", "refresh"] as const) {
      const response = await requirePersistedArtifactAccess(context, artifactFileId, action);
      expect(response?.status).toBe(404);
      deniedPayloads.push(await response?.json());
    }
    expect(deniedPayloads).toEqual([deniedPayloads[0], deniedPayloads[0], deniedPayloads[0]]);
    const auditLogs = (await repository.listAuditLogs(20)).filter(
      (event) => event.correlationId === "artifact-required-permission-revocation",
    );
    expect(auditLogs).toHaveLength(3);
    expect(auditLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "artifact.preview",
          outcome: "denied",
          resourceId: null,
          metadata: expect.objectContaining({
            artifactFileId,
            permission: PERMISSIONS.SEARCH_VIEW,
            reason: "permission-not-granted",
          }),
        }),
        expect.objectContaining({ action: "artifact.download", outcome: "denied" }),
        expect.objectContaining({ action: "artifact.refresh", outcome: "denied" }),
      ]),
    );
  });

  it("rolls back generated workspace and persisted-audit rows while releasing only the failed upload lease", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedDatabase(database);
    const phase1 = new SqlPhase1Repository(database);
    const ownerId = "10000000-0000-4000-8000-000000000001";
    const dataDirectory = join(repositoryRoot, ".data");
    await mkdir(dataDirectory, { recursive: true });
    const rootDirectory = await mkdtemp(join(dataDirectory, "artifact-upload-atomicity-"));
    cleanupDirectories.push(rootDirectory);
    const store = new RepositoryArtifactFileStore({ repositoryRoot, rootDirectory });

    const scenarios = [
      {
        correlationId: "artifact-atomic-generated-failure",
        filename: "atomic-generated-failure.csv",
        installFailure: () =>
          database!.execute(
            `ALTER TABLE generated_artifacts ADD CONSTRAINT reject_atomic_generated
             CHECK (title <> 'atomic-generated-failure.csv')`,
          ),
      },
      {
        correlationId: "artifact-atomic-workspace-failure",
        filename: "atomic-workspace-failure.csv",
        installFailure: () =>
          database!.execute(
            `ALTER TABLE workspace_artifacts ADD CONSTRAINT reject_atomic_workspace
             CHECK (title <> 'atomic-workspace-failure.csv')`,
          ),
      },
      {
        correlationId: "artifact-atomic-audit-failure",
        filename: "atomic-audit-failure.csv",
        installFailure: () =>
          database!.execute(
            `ALTER TABLE audit_logs ADD CONSTRAINT reject_atomic_audit
             CHECK (correlation_id <> 'artifact-atomic-audit-failure')`,
          ),
      },
    ] as const;

    for (const scenario of scenarios) {
      const conversation = await phase1.createConversation({
        ownerUserId: ownerId,
        title: scenario.correlationId,
      });
      const upload = await validateArtifactUploadWithScanner(
        {
          bytes: new TextEncoder().encode(`system,observation\nRoof,${scenario.filename}\n`),
          filename: scenario.filename,
          mimeType: "text/csv",
        },
        new DeterministicDemoMalwareScanner(),
        { allowSimulatedClean: true },
      );
      const priorLease = await store.putValidatedUpload(ownerId, upload);
      const operationLease = await store.putValidatedUpload(ownerId, upload);
      expect(operationLease.id).toBe(priorLease.id);
      const manifest = createUploadedArtifactManifest(operationLease, ownerId);
      await scenario.installFailure();

      await expect(
        persistUploadedArtifact({
          artifact: operationLease,
          conversationId: conversation.id,
          correlationId: scenario.correlationId,
          database,
          manifest,
          ownerId,
        }),
      ).rejects.toThrow();
      await store.delete(ownerId, operationLease.id);

      const [generated, workspace, audit] = await Promise.all([
        database.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM generated_artifacts WHERE storage_reference=$1",
          [operationLease.id],
        ),
        database.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM workspace_artifacts WHERE conversation_id=$1 AND title=$2",
          [conversation.id, scenario.filename],
        ),
        database.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM audit_logs WHERE correlation_id=$1",
          [scenario.correlationId],
        ),
      ]);
      expect([generated, workspace, audit].map((result) => Number(result.rows[0]?.count))).toEqual([
        0, 0, 0,
      ]);
      const preservedLease = await store.get(ownerId, priorLease.id);
      expect(preservedLease).toMatchObject({
        metadata: { ...priorLease, expiresAt: expect.any(String) },
      });
      expect(Date.parse(preservedLease.metadata.expiresAt)).toBeGreaterThanOrEqual(
        Date.parse(priorLease.expiresAt),
      );
    }
  });
});
