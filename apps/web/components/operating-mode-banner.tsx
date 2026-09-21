import { getServerRuntime } from "@bea/database";
import { isOwnerEvaluationRuntime } from "@bea/config";

import { readOpenAiAdministration } from "@/lib/openai-administration";
import { isPhase133ProductionPresentationTest } from "@/lib/phase133-production-presentation-test";

export async function OperatingModeBanner() {
  const runtime = await getServerRuntime();
  if (runtime.environment.runtimeMode === "production" || isPhase133ProductionPresentationTest()) {
    return null;
  }

  if (isOwnerEvaluationRuntime(runtime.environment)) {
    let openAiConnected = false;
    try {
      const administration = await readOpenAiAdministration(runtime);
      openAiConnected = administration.liveConnected;
    } catch {
      openAiConnected = false;
    }
    return (
      <div
        className="bea-owner-evaluation-banner"
        role="status"
        data-testid="owner-evaluation-banner"
      >
        <strong>Owner Evaluation</strong>
        <span>
          {openAiConnected ? "Live OpenAI" : "OpenAI not connected"} · Synthetic BEA Data · External
          Systems Not Connected
        </span>
      </div>
    );
  }

  if (
    process.env.BEA_PREVIEW_MODE === "true" &&
    process.env.BEA_PREVIEW_AUTHORITY === "Start-BEA-Preview.cmd"
  ) {
    return (
      <div className="bea-demo-banner" role="status">
        <strong>PREVIEW — NON-PRODUCTION</strong>
        <span>Synthetic preview data · isolated local storage · no live providers</span>
      </div>
    );
  }

  return null;
}
