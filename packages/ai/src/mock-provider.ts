import type { Clock, IdGenerator } from "@bea/domain";
import type {
  AiProvider,
  AiProviderHealth,
  AiProviderIdentity,
  AiResponse,
  AiResponseMetadata,
  AiUsageRecord,
  GroundedAnswer,
  GroundingSource,
  PlannedAction,
  SpeechToTextOutput,
  StructuredExtractionRequest,
  TextToSpeechOutput,
} from "./contracts.js";

const defaultClock: Clock = { now: () => new Date() };

class IncrementingIdGenerator implements IdGenerator {
  private current = 0;

  next(): string {
    this.current += 1;
    return `mock-ai-request-${this.current.toString().padStart(4, "0")}`;
  }
}

export const MOCK_AI_IDENTITY: AiProviderIdentity = Object.freeze({
  provider: "bea.mock-ai",
  model: "deterministic-fixture-v1",
  mode: "mock",
  requirementStatus: "SIMULATED",
});

export class DeterministicMockAiProvider implements AiProvider {
  readonly identity = MOCK_AI_IDENTITY;
  private readonly usageRecords: AiUsageRecord[] = [];

  constructor(
    private readonly clock: Clock = defaultClock,
    private readonly ids: IdGenerator = new IncrementingIdGenerator(),
  ) {
    this.assertTestOnly();
  }

  protected assertTestOnly(): void {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("Simulated AI providers require an isolated NODE_ENV=test harness.");
    }
  }

  private response<T>(operation: string, inputUnits: number, output: T): AiResponse<T> {
    this.assertTestOnly();
    const generatedAt = this.clock.now().toISOString();
    const metadata: AiResponseMetadata = {
      ...this.identity,
      requestId: this.ids.next(),
      generatedAt,
      externalActionPerformed: false,
    };
    this.usageRecords.push({
      operation,
      provider: this.identity.provider,
      model: this.identity.model,
      inputUnits,
      outputUnits: JSON.stringify(output).length,
      estimatedCostUsd: 0,
      recordedAt: generatedAt,
      simulated: true,
    });
    return { output, metadata };
  }

  async extract<T>(request: StructuredExtractionRequest<T>): Promise<AiResponse<T>> {
    return this.response(`extract:${request.schemaName}`, request.input.length, request.fixture);
  }

  async summarize(input: string): Promise<AiResponse<string>> {
    const normalized = input.replace(/\s+/gu, " ").trim();
    const excerpt = normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
    return this.response(
      "summarize",
      input.length,
      `Simulated summary: ${excerpt || "No input supplied."}`,
    );
  }

  async answer(
    question: string,
    sources: readonly GroundingSource[],
  ): Promise<AiResponse<GroundedAnswer>> {
    const first = sources.at(0);
    const output: GroundedAnswer = first
      ? {
          answer: `Simulated grounded answer for “${question}” using ${first.title}.`,
          citations: sources.map((source) => ({ sourceId: source.id, title: source.title })),
          grounded: true,
        }
      : {
          answer: "No authorized grounding sources were supplied, so no answer was generated.",
          citations: [],
          grounded: false,
        };
    return this.response("grounded-answer", question.length, output);
  }

  async embed(input: string): Promise<AiResponse<readonly number[]>> {
    const vector = Array.from({ length: 8 }, (_, index) => {
      const charCode = input.charCodeAt(index % Math.max(input.length, 1)) || 0;
      return Number((((charCode + index * 17) % 101) / 100).toFixed(2));
    });
    return this.response("embedding", input.length, vector);
  }

  async planAction(request: string): Promise<AiResponse<readonly PlannedAction[]>> {
    const actions: readonly PlannedAction[] = [
      {
        actionType: "review-only",
        description: `Review the simulated plan for: ${request.trim() || "unspecified request"}`,
        requiresConfirmation: true,
        executable: false,
        parameters: {},
      },
    ];
    return this.response("action-plan", request.length, actions);
  }

  async speechToText(audio: Uint8Array): Promise<AiResponse<SpeechToTextOutput>> {
    return this.response("speech-to-text", audio.byteLength, {
      transcript: "Simulated transcript fixture.",
      durationSeconds: 0,
    });
  }

  async textToSpeech(text: string): Promise<AiResponse<TextToSpeechOutput>> {
    return this.response("text-to-speech", text.length, {
      audioReference: "mock://audio/deterministic-fixture.wav",
      mimeType: "audio/wav",
      simulated: true,
    });
  }

  async usage(): Promise<readonly AiUsageRecord[]> {
    this.assertTestOnly();
    return [...this.usageRecords];
  }

  async health(): Promise<AiProviderHealth> {
    this.assertTestOnly();
    return {
      status: "healthy",
      requirementStatus: "SIMULATED",
      checkedAt: this.clock.now().toISOString(),
      provider: this.identity.provider,
      model: this.identity.model,
    };
  }
}
