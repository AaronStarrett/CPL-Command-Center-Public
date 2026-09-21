import type {
  GuidedDemoAction,
  GuidedDemoCommandResponse,
  GuidedDemoDecisionKey,
  GuidedDemoSnapshot,
  GuidedDemoSpeedMode,
  GuidedMeridianReportView,
} from "@bea/domain";

export interface GuidedDemoReportView {
  readonly id: string;
  readonly reference: string;
  readonly versionNumber: number;
  readonly status: string;
  readonly versionId: string | null;
  readonly checksumSummary: string | null;
  readonly workspace: GuidedMeridianReportView | null;
  readonly workspaceError: string | null;
}

export interface GuidedDemoProposalView {
  readonly id: string;
  readonly reference: string;
  readonly versionNumber: number;
  readonly status: string;
  readonly totalMinor: number;
  readonly versionId: string | null;
}

export interface GuidedDemoEnvelope {
  readonly snapshot: GuidedDemoSnapshot;
  readonly demoAvailable: boolean;
  readonly productionMode: boolean;
  readonly roleKey: string;
  readonly displayName: string;
  readonly allowedActions: readonly GuidedDemoAction[];
  readonly allowedDecisions: readonly GuidedDemoDecisionKey[];
  readonly presentationCue: string;
  readonly workerHealthy: boolean;
  readonly report: GuidedDemoReportView | null;
  readonly proposal: GuidedDemoProposalView | null;
  readonly command: GuidedDemoCommandResponse | null;
}

export interface GuidedDemoMutationInput {
  readonly action: GuidedDemoAction;
  readonly expectedVersion?: number;
  readonly decisionKey?: GuidedDemoDecisionKey;
  readonly comments?: string;
  readonly speedMode?: GuidedDemoSpeedMode;
  readonly presentationMode?: boolean;
  readonly commandText?: string;
  readonly idempotencyKey?: string;
  readonly skipDelay?: boolean;
}

function jsonHeaders(body: string): HeadersInit {
  return {
    "content-type": "application/json",
    "content-length": String(new TextEncoder().encode(body).length),
  };
}

export async function fetchGuidedDemoSnapshot(): Promise<GuidedDemoEnvelope> {
  const response = await fetch("/api/guided-demo/meridian", { cache: "no-store" });
  const payload = (await response.json()) as GuidedDemoEnvelope & {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? "The Meridian demonstration could not be loaded.");
  }
  return payload;
}

export async function postGuidedDemoAction(
  input: GuidedDemoMutationInput,
): Promise<GuidedDemoEnvelope> {
  const body = JSON.stringify(input);
  const response = await fetch("/api/guided-demo/meridian", {
    method: "POST",
    headers: jsonHeaders(body),
    body,
  });
  const payload = (await response.json()) as GuidedDemoEnvelope & {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? "The demonstration command was refused.");
  }
  return payload;
}

export async function postDemoCommand(commandText: string): Promise<GuidedDemoEnvelope> {
  const body = JSON.stringify({ commandText });
  const response = await fetch("/api/command-center/demo-command", {
    method: "POST",
    headers: jsonHeaders(body),
    body,
  });
  const payload = (await response.json()) as GuidedDemoEnvelope & {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? "The simulated command was refused.");
  }
  return payload;
}
