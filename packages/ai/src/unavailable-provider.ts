import type {
  AiCommandProvider,
  AiConnectionTestResult,
  AiConversationResult,
  AiInputFileReference,
  AiModelMetadata,
  AiProviderHealth,
  AiProviderIdentity,
  AiRealtimeClientAuthorization,
  AiResponse,
  AiResponseStreamEvent,
  AiUsageRecord,
  GroundedAnswer,
  PlannedAction,
  SpeechToTextOutput,
  TextToSpeechOutput,
} from "./contracts.js";
import { AiProviderError } from "./provider-errors.js";

/** Production fail-closed provider used before verified OpenAI activation. */
export class UnavailableOpenAiProvider implements AiCommandProvider {
  readonly providerKey = "openai";

  constructor(
    private readonly state:
      | "SETUP_REQUIRED"
      | "CONFIGURED_NOT_TESTED"
      | "CONNECTION_FAILED"
      | "DISABLED" = "SETUP_REQUIRED",
  ) {}

  get identity(): AiProviderIdentity {
    return {
      provider: "openai",
      displayName: "OpenAI",
      model: "unconfigured",
      mode: "live",
      requirementStatus: this.state,
    };
  }

  async generateResponse(): Promise<AiConversationResult> {
    throw this.error();
  }

  async *streamResponse(): AsyncIterable<AiResponseStreamEvent> {
    throw this.error();
  }

  async listModels(): Promise<readonly AiModelMetadata[]> {
    return [];
  }

  async testConnection(): Promise<AiConnectionTestResult> {
    return {
      provider: "openai",
      healthy: false,
      authenticated: false,
      testedAt: new Date().toISOString(),
      safeMessage: this.message(),
      modelCount: 0,
    };
  }

  async createRealtimeClientAuthorization(): Promise<AiRealtimeClientAuthorization> {
    throw this.error();
  }

  async uploadInputFile(): Promise<AiInputFileReference> {
    throw this.error();
  }

  async extract<T>(): Promise<AiResponse<T>> {
    throw this.error();
  }

  async summarize(): Promise<AiResponse<string>> {
    throw this.error();
  }

  async answer(): Promise<AiResponse<GroundedAnswer>> {
    throw this.error();
  }

  async embed(): Promise<AiResponse<readonly number[]>> {
    throw this.error();
  }

  async planAction(): Promise<AiResponse<readonly PlannedAction[]>> {
    throw this.error();
  }

  async speechToText(): Promise<AiResponse<SpeechToTextOutput>> {
    throw this.error();
  }

  async textToSpeech(): Promise<AiResponse<TextToSpeechOutput>> {
    throw this.error();
  }

  async usage(): Promise<readonly AiUsageRecord[]> {
    return [];
  }

  async health(): Promise<AiProviderHealth> {
    return {
      status: "not_configured",
      requirementStatus: this.state,
      checkedAt: new Date().toISOString(),
      provider: "openai",
      model: "unconfigured",
      safeMessage: this.message(),
      authenticated: false,
    };
  }

  private message(): string {
    if (this.state === "CONFIGURED_NOT_TESTED") return "OpenAI is configured but not tested.";
    if (this.state === "CONNECTION_FAILED") return "OpenAI connection failed.";
    if (this.state === "DISABLED") return "OpenAI is disabled.";
    return "OpenAI setup required.";
  }

  private error(): AiProviderError {
    return new AiProviderError({
      code: "configuration",
      provider: "openai",
      retryable: false,
      safeMessage: this.message(),
    });
  }
}
