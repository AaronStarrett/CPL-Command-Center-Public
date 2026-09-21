import type { JsonObject, WorkspaceArtifactType } from "@bea/domain";

export interface AiCommandConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface AiCommandMessageView {
  readonly id: string;
  readonly role: "assistant" | "system" | "user";
  readonly content: string;
  readonly createdAt: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly providerResponseId?: string | null;
  readonly responseStatus?: "streaming" | "completed" | "cancelled" | "failed" | "incomplete";
  readonly executionMs: number | null;
  readonly links: readonly { label: string; href: string }[];
}

export interface AiCommandArtifactView {
  readonly id: string;
  readonly type: WorkspaceArtifactType;
  readonly title: string;
  readonly subtitle: string | null;
  readonly state: "ready" | "loading" | "empty" | "failed";
  readonly payload: JsonObject;
  readonly sources: readonly { id: string; type: string; title: string; href: string }[];
  readonly links: readonly { label: string; href: string }[];
  readonly requiredPermissions: readonly string[];
  readonly createdAt: string;
  readonly errorCode: string | null;
}

export interface AiCommandSnapshot {
  readonly conversation: AiCommandConversationSummary;
  readonly conversations: readonly AiCommandConversationSummary[];
  readonly messages: readonly AiCommandMessageView[];
  readonly artifact: AiCommandArtifactView;
  readonly provider: {
    readonly name: string;
    readonly label?: string;
    readonly mode: "demo" | "openai" | "hybrid" | "SIMULATED" | "CONNECTED" | "BLOCKED";
    readonly status?:
      | "SIMULATED"
      | "SETUP_REQUIRED"
      | "CONFIGURED_NOT_TESTED"
      | "TESTING"
      | "CONNECTED"
      | "CONNECTION_FAILED"
      | "DISABLED"
      | "BLOCKED";
    readonly providerStatus?:
      | "SIMULATED"
      | "SETUP_REQUIRED"
      | "CONFIGURED_NOT_TESTED"
      | "TESTING"
      | "CONNECTED"
      | "CONNECTION_FAILED"
      | "DISABLED";
    readonly simulated?: boolean;
    readonly model: string;
    readonly textModel?: string;
    readonly realtimeModel?: string;
    readonly voice?: string;
    readonly routerVersion: string;
    readonly liveConnected: boolean;
    readonly streaming?: boolean;
    readonly webSearchAllowed?: boolean;
    readonly webSearchDefault?: boolean;
    readonly codeInterpreterAllowed?: boolean;
    readonly imageGenerationAllowed?: boolean;
    readonly pdfGenerationAllowed?: boolean;
    readonly realtimeAllowed?: boolean;
    readonly speakResponses?: boolean;
    readonly maxUploadBytes?: number;
    readonly textModelCapabilities?: JsonObject;
  };
  readonly permissions: {
    readonly canConfigureOpenAi?: boolean;
    readonly canExecuteTaskAction: boolean;
    readonly canUploadArtifact?: boolean;
  };
  readonly actingUser: {
    readonly id: string;
    readonly displayName: string;
    readonly title: string;
  };
  readonly assistant: {
    readonly kind:
      | "executive-business-partner"
      | "sales-support"
      | "operations-coordination"
      | "executive-reporting"
      | "integration-support"
      | "general-support";
    readonly preferredName: string | null;
    readonly label: string;
    readonly subtitle: string;
    readonly promptVersion: string;
    readonly executiveProfileVersion: string | null;
    readonly brandPolicyVersion: string;
    readonly artifactTemplateVersion: string;
  };
}

export interface AiCommandErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}
