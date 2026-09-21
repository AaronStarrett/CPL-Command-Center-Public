import "server-only";

import { loadGuidedMeridianReportView, type BeaServerRuntime } from "@bea/database";
import {
  GUIDED_DEMO_STAGES,
  presentationCueForState,
  type GuidedDemoAction,
  type GuidedDemoCommandResponse,
  type GuidedDemoSnapshot,
} from "@bea/domain";

import type { GuidedDemoEnvelope } from "@/lib/guided-demo-client";
import {
  allowedGuidedDemoActions,
  allowedGuidedDemoDecisions,
} from "@/lib/guided-demo-presentation";

export async function roleKeyForUser(runtime: BeaServerRuntime, userId: string): Promise<string> {
  const result = await runtime.database.query<{ key: string }>(
    `SELECT r.key
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id=$1
      LIMIT 1`,
    [userId],
  );
  return result.rows[0]?.key ?? "";
}

export async function buildGuidedDemoEnvelope(input: {
  readonly runtime: BeaServerRuntime;
  readonly snapshot: GuidedDemoSnapshot;
  readonly actorUserId: string;
  readonly displayName: string;
  readonly command?: GuidedDemoCommandResponse;
}): Promise<GuidedDemoEnvelope> {
  const roleKey = await roleKeyForUser(input.runtime, input.actorUserId);
  const workerHealthy = true;
  let report: GuidedDemoEnvelope["report"] = null;
  let proposal: GuidedDemoEnvelope["proposal"] = null;
  const bindings = input.snapshot.recordBindings;
  if (bindings.reportId) {
    const record = await input.runtime.operations.repository.getReport(bindings.reportId);
    const loaded = await loadGuidedMeridianReportView({
      repository: input.runtime.operations.repository,
      bindings,
      machineState: input.snapshot.machineState,
    });
    if (record) {
      const versions = await input.runtime.operations.repository.listReportVersions(record.id);
      const current =
        versions.find((item) => item.id === bindings.reportVersionId) ?? versions.at(-1);
      report = {
        id: record.id,
        reference: record.reference,
        versionNumber: loaded.view?.versionNumber ?? record.currentVersionNumber,
        status: record.status,
        versionId: loaded.view?.versionId ?? current?.id ?? bindings.reportVersionId ?? null,
        checksumSummary: loaded.view?.artifactChecksum
          ? loaded.view.artifactChecksum.slice(0, 12)
          : current?.renderedChecksum
            ? current.renderedChecksum.slice(0, 12)
            : null,
        workspace: loaded.view,
        workspaceError: loaded.error,
      };
    }
  }
  if (bindings.proposalId) {
    const record = await input.runtime.commercial.repository.getProposal(bindings.proposalId);
    if (record) {
      proposal = {
        id: record.proposal.id,
        reference: record.proposal.reference,
        versionNumber: record.proposal.currentVersionNumber,
        status: record.proposal.status,
        totalMinor: record.proposal.totalMinor,
        versionId: bindings.proposalVersionId ?? null,
      };
    }
  }
  return {
    snapshot: input.snapshot,
    demoAvailable: true,
    productionMode: input.runtime.environment.appMode !== "demo",
    roleKey,
    displayName: input.displayName,
    allowedActions: allowedGuidedDemoActions(roleKey) as GuidedDemoAction[],
    allowedDecisions: allowedGuidedDemoDecisions(roleKey),
    presentationCue: presentationCueForState(input.snapshot.machineState),
    workerHealthy,
    report,
    proposal,
    command: input.command ?? null,
  };
}

export function currentStageTitle(snapshot: GuidedDemoSnapshot): string {
  if (!snapshot.currentStageKey) return "Not started";
  return (
    GUIDED_DEMO_STAGES.find((stage) => stage.key === snapshot.currentStageKey)?.title ??
    "Not started"
  );
}
