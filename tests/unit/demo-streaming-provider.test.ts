import { describe, expect, it } from "vitest";

import {
  BEA_GENERATED_ARTIFACT_TOOLS,
  DemoStreamingAiProvider,
} from "../../packages/ai/src/index.js";

describe("Demo provider authorized input artifacts", () => {
  it("links a validated local upload to the simulated analysis proposal", async () => {
    const provider = new DemoStreamingAiProvider();
    const artifactId = "art_demo_owner_upload";
    const inputFile = await provider.uploadInputFile({
      ownerId: "10000000-0000-4000-8000-000000000001",
      artifactId,
      filename: "synthetic-envelope-notes.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("Synthetic envelope observation."),
    });

    const result = await provider.generateResponse({
      model: "demo-command-v1",
      input: "Analyze the attached file",
      tools: BEA_GENERATED_ARTIFACT_TOOLS,
      files: [inputFile],
      options: {
        requestId: "demo-upload-analysis",
        correlationId: "demo-upload-analysis",
      },
    });

    expect(inputFile).toMatchObject({ type: "input_file", fileId: artifactId });
    expect(result.simulated).toBe(true);
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "bea_analyze",
        status: "proposed",
        arguments: expect.objectContaining({ sourceArtifactIds: [artifactId] }),
      }),
    ]);
  });
});
