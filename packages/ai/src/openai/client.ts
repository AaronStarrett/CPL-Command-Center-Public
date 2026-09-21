export interface OpenAiRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface OpenAiModelPage {
  readonly data?: readonly unknown[];
  hasNextPage?(): boolean;
  getNextPage?(): Promise<OpenAiModelPage>;
  [Symbol.asyncIterator]?(): AsyncIterator<unknown>;
}

export interface OpenAiSdkClient {
  readonly responses: {
    create(parameters: Record<string, unknown>, options?: OpenAiRequestOptions): Promise<unknown>;
  };
  readonly models: {
    list(
      parameters?: Record<string, never>,
      options?: OpenAiRequestOptions,
    ): Promise<OpenAiModelPage>;
  };
  readonly files: {
    create(
      parameters: { readonly file: File; readonly purpose: "user_data" },
      options?: OpenAiRequestOptions,
    ): Promise<unknown>;
  };
  readonly realtime: {
    readonly clientSecrets: {
      create(parameters: Record<string, unknown>, options?: OpenAiRequestOptions): Promise<unknown>;
    };
  };
  readonly containers: {
    readonly files: {
      readonly content: {
        retrieve(
          fileId: string,
          parameters: { readonly container_id: string },
          options?: OpenAiRequestOptions,
        ): Promise<Response>;
      };
    };
  };
}

export interface CreateOpenAiClientOptions {
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export async function createOpenAiSdkClient(
  options: CreateOpenAiClientOptions,
): Promise<OpenAiSdkClient> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("OpenAI API key is not configured.");
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isSafeInteger(major) || major < 22) {
    throw new Error("Live OpenAI requires Node.js 22 or newer.");
  }
  const { default: OpenAI } = await import("openai");
  return new OpenAI({
    apiKey,
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  }) as unknown as OpenAiSdkClient;
}
