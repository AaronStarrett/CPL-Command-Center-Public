import type {
  AiAuthorizedInputFileUpload,
  AiInputFileReference,
  AiRequestOptions,
} from "../contracts.js";
import { AiProviderError, normalizeAiProviderError } from "../provider-errors.js";
import type { OpenAiSdkClient } from "./client.js";
import { asRecord } from "./web-search.js";

const MAX_PROVIDER_UPLOAD_BYTES = 512_000_000;
const FILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u;

function safeFilename(value: string): string | null {
  const filename = value
    .replace(/[\\/\u0000-\u001f\u007f]/gu, "_")
    .trim()
    .slice(0, 128);
  return filename || null;
}

export async function uploadOpenAiInputFile(
  client: OpenAiSdkClient,
  input: AiAuthorizedInputFileUpload,
  options: Pick<AiRequestOptions, "signal" | "timeoutMs">,
): Promise<AiInputFileReference> {
  const filename = safeFilename(input.filename);
  if (
    !input.ownerId.trim() ||
    !input.artifactId.trim() ||
    !filename ||
    !input.mimeType.trim() ||
    input.bytes.byteLength < 1 ||
    input.bytes.byteLength > MAX_PROVIDER_UPLOAD_BYTES
  ) {
    throw new AiProviderError({
      code: "invalid_request",
      provider: "openai",
      retryable: false,
      safeMessage: "The authorized input file is invalid or exceeds the provider upload limit.",
    });
  }
  try {
    const response = await client.files.create(
      {
        file: new File([Uint8Array.from(input.bytes)], filename, { type: input.mimeType }),
        purpose: "user_data",
      },
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      },
    );
    const value = asRecord(response);
    const fileId = typeof value?.id === "string" ? value.id.trim() : "";
    if (!FILE_ID_PATTERN.test(fileId)) {
      throw new AiProviderError({
        code: "unavailable",
        provider: "openai",
        retryable: true,
        safeMessage: "OpenAI did not return a valid input-file reference.",
      });
    }
    return { type: "input_file", fileId, detail: input.detail ?? "auto" };
  } catch (error) {
    throw normalizeAiProviderError(error);
  }
}
