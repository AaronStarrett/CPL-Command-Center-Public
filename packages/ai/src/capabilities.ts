import type { AiModelValidationMetadata } from "@bea/domain";
import type { AiCapabilityState, AiModelCapabilities, AiModelMetadata } from "./contracts.js";

export const OPENAI_CAPABILITY_REGISTRY_VERSION = "2026-08-phase1.3.3-v1";

export type AiModelCapabilityKey =
  | "responses_text"
  | "streaming"
  | "reasoning"
  | "function_calling"
  | "structured_outputs"
  | "web_search"
  | "file_search"
  | "code_interpreter"
  | "image_generation"
  | "image_input"
  | "file_input"
  | "realtime"
  | "audio_input"
  | "audio_output"
  | "embeddings";

const unknownCapabilities = Object.freeze<AiModelCapabilities>({
  responsesText: "unknown",
  streaming: "unknown",
  reasoning: "unknown",
  functionCalling: "unknown",
  structuredOutputs: "unknown",
  webSearch: "unknown",
  fileSearch: "unknown",
  codeInterpreter: "unknown",
  imageGeneration: "unknown",
  imageInput: "unknown",
  fileInput: "unknown",
  realtime: "unknown",
  audioInput: "unknown",
  audioOutput: "unknown",
  embeddings: "unknown",
});

export const UNKNOWN_MODEL_CAPABILITIES = unknownCapabilities;

export const DEMO_MODEL_FIXTURES: readonly AiModelMetadata[] = Object.freeze([
  {
    id: "deterministic-demo-router",
    provider: "demo",
    displayName: "Deterministic Demo Router",
    available: true,
    capabilitySource: "demo_fixture",
    capabilities: {
      responsesText: true,
      streaming: true,
      reasoning: false,
      functionCalling: true,
      structuredOutputs: true,
      webSearch: true,
      fileSearch: false,
      codeInterpreter: true,
      imageGeneration: true,
      imageInput: false,
      fileInput: true,
      realtime: true,
      audioInput: true,
      audioOutput: true,
      embeddings: false,
    },
    validation: {
      registryVersion: OPENAI_CAPABILITY_REGISTRY_VERSION,
      validatedAt: null,
      validationMethod: "registry",
      evidence: { testOnly: true },
    },
  },
]);

export interface ModelCapabilityOverride {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: Partial<AiModelCapabilities>;
  readonly validatedAt?: string;
  readonly validationMethod?: AiModelValidationMetadata["validationMethod"];
  readonly evidence?: AiModelValidationMetadata["evidence"];
}

/**
 * The Models API reports availability, not a complete capability matrix.
 * This registry therefore fails closed on unknown capabilities and accepts
 * administrator-maintained overrides without baking model-family guesses into code.
 */
export class ModelCapabilityRegistry {
  private readonly overrides = new Map<string, Partial<AiModelCapabilities>>();
  private readonly validations = new Map<string, AiModelValidationMetadata>();

  readonly version = OPENAI_CAPABILITY_REGISTRY_VERSION;

  constructor(overrides: readonly ModelCapabilityOverride[] = []) {
    for (const override of overrides) this.set(override);
  }

  set(override: ModelCapabilityOverride): void {
    const key = this.key(override.provider, override.model);
    this.overrides.set(key, { ...override.capabilities });
    this.validations.set(key, {
      registryVersion: this.version,
      validatedAt: override.validatedAt ?? null,
      validationMethod: override.validationMethod ?? "administrator",
      evidence: override.evidence ?? {},
    });
  }

  resolve(provider: string, model: string): AiModelCapabilities {
    const fixture = DEMO_MODEL_FIXTURES.find(
      (candidate) => candidate.provider === provider && candidate.id === model,
    );
    if (fixture) return fixture.capabilities;
    return {
      ...UNKNOWN_MODEL_CAPABILITIES,
      ...this.overrides.get(this.key(provider, model)),
    };
  }

  supports(provider: string, model: string, capability: keyof AiModelCapabilities): boolean {
    return this.resolve(provider, model)[capability] === true;
  }

  state(provider: string, model: string, capability: keyof AiModelCapabilities): AiCapabilityState {
    return this.resolve(provider, model)[capability];
  }

  validation(provider: string, model: string): AiModelValidationMetadata {
    const fixture = DEMO_MODEL_FIXTURES.find(
      (candidate) => candidate.provider === provider && candidate.id === model,
    );
    if (fixture) return fixture.validation;
    return (
      this.validations.get(this.key(provider, model)) ?? {
        registryVersion: this.version,
        validatedAt: null,
        validationMethod: "unknown",
        evidence: {},
      }
    );
  }

  private key(provider: string, model: string): string {
    return `${provider.trim().toLowerCase()}:${model.trim().toLowerCase()}`;
  }
}
