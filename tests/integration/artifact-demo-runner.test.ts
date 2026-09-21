import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEMO_ARTIFACT_TOOL_DEFINITION,
  DemoArtifactApplicationRunner,
  RepositoryArtifactFileStore,
  type DemoArtifactGenerationBundle,
  type DemoArtifactGenerationPersistence,
  type DemoArtifactRunnerAuditEvent,
  type DemoArtifactRunnerAuthorization,
  type DemoArtifactUsageEvent,
} from "../../packages/artifacts/src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const dataDirectory = join(repositoryRoot, ".data");
const ownerId = "10000000-0000-4000-8000-000000000001";
const otherOwnerId = "10000000-0000-4000-8000-000000000002";
const conversationIds = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
] as const;
const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0).reverse()) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function createHarness(
  options: {
    readonly authorization?: DemoArtifactRunnerAuthorization;
    readonly maxGeneratedFileBytes?: number;
    readonly persistFailure?: boolean;
  } = {},
) {
  await mkdir(dataDirectory, { recursive: true });
  const rootDirectory = await mkdtemp(join(dataDirectory, "artifact-runner-test-"));
  cleanupDirectories.push(rootDirectory);
  const store = new RepositoryArtifactFileStore({ repositoryRoot, rootDirectory });
  await store.initialize();
  const auditEvents: DemoArtifactRunnerAuditEvent[] = [];
  const usageEvents: DemoArtifactUsageEvent[] = [];
  let persistFailure = options.persistFailure === true;
  const persistedBundles: DemoArtifactGenerationBundle[] = [];
  const persisted = new Map<
    string,
    {
      readonly generatedArtifactId: string;
      readonly manifest: DemoArtifactGenerationBundle["pdf"];
      readonly ownerId: string;
    }
  >();
  const persistence: DemoArtifactGenerationPersistence = {
    async persist(bundle) {
      if (persistFailure) throw new Error("simulated persistence outage");
      persistedBundles.push(bundle);
      const generatedArtifactId = `30000000-0000-4000-8000-${String(
        persistedBundles.length,
      ).padStart(12, "0")}`;
      persisted.set(bundle.file.id, {
        generatedArtifactId,
        manifest: bundle.pdf,
        ownerId: bundle.context.ownerId,
      });
      return { generatedArtifactId };
    },
    async reopen(requestedOwnerId, artifactFileId) {
      const record = persisted.get(artifactFileId);
      if (!record || record.ownerId !== requestedOwnerId) return null;
      return { generatedArtifactId: record.generatedArtifactId, manifest: record.manifest };
    },
  };
  const logoBytes = await readFile(
    join(repositoryRoot, "apps", "web", "public", "brand", "cpl-logo.png"),
  );
  const runner = new DemoArtifactApplicationRunner({
    audit: {
      async record(event) {
        auditEvents.push(event);
      },
    },
    authorization: options.authorization ?? {
      async authorize(request) {
        return request.ownerId === ownerId;
      },
    },
    fileStore: store,
    maxGeneratedFileBytes: options.maxGeneratedFileBytes ?? 100_000_000,
    pdf: { logoBytes },
    persistence,
    usage: {
      async record(event) {
        usageEvents.push(event);
      },
    },
  });
  return {
    auditEvents,
    persistedBundles,
    rootDirectory,
    runner,
    setPersistFailure(value: boolean) {
      persistFailure = value;
    },
    store,
    usageEvents,
  };
}

function invocation(
  inputMode: "simulated_voice" | "text",
  conversationId = conversationIds[0],
  requestId = `artifact-${inputMode}`,
) {
  return {
    arguments: {
      conversationId,
      inputMode,
      prompt: "Create the synthetic comparison chart and branded PDF with cited findings.",
    },
    context: {
      correlationId: `corr-${inputMode}`,
      ownerId,
      requestId,
      responseRunId: "40000000-0000-4000-8000-000000000001",
    },
    toolName: DEMO_ARTIFACT_TOOL_DEFINITION.name,
  } as const;
}

describe("deterministic Demo application artifact runner", () => {
  it("uses one registered tool for text and simulated voice to create a research source board, cited chart, table, AI-labeled image, branded PDF, and simulated usage", async () => {
    const harness = await createHarness();
    const voice = await harness.runner.run(invocation("simulated_voice"));
    const text = await harness.runner.run(
      invocation("text", conversationIds[1], "artifact-text-second"),
    );
    expect(text.file.id).toBe(voice.file.id);

    for (const result of [voice, text]) {
      expect(result.sourceBoard.renderer).toBe("source-board");
      expect(result.comparisonChart.renderer).toBe("chart");
      expect(result.comparisonChart.chart.type).toBe("comparison");
      expect(result.comparisonChart.chart.provenance.dataStatus).toBe("synthetic");
      expect(result.table.renderer).toBe("table");
      expect(result.table.table.rows.length).toBeGreaterThan(0);
      expect(result.image.renderer).toBe("image");
      expect(result.image.file.id).toBe(result.imageFile.id);
      expect(`${result.image.title} ${result.image.disclosure}`).toMatch(
        /simulated ai-generated/iu,
      );
      expect(result.pdf.renderer).toBe("pdf");
      expect(result.pdf.citations.length).toBeGreaterThan(0);
      expect(result.file.id).toBe(result.pdf.file.id);
    }
    expect(harness.persistedBundles.map((bundle) => bundle.input.inputMode)).toEqual([
      "simulated_voice",
      "text",
    ]);
    expect(harness.usageEvents.map((event) => event.inputMode)).toEqual([
      "simulated_voice",
      "text",
    ]);
    expect(harness.usageEvents.every((event) => event.simulated)).toBe(true);

    const imageContent = await harness.store.get(ownerId, voice.imageFile.id);
    expect([...imageContent.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const pdfContent = await harness.store.get(ownerId, voice.file.id);
    expect(new TextDecoder().decode(pdfContent.bytes.slice(0, 4))).toBe("%PDF");

    const reopened = await harness.runner.reopen({
      artifactFileId: voice.file.id,
      correlationId: "corr-reopen-owner",
      ownerId,
    });
    // Identical deterministic owner content is deduplicated by stable storage ID;
    // reopen therefore resolves the newest persisted generated-artifact association.
    expect(reopened.generatedArtifactId).toBe(text.generatedArtifactId);
    expect(reopened.manifest.renderer).toBe("pdf");
    await expect(
      harness.runner.reopen({
        artifactFileId: voice.file.id,
        correlationId: "corr-reopen-other",
        ownerId: otherOwnerId,
      }),
    ).rejects.toMatchObject({ code: "DEMO_ARTIFACT_NOT_FOUND" });
  });

  it("fails closed before generation when authorization denies the owner", async () => {
    const harness = await createHarness({
      authorization: {
        async authorize() {
          return false;
        },
      },
    });

    await expect(harness.runner.run(invocation("text"))).rejects.toMatchObject({
      code: "DEMO_ARTIFACT_PERMISSION_DENIED",
      message: "Artifact was not found.",
    });
    expect(harness.persistedBundles).toEqual([]);
    expect(harness.usageEvents).toEqual([]);
    expect(harness.auditEvents).toContainEqual(
      expect.objectContaining({ action: "demo-artifact.generate", outcome: "denied" }),
    );
  });

  it("removes generated files when authoritative persistence fails", async () => {
    const harness = await createHarness({ persistFailure: true });

    await expect(harness.runner.run(invocation("simulated_voice"))).rejects.toMatchObject({
      code: "DEMO_ARTIFACT_PERSISTENCE_FAILED",
    });
    await expect(readdir(join(harness.rootDirectory, "blobs"))).resolves.toEqual([]);
    await expect(readdir(join(harness.rootDirectory, "manifests"))).resolves.toEqual([]);
    expect(harness.auditEvents).toContainEqual(
      expect.objectContaining({
        action: "demo-artifact.generate",
        errorCode: "DEMO_ARTIFACT_PERSISTENCE_FAILED",
        outcome: "failed",
      }),
    );
  });

  it("preserves prior deduplicated PDF and image files when a later generation fails", async () => {
    const harness = await createHarness();
    const prior = await harness.runner.run(invocation("text"));
    harness.setPersistFailure(true);

    await expect(
      harness.runner.run(
        invocation("text", conversationIds[1], "artifact-later-persistence-failure"),
      ),
    ).rejects.toMatchObject({ code: "DEMO_ARTIFACT_PERSISTENCE_FAILED" });
    const preservedFile = await harness.store.get(ownerId, prior.file.id);
    const preservedImage = await harness.store.get(ownerId, prior.imageFile.id);
    expect(preservedFile).toMatchObject({
      metadata: { ...prior.file, expiresAt: expect.any(String) },
    });
    expect(preservedImage).toMatchObject({
      metadata: { ...prior.imageFile, expiresAt: expect.any(String) },
    });
    expect(Date.parse(preservedFile.metadata.expiresAt)).toBeGreaterThanOrEqual(
      Date.parse(prior.file.expiresAt),
    );
    expect(Date.parse(preservedImage.metadata.expiresAt)).toBeGreaterThanOrEqual(
      Date.parse(prior.imageFile.expiresAt),
    );
  });

  it("enforces the administrator generated-file ceiling and cleans any partial output", async () => {
    const harness = await createHarness({ maxGeneratedFileBytes: 1_024 });

    await expect(harness.runner.run(invocation("text"))).rejects.toMatchObject({
      code: "DEMO_ARTIFACT_FILE_TOO_LARGE",
    });
    await expect(readdir(join(harness.rootDirectory, "blobs"))).resolves.toEqual([]);
    await expect(readdir(join(harness.rootDirectory, "manifests"))).resolves.toEqual([]);
  });
});
