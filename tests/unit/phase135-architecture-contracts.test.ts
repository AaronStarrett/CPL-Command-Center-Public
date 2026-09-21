import { describe, expect, it } from "vitest";

import type {
  ApplicationRuntimeTarget,
  AuthProvider,
  BackupProvider,
  DatabaseProvider,
  EmailProvider,
  KnowledgeSourceProvider,
  MonitoringProvider,
  ObjectStorageProvider,
  QueueProvider,
  SecretProvider,
  VectorMemoryProvider,
} from "../../packages/platform/src/index.js";
import { assertTenantScope, PROVIDER_ADAPTER_CATALOG } from "../../packages/platform/src/index.js";
import {
  assertConnectorEmergencyStopResult,
  assertConnectorExecutionResult,
  assertConnectorExecutionFreshness,
  assertFreshConnectorExecution,
  bindConnectorAuthorization,
  bindConnectorEmergencyStopAuthorization,
  CONNECTOR_EXECUTION_POLICIES,
  connectorEmergencyStopFingerprint,
  connectorRequestFingerprint,
  createConnectorExecutionEngine,
  type BoundConnectorExecution,
  type ConnectorAuthorizationDecision,
  type ConnectorEmergencyStopAuthorizationDecision,
  type ConnectorEmergencyStopRequest,
  type ConnectorEmergencyStopResult,
  type ConnectorExecutionControlState,
  type ConnectorExecutionDriver,
  type ConnectorExecutionRequest,
  type ConnectorExecutionResult,
} from "../../packages/integrations/src/index.js";

type RequiredProviderContracts = {
  database: DatabaseProvider;
  auth: AuthProvider;
  objectStorage: ObjectStorageProvider;
  secret: SecretProvider;
  knowledge: KnowledgeSourceProvider;
  vector: VectorMemoryProvider;
  queue: QueueProvider;
  runtime: ApplicationRuntimeTarget;
  email: EmailProvider;
  monitoring: MonitoringProvider;
  backup: BackupProvider;
};

void (undefined as unknown as RequiredProviderContracts);

const AUTHORIZATION_NOW = "2026-08-25T12:00:00.000Z";

function connectorRequest(
  overrides: Partial<ConnectorExecutionRequest> = {},
): ConnectorExecutionRequest {
  const request: ConnectorExecutionRequest = {
    requestId: "request-a",
    tenantId: "tenant-a",
    actorId: "actor-a",
    actorType: "user",
    connectorId: "connector-a",
    operation: {
      connectorType: "drive",
      operationKey: "file.update",
      kind: "update",
      idempotent: true,
      supportsDryRun: true,
      supportsVerification: true,
      recoveryStrategy: "restore-revision",
    },
    policy: "AUTOMATIC",
    parameters: {},
    idempotencyKey: "idempotency-a",
    correlationId: "correlation-a",
    approvalReference: null,
    emergencyStopVersion: 4,
    requestedAt: "2026-08-25T11:58:00.000Z",
  };
  return { ...request, ...overrides };
}

function connectorDecision(
  request: ConnectorExecutionRequest,
  overrides: Partial<ConnectorAuthorizationDecision> = {},
): ConnectorAuthorizationDecision {
  const decision: ConnectorAuthorizationDecision = {
    decisionId: "decision-a",
    requestId: request.requestId,
    tenantId: request.tenantId,
    connectorId: request.connectorId,
    authenticated: true,
    tenantIsolated: true,
    rolePermitted: true,
    toolPermitted: true,
    crossTenantRiskDetected: false,
    emergencyStopActive: false,
    emergencyStopVersion: request.emergencyStopVersion,
    policy: request.policy,
    idempotencyKey: request.idempotencyKey,
    approvalReference: request.approvalReference,
    requestFingerprint: connectorRequestFingerprint(request),
    issuedAt: "2026-08-25T11:59:00.000Z",
    expiresAt: "2026-08-25T12:05:00.000Z",
    allowed: true,
    reasons: [],
  };
  return { ...decision, ...overrides };
}

function connectorControl(
  request: ConnectorExecutionRequest,
  overrides: Partial<ConnectorExecutionControlState> = {},
): ConnectorExecutionControlState {
  return {
    tenantId: request.tenantId,
    connectorId: request.connectorId,
    emergencyStopVersion: request.emergencyStopVersion,
    emergencyStopActive: false,
    checkedAt: "2026-08-25T12:00:01.000Z",
    ...overrides,
  };
}

function emergencyStopRequest(
  overrides: Partial<ConnectorEmergencyStopRequest> = {},
): ConnectorEmergencyStopRequest {
  const request: ConnectorEmergencyStopRequest = {
    requestId: "stop-request-a",
    tenantId: "tenant-a",
    connectorId: "connector-a",
    requestedBy: "actor-a",
    requestedByType: "user",
    correlationId: "correlation-stop-a",
    reason: "Owner-requested safety stop",
    observedEmergencyStopVersion: 4,
    requestedAt: "2026-08-25T12:00:00.000Z",
  };
  return { ...request, ...overrides };
}

function emergencyStopDecision(
  request: ConnectorEmergencyStopRequest,
  overrides: Partial<ConnectorEmergencyStopAuthorizationDecision> = {},
): ConnectorEmergencyStopAuthorizationDecision {
  const decision: ConnectorEmergencyStopAuthorizationDecision = {
    decisionId: "stop-decision-a",
    requestId: request.requestId,
    tenantId: request.tenantId,
    connectorId: request.connectorId,
    requestedBy: request.requestedBy,
    authenticated: true,
    tenantIsolated: true,
    rolePermitted: true,
    crossTenantRiskDetected: false,
    allowed: true,
    auditEventId: "audit-stop-a",
    requestFingerprint: connectorEmergencyStopFingerprint(request),
    issuedAt: "2026-08-25T11:59:00.000Z",
    expiresAt: "2026-08-25T12:05:00.000Z",
    reasons: [],
  };
  return { ...decision, ...overrides };
}

function emergencyStopResult(
  request: ConnectorEmergencyStopRequest,
  decision: ConnectorEmergencyStopAuthorizationDecision,
  overrides: Partial<ConnectorEmergencyStopResult> = {},
): ConnectorEmergencyStopResult {
  const result: ConnectorEmergencyStopResult = {
    requestId: request.requestId,
    tenantId: request.tenantId,
    connectorId: request.connectorId,
    active: true,
    emergencyStopVersion: request.observedEmergencyStopVersion + 1,
    appliedAt: "2026-08-25T12:00:03.000Z",
    auditEventIds: [decision.auditEventId, "audit-stop-applied-a"],
  };
  return { ...result, ...overrides };
}

function successfulConnectorResult(request: ConnectorExecutionRequest): ConnectorExecutionResult {
  return {
    requestId: request.requestId,
    tenantId: request.tenantId,
    status: "succeeded",
    executionOutcome: "completed",
    result: {},
    errorCode: null,
    retryable: false,
    retryCount: 0,
    evidence: {
      providerRequestId: "provider-request-a",
      startedAt: "2026-08-25T12:00:02.000Z",
      completedAt: "2026-08-25T12:00:03.000Z",
      verificationMethod: "provider-read-after-write",
      verified: true,
      resultFingerprint: "sha256:fixture",
      recoveryEvidenceReferences: ["revision-a"],
      auditEventIds: ["audit-a"],
    },
  };
}

describe("Phase 1.3.5 provider-neutral contracts", () => {
  it("publishes every governed connector execution policy", () => {
    expect(CONNECTOR_EXECUTION_POLICIES).toEqual(["AUTOMATIC", "PREVIEW", "CONFIRM", "BLOCK"]);
  });

  it("keeps primary, default, optional, and future adapters explicit", () => {
    const status = Object.fromEntries(
      PROVIDER_ADAPTER_CATALOG.map((provider) => [provider.adapterId, provider.status]),
    );
    expect(status.SupabasePostgresProvider).toBe("primary-pilot");
    expect(status.SupabasePgvectorProvider).toBe("primary-pilot");
    expect(status.CloudflareR2Provider).toBe("primary-pilot");
    expect(status.RailwayRuntimeTarget).toBe("primary-pilot");
    expect(status.OneDriveKnowledgeProvider).toBe("default-connector");
    expect(status.SupabaseAuthProvider).toBe("optional-pilot");
    expect(status.GoogleDriveKnowledgeProvider).toBe("optional-pilot");
    expect(status.AzurePostgresProvider).toBe("future-optional");
    expect(PROVIDER_ADAPTER_CATALOG.every((provider) => provider.architectureOnly)).toBe(true);
  });

  it("blocks mismatched tenant payloads at the shared adapter boundary", () => {
    const context = {
      tenantId: "tenant-a",
      actorId: "actor-a",
      correlationId: "correlation-a",
      environment: "staging" as const,
    };
    expect(() => assertTenantScope(context, { tenantId: "tenant-a" })).not.toThrow();
    expect(() => assertTenantScope(context, { tenantId: "tenant-b" })).toThrow(
      "CROSS_TENANT_PROVIDER_OPERATION_BLOCKED",
    );
  });

  it("binds allowed connector decisions and rejects denied or mismatched execution", () => {
    const request = connectorRequest();
    const decision = connectorDecision(request);

    expect(() =>
      bindConnectorAuthorization(request, decision, "execute", AUTHORIZATION_NOW),
    ).not.toThrow();
    expect(() =>
      bindConnectorAuthorization(
        request,
        { ...decision, allowed: false },
        "execute",
        AUTHORIZATION_NOW,
      ),
    ).toThrow("CONNECTOR_EXECUTION_NOT_AUTHORIZED");
    expect(() =>
      bindConnectorAuthorization(
        request,
        { ...decision, tenantId: "tenant-b" },
        "execute",
        AUTHORIZATION_NOW,
      ),
    ).toThrow("CROSS_TENANT_PROVIDER_OPERATION_BLOCKED");
    expect(() =>
      bindConnectorAuthorization(
        request,
        { ...decision, requestId: "request-b" },
        "execute",
        AUTHORIZATION_NOW,
      ),
    ).toThrow("CONNECTOR_AUTHORIZATION_BINDING_MISMATCH");
  });

  it("binds an immutable request snapshot and rejects incomplete write controls", () => {
    const parameters = { target: { folder: "original" } };
    const request = connectorRequest({ parameters });
    const execution = bindConnectorAuthorization(
      request,
      connectorDecision(request),
      "execute",
      AUTHORIZATION_NOW,
    );

    parameters.target.folder = "mutated-after-authorization";
    expect(execution.request.parameters).toEqual({ target: { folder: "original" } });
    expect(Object.isFrozen(execution.request)).toBe(true);
    expect(Object.isFrozen(execution.request.parameters)).toBe(true);
    expect(Object.isFrozen(execution.decision)).toBe(true);

    const missingIdempotency = connectorRequest({ idempotencyKey: "" });
    expect(() =>
      bindConnectorAuthorization(
        missingIdempotency,
        connectorDecision(missingIdempotency),
        "execute",
        AUTHORIZATION_NOW,
      ),
    ).toThrow("CONNECTOR_EXECUTION_IDENTIFIERS_REQUIRED");

    const unverifiableWrite = connectorRequest({
      operation: {
        ...request.operation,
        supportsVerification: false,
        recoveryStrategy: "none",
      },
    });
    expect(() =>
      bindConnectorAuthorization(
        unverifiableWrite,
        connectorDecision(unverifiableWrite),
        "execute",
        AUTHORIZATION_NOW,
      ),
    ).toThrow("CONNECTOR_WRITE_SAFETY_CONTROLS_REQUIRED");
  });

  it("requires a current authoritative emergency-stop snapshot before execution", () => {
    const request = connectorRequest();
    const execution = bindConnectorAuthorization(
      request,
      connectorDecision(request),
      "execute",
      AUTHORIZATION_NOW,
    );
    const fresh = assertConnectorExecutionFreshness(
      execution,
      connectorControl(request),
      "2026-08-25T12:00:02.000Z",
    );
    expect(fresh.control.emergencyStopVersion).toBe(4);
    expect(Object.isFrozen(fresh.control)).toBe(true);
    expect(fresh.observedAt).toBe("2026-08-25T12:00:02.000Z");
    expect(fresh.validUntil).toBe("2026-08-25T12:00:07.000Z");

    const forgedExecution = {
      mode: "execute",
      request: execution.request,
      decision: Object.freeze({
        ...execution.decision,
        allowed: false,
        authenticated: false,
        policy: "BLOCK",
      }),
    } as unknown as BoundConnectorExecution<"execute">;
    expect(() =>
      assertConnectorExecutionFreshness(
        forgedExecution,
        connectorControl(request),
        "2026-08-25T12:00:02.000Z",
      ),
    ).toThrow("CONNECTOR_BOUND_EXECUTION_REQUIRED");

    expect(() =>
      assertConnectorExecutionFreshness(
        execution,
        connectorControl(request, { emergencyStopVersion: 5 }),
        "2026-08-25T12:00:02.000Z",
      ),
    ).toThrow("CONNECTOR_EMERGENCY_STOP_CHANGED");
    expect(() =>
      assertConnectorExecutionFreshness(
        execution,
        connectorControl(request, { emergencyStopActive: true }),
        "2026-08-25T12:00:02.000Z",
      ),
    ).toThrow("CONNECTOR_EMERGENCY_STOP_CHANGED");
    expect(() =>
      assertConnectorExecutionFreshness(
        execution,
        connectorControl(request, { checkedAt: "2026-08-25T11:59:01.000Z" }),
        "2026-08-25T12:00:02.000Z",
      ),
    ).toThrow("CONNECTOR_CONTROL_STATE_STALE");
    expect(() =>
      assertConnectorExecutionFreshness(
        execution,
        connectorControl(request, { checkedAt: "2026-08-25T12:04:50.000Z" }),
        "2026-08-25T12:05:10.000Z",
      ),
    ).toThrow("CONNECTOR_AUTHORIZATION_STALE");
    expect(() => assertFreshConnectorExecution(fresh, "2026-08-25T12:00:07.000Z")).toThrow(
      "CONNECTOR_FRESHNESS_TOKEN_EXPIRED",
    );
  });

  it("obtains authoritative control state inside every governed execution", async () => {
    const request = connectorRequest();
    const decision = connectorDecision(request);
    const execution = bindConnectorAuthorization(request, decision, "execute", AUTHORIZATION_NOW);
    const result = successfulConnectorResult(request);
    const stopRequest = emergencyStopRequest();
    const stopDecision = emergencyStopDecision(stopRequest);
    const stopResult = emergencyStopResult(stopRequest, stopDecision);
    let emergencyStopActive = false;
    let controlReads = 0;
    let executions = 0;
    let stopRequests = 0;
    const driver: ConnectorExecutionDriver = {
      authorize: () => Promise.resolve(decision),
      readControlState: () => {
        controlReads += 1;
        return Promise.resolve(connectorControl(request, { emergencyStopActive }));
      },
      previewAuthorized: () =>
        Promise.resolve({
          requestId: request.requestId,
          tenantId: request.tenantId,
          status: "previewed",
          executionOutcome: "not-started",
          result: {},
          errorCode: null,
          retryable: false,
          retryCount: 0,
          evidence: null,
        }),
      executeAuthorized: () => {
        executions += 1;
        return Promise.resolve(result);
      },
      authorizeEmergencyStop: () => Promise.resolve(stopDecision),
      requestEmergencyStop: () => {
        stopRequests += 1;
        return Promise.resolve(stopResult);
      },
    };
    const engine = createConnectorExecutionEngine(driver, () => "2026-08-25T12:00:02.000Z");

    const unboundExecution = {
      mode: "execute",
      request: execution.request,
      decision: execution.decision,
    } as unknown as BoundConnectorExecution<"execute">;
    await expect(engine.execute(unboundExecution)).rejects.toThrow(
      "CONNECTOR_BOUND_EXECUTION_REQUIRED",
    );
    expect(controlReads).toBe(0);

    await expect(engine.execute(execution)).resolves.toBe(result);
    emergencyStopActive = true;
    await expect(engine.execute(execution)).rejects.toThrow("CONNECTOR_EMERGENCY_STOP_CHANGED");
    expect(controlReads).toBe(2);
    expect(executions).toBe(1);

    const boundStop = bindConnectorEmergencyStopAuthorization(
      stopRequest,
      stopDecision,
      AUTHORIZATION_NOW,
    );
    await expect(engine.requestEmergencyStop(boundStop)).resolves.toBe(stopResult);
    await expect(
      engine.requestEmergencyStop({
        request: boundStop.request,
        decision: boundStop.decision,
      } as unknown as typeof boundStop),
    ).rejects.toThrow("CONNECTOR_BOUND_EMERGENCY_STOP_REQUIRED");
    expect(stopRequests).toBe(1);
  });

  it("binds emergency stops to authenticated tenant-isolated authorization", () => {
    const request = emergencyStopRequest();
    const decision = emergencyStopDecision(request);
    const execution = bindConnectorEmergencyStopAuthorization(request, decision, AUTHORIZATION_NOW);
    const result = emergencyStopResult(request, decision);
    expect(assertConnectorEmergencyStopResult(execution, result)).toBe(result);
    expect(() =>
      assertConnectorEmergencyStopResult(
        execution,
        emergencyStopResult(request, decision, {
          emergencyStopVersion: request.observedEmergencyStopVersion,
        }),
      ),
    ).toThrow("CONNECTOR_EMERGENCY_STOP_EVIDENCE_REQUIRED");
    expect(() =>
      assertConnectorEmergencyStopResult(
        execution,
        emergencyStopResult(request, decision, { auditEventIds: ["different-audit"] }),
      ),
    ).toThrow("CONNECTOR_EMERGENCY_STOP_EVIDENCE_REQUIRED");
    expect(() =>
      bindConnectorEmergencyStopAuthorization(
        request,
        { ...decision, tenantId: "tenant-b" },
        AUTHORIZATION_NOW,
      ),
    ).toThrow("CROSS_TENANT_PROVIDER_OPERATION_BLOCKED");
    expect(() =>
      bindConnectorEmergencyStopAuthorization(
        request,
        { ...decision, authenticated: false },
        AUTHORIZATION_NOW,
      ),
    ).toThrow("CONNECTOR_EMERGENCY_STOP_NOT_AUTHORIZED");
    expect(() =>
      bindConnectorEmergencyStopAuthorization(
        request,
        { ...decision, requestedBy: "actor-b" },
        AUTHORIZATION_NOW,
      ),
    ).toThrow("CONNECTOR_EMERGENCY_STOP_BINDING_MISMATCH");

    const tenantWideRequest = emergencyStopRequest({ connectorId: null });
    const tenantWideDecision = emergencyStopDecision(tenantWideRequest);
    const tenantWideExecution = bindConnectorEmergencyStopAuthorization(
      tenantWideRequest,
      tenantWideDecision,
      AUTHORIZATION_NOW,
    );
    const tenantWideResult = emergencyStopResult(tenantWideRequest, tenantWideDecision);
    expect(assertConnectorEmergencyStopResult(tenantWideExecution, tenantWideResult)).toBe(
      tenantWideResult,
    );
  });

  it("requires verified non-empty evidence for a succeeded connector result", () => {
    const request = connectorRequest();
    const execution = bindConnectorAuthorization(
      request,
      connectorDecision(request),
      "execute",
      AUTHORIZATION_NOW,
    );
    const valid = successfulConnectorResult(request);
    expect(assertConnectorExecutionResult(execution, valid)).toBe(valid);

    const invalid = {
      ...valid,
      evidence: { ...valid.evidence, verified: false, auditEventIds: [] },
    } as unknown as ConnectorExecutionResult;
    expect(() => assertConnectorExecutionResult(execution, invalid)).toThrow(
      "CONNECTOR_SUCCESS_EVIDENCE_REQUIRED",
    );

    const missingRecoveryEvidence = {
      ...valid,
      evidence: { ...valid.evidence, recoveryEvidenceReferences: [] },
    } as ConnectorExecutionResult;
    expect(() => assertConnectorExecutionResult(execution, missingRecoveryEvidence)).toThrow(
      "CONNECTOR_WRITE_RECOVERY_EVIDENCE_REQUIRED",
    );
  });

  it("distinguishes unstarted, attempted, and unknown failed-write outcomes", () => {
    const request = connectorRequest({
      operation: {
        ...connectorRequest().operation,
        operationKey: "file.delete",
        kind: "delete",
      },
    });
    const execution = bindConnectorAuthorization(
      request,
      connectorDecision(request),
      "execute",
      AUTHORIZATION_NOW,
    );
    const notStarted: ConnectorExecutionResult = {
      requestId: request.requestId,
      tenantId: request.tenantId,
      status: "failed",
      executionOutcome: "not-started",
      result: null,
      errorCode: "PROVIDER_UNAVAILABLE",
      retryable: true,
      retryCount: 0,
      evidence: null,
    };
    expect(assertConnectorExecutionResult(execution, notStarted)).toBe(notStarted);

    const attemptedWithoutEvidence = {
      ...notStarted,
      executionOutcome: "attempted",
      errorCode: null,
      evidence: null,
    } as unknown as ConnectorExecutionResult;
    expect(() => assertConnectorExecutionResult(execution, attemptedWithoutEvidence)).toThrow(
      "CONNECTOR_FAILURE_EVIDENCE_REQUIRED",
    );

    const successful = successfulConnectorResult(request);
    const attemptedWithoutRecovery: ConnectorExecutionResult = {
      ...notStarted,
      executionOutcome: "attempted",
      errorCode: "PROVIDER_WRITE_FAILED",
      retryable: false,
      evidence: {
        ...successful.evidence,
        verified: false,
        recoveryEvidenceReferences: [],
      },
    };
    expect(() => assertConnectorExecutionResult(execution, attemptedWithoutRecovery)).toThrow(
      "CONNECTOR_WRITE_RECOVERY_EVIDENCE_REQUIRED",
    );

    const attemptedUnverifiedRetryable: ConnectorExecutionResult = {
      ...notStarted,
      executionOutcome: "attempted",
      errorCode: "PROVIDER_WRITE_FAILED",
      retryable: true,
      evidence: { ...successful.evidence, verified: false },
    };
    expect(() => assertConnectorExecutionResult(execution, attemptedUnverifiedRetryable)).toThrow(
      "CONNECTOR_UNVERIFIED_OUTCOME_NOT_RETRYABLE",
    );

    const unknownRetryable: ConnectorExecutionResult = {
      ...notStarted,
      executionOutcome: "unknown",
      errorCode: "PROVIDER_OUTCOME_UNKNOWN",
      retryable: true,
      evidence: { ...successful.evidence, verified: false },
    };
    expect(() => assertConnectorExecutionResult(execution, unknownRetryable)).toThrow(
      "CONNECTOR_UNKNOWN_OUTCOME_NOT_RETRYABLE",
    );
  });
});
