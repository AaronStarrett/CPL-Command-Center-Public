export const OPENAI_DEFAULT_VOICE = "marin";

export interface OpenAiVoiceMetadata {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly source: "built_in" | "approved_custom";
  readonly previewAvailable: boolean;
}

const BUILT_IN_VOICES: readonly OpenAiVoiceMetadata[] = Object.freeze([
  {
    id: "alloy",
    displayName: "Alloy",
    description: "Balanced and versatile.",
    source: "built_in",
    previewAvailable: true,
  },
  {
    id: "ash",
    displayName: "Ash",
    description: "Clear and composed.",
    source: "built_in",
    previewAvailable: true,
  },
  {
    id: "ballad",
    displayName: "Ballad",
    description: "Warm and expressive.",
    source: "built_in",
    previewAvailable: true,
  },
  {
    id: "cedar",
    displayName: "Cedar",
    description: "Steady and grounded.",
    source: "built_in",
    previewAvailable: true,
  },
  {
    id: "coral",
    displayName: "Coral",
    description: "Friendly and conversational.",
    source: "built_in",
    previewAvailable: true,
  },
  {
    id: "echo",
    displayName: "Echo",
    description: "Direct and articulate.",
    source: "built_in",
    previewAvailable: true,
  },
  {
    id: "marin",
    displayName: "Marin",
    description: "Natural and professional.",
    source: "built_in",
    previewAvailable: true,
  },
  {
    id: "sage",
    displayName: "Sage",
    description: "Calm and thoughtful.",
    source: "built_in",
    previewAvailable: true,
  },
  {
    id: "shimmer",
    displayName: "Shimmer",
    description: "Bright and energetic.",
    source: "built_in",
    previewAvailable: true,
  },
  {
    id: "verse",
    displayName: "Verse",
    description: "Confident and engaging.",
    source: "built_in",
    previewAvailable: true,
  },
]);

const CUSTOM_VOICE_ID = /^voice_[A-Za-z0-9_-]{1,200}$/u;

/** Custom IDs are returned only when an administrator has already validated account access. */
export function listOpenAiVoices(
  approvedCustomVoiceIds: readonly string[] = [],
): readonly OpenAiVoiceMetadata[] {
  const custom = [...new Set(approvedCustomVoiceIds)]
    .filter((id) => CUSTOM_VOICE_ID.test(id))
    .slice(0, 50)
    .map((id) => ({
      id,
      displayName: `Custom voice ${id.slice(-6)}`,
      description: "Account-approved custom OpenAI API voice.",
      source: "approved_custom" as const,
      previewAvailable: true,
    }));
  return [...BUILT_IN_VOICES, ...custom];
}

export function isKnownOpenAiVoice(
  voiceId: string,
  approvedCustomVoiceIds: readonly string[] = [],
): boolean {
  return listOpenAiVoices(approvedCustomVoiceIds).some((voice) => voice.id === voiceId);
}
