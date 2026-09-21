import {
  OWNER_ACCEPTANCE_GUIDED_TESTS,
  OWNER_ACCEPTANCE_ROUTE_FOCUS,
  type OwnerAcceptancePhysicalObservationId,
  type OwnerTechnicalEvidenceStatus,
  type OwnerLiveStatus,
} from "@bea/domain";

export const OWNER_LIVE_ACCEPTANCE_ENDPOINT = "/api/integrations/ai/owner-acceptance";
export const OWNER_LIVE_ACCEPTANCE_PATH = "/integrations/ai/owner-acceptance";

export interface OwnerLiveAcceptanceView {
  readonly contractVersion: string;
  readonly applicationVersion: string;
  readonly gitSha: string;
  readonly ownerLiveStatus: OwnerLiveStatus;
  readonly physicalConfirmable: boolean;
  readonly physicalConfirmationReason: string;
  readonly provider: string;
  readonly selectedModel: string;
  readonly realtimeModel: string;
  readonly connectionStatus: string;
  readonly providerStatus: string;
  readonly apiKeyFingerprint: string | null;
  readonly lastTestLatencyMs: number | null;
  readonly syntheticDataDisclosure: string;
  readonly externalIntegrations: string;
  readonly technicalEvidence: readonly {
    readonly id: string;
    readonly label: string;
    readonly serverEvidence: OwnerTechnicalEvidenceStatus;
    readonly ownerLiveStatus: OwnerTechnicalEvidenceStatus;
  }[];
  readonly physicalObservations: readonly {
    readonly id: OwnerAcceptancePhysicalObservationId;
    readonly label: string;
    readonly status: OwnerLiveStatus;
    readonly confirmedAt: string | null;
    readonly actorUserId: string | null;
  }[];
  readonly chargeableCallWarning: string;
}

export { OWNER_ACCEPTANCE_GUIDED_TESTS, OWNER_ACCEPTANCE_ROUTE_FOCUS };
