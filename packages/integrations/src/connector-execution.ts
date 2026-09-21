import { createHash } from "node:crypto";

import type { EntityId, IsoDateTime, JsonObject, JsonValue } from "@bea/domain";
import { assertTenantScope } from "@bea/platform";

export const CONNECTOR_EXECUTION_POLICIES = ["AUTOMATIC", "PREVIEW", "CONFIRM", "BLOCK"] as const;

export type ConnectorExecutionPolicy = (typeof CONNECTOR_EXECUTION_POLICIES)[number];
export type ConnectorImpactLevel = "read" | "low" | "moderate" | "high" | "critical";

export interface ConnectorPolicyDimensions {
  readonly tenantId: EntityId;
  readonly userRole: string | null;
  readonly agentId: EntityId | null;
  readonly teamId: EntityId | null;
  readonly connectorId: EntityId;
  readonly toolKey: string;
  readonly action: string;
  readonly impactLevel: ConnectorImpactLevel;
}

export interface ConnectorOperationDescriptor {
  readonly connectorType: string;
  readonly operationKey: string;
  readonly kind: "read" | "create" | "update" | "delete" | "execute";
  readonly idempotent: boolean;
  readonly supportsDryRun: boolean;
  readonly supportsVerification: boolean;
  readonly recoveryStrategy: string;
}

export interface ConnectorExecutionRequest {
  readonly requestId: EntityId;
  readonly tenantId: EntityId;
  readonly actorId: EntityId;
  readonly actorType: "user" | "agent" | "system";
  readonly connectorId: EntityId;
  readonly operation: ConnectorOperationDescriptor;
  readonly policy: ConnectorExecutionPolicy;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly approvalReference: string | null;
  readonly emergencyStopVersion: number;
  readonly requestedAt: IsoDateTime;
}

export interface ConnectorAuthorizationDecision {
  readonly decisionId: EntityId;
  readonly requestId: EntityId;
  readonly tenantId: EntityId;
  readonly connectorId: EntityId;
  readonly authenticated: boolean;
  readonly tenantIsolated: boolean;
  readonly rolePermitted: boolean;
  readonly toolPermitted: boolean;
  readonly crossTenantRiskDetected: boolean;
  readonly emergencyStopActive: boolean;
  readonly emergencyStopVersion: number;
  readonly policy: ConnectorExecutionPolicy;
  readonly idempotencyKey: string;
  readonly approvalReference: string | null;
  readonly requestFingerprint: string;
  readonly issuedAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

export interface ConnectorExecutionEvidence {
  readonly providerRequestId: string | null;
  readonly startedAt: IsoDateTime;
  readonly completedAt: IsoDateTime;
  readonly verificationMethod: string;
  readonly verified: boolean;
  readonly resultFingerprint: string;
  readonly recoveryEvidenceReferences: readonly string[];
  readonly auditEventIds: readonly EntityId[];
}

export interface VerifiedConnectorExecutionEvidence extends ConnectorExecutionEvidence {
  readonly verified: true;
  readonly auditEventIds: readonly [EntityId, ...EntityId[]];
}

interface ConnectorExecutionResultBase {
  readonly requestId: EntityId;
  readonly tenantId: EntityId;
  readonly result: JsonObject | null;
  readonly retryable: boolean;
  readonly retryCount: number;
}

export type ConnectorExecutionResult =
  | (ConnectorExecutionResultBase & {
      readonly status: "succeeded";
      readonly executionOutcome: "completed";
      readonly errorCode: null;
      readonly evidence: VerifiedConnectorExecutionEvidence;
    })
  | (ConnectorExecutionResultBase & {
      readonly status: "previewed" | "confirmed";
      readonly executionOutcome: "not-started";
      readonly errorCode: null;
      readonly evidence: ConnectorExecutionEvidence | null;
    })
  | (ConnectorExecutionResultBase & {
      readonly status: "blocked";
      readonly executionOutcome: "not-started";
      readonly errorCode: string;
      readonly evidence: ConnectorExecutionEvidence | null;
    })
  | (ConnectorExecutionResultBase & {
      readonly status: "failed";
      readonly executionOutcome: "not-started";
      readonly errorCode: string;
      readonly evidence: null;
    })
  | (ConnectorExecutionResultBase & {
      readonly status: "failed";
      readonly executionOutcome: "attempted" | "unknown";
      readonly errorCode: string;
      readonly evidence: ConnectorExecutionEvidence;
    });

const connectorExecutionBrand: unique symbol = Symbol("BEA_BOUND_CONNECTOR_EXECUTION");
const connectorFreshnessBrand: unique symbol = Symbol("BEA_FRESH_CONNECTOR_EXECUTION");
const connectorEmergencyStopBrand: unique symbol = Symbol("BEA_BOUND_CONNECTOR_EMERGENCY_STOP");
const CONNECTOR_CONTROL_MAX_AGE_MS = 30_000;
const CONNECTOR_CONTROL_CLOCK_SKEW_MS = 5_000;
const CONNECTOR_FRESHNESS_TOKEN_LIFETIME_MS = 5_000;

function canonicalJson(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("CONNECTOR_REQUEST_NOT_CANONICAL_JSON");
  }
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("CONNECTOR_REQUEST_NOT_CANONICAL_JSON");
    return encoded;
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const record = value as Readonly<Record<string, unknown>>;
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]))
      .join(",") +
    "}"
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Readonly<Record<string, unknown>>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function timestamp(value: IsoDateTime): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("CONNECTOR_AUTHORIZATION_TIME_INVALID");
  return parsed;
}

export function connectorRequestFingerprint(request: ConnectorExecutionRequest): string {
  return createHash("sha256").update(canonicalJson(request), "utf8").digest("hex");
}

export function connectorEmergencyStopFingerprint(request: ConnectorEmergencyStopRequest): string {
  return createHash("sha256").update(canonicalJson(request), "utf8").digest("hex");
}

export interface BoundConnectorExecution<Mode extends "preview" | "execute"> {
  readonly [connectorExecutionBrand]: true;
  readonly mode: Mode;
  readonly request: ConnectorExecutionRequest;
  readonly decision: ConnectorAuthorizationDecision;
}

export interface ConnectorExecutionControlState {
  readonly tenantId: EntityId;
  readonly connectorId: EntityId;
  readonly emergencyStopVersion: number;
  readonly emergencyStopActive: boolean;
  readonly checkedAt: IsoDateTime;
}

export interface ConnectorEmergencyStopRequest {
  readonly requestId: EntityId;
  readonly tenantId: EntityId;
  readonly connectorId: EntityId | null;
  readonly requestedBy: EntityId;
  readonly requestedByType: "user" | "agent" | "system";
  readonly correlationId: string;
  readonly reason: string;
  readonly observedEmergencyStopVersion: number;
  readonly requestedAt: IsoDateTime;
}

export interface ConnectorEmergencyStopAuthorizationDecision {
  readonly decisionId: EntityId;
  readonly requestId: EntityId;
  readonly tenantId: EntityId;
  readonly connectorId: EntityId | null;
  readonly requestedBy: EntityId;
  readonly authenticated: boolean;
  readonly tenantIsolated: boolean;
  readonly rolePermitted: boolean;
  readonly crossTenantRiskDetected: boolean;
  readonly allowed: boolean;
  readonly auditEventId: EntityId;
  readonly requestFingerprint: string;
  readonly issuedAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly reasons: readonly string[];
}

export interface BoundConnectorEmergencyStop {
  readonly [connectorEmergencyStopBrand]: true;
  readonly request: ConnectorEmergencyStopRequest;
  readonly decision: ConnectorEmergencyStopAuthorizationDecision;
}

export interface ConnectorEmergencyStopResult {
  readonly requestId: EntityId;
  readonly tenantId: EntityId;
  readonly connectorId: EntityId | null;
  readonly active: true;
  readonly emergencyStopVersion: number;
  readonly appliedAt: IsoDateTime;
  readonly auditEventIds: readonly [EntityId, ...EntityId[]];
}

export interface FreshConnectorExecution<
  Mode extends "preview" | "execute",
> extends BoundConnectorExecution<Mode> {
  readonly [connectorFreshnessBrand]: true;
  readonly control: ConnectorExecutionControlState;
  readonly observedAt: IsoDateTime;
  readonly validUntil: IsoDateTime;
}

function assertConnectorEmergencyStopInvariants(
  request: ConnectorEmergencyStopRequest,
  decision: ConnectorEmergencyStopAuthorizationDecision,
): void {
  assertTenantScope({ tenantId: request.tenantId }, { tenantId: decision.tenantId });
  if (
    decision.requestId !== request.requestId ||
    decision.connectorId !== request.connectorId ||
    decision.requestedBy !== request.requestedBy
  ) {
    throw new Error("CONNECTOR_EMERGENCY_STOP_BINDING_MISMATCH");
  }
  if (
    !nonEmpty(request.requestId) ||
    !nonEmpty(request.tenantId) ||
    (request.connectorId !== null && !nonEmpty(request.connectorId)) ||
    !nonEmpty(request.requestedBy) ||
    !nonEmpty(request.correlationId) ||
    !nonEmpty(request.reason) ||
    !Number.isSafeInteger(request.observedEmergencyStopVersion) ||
    request.observedEmergencyStopVersion < 0 ||
    !nonEmpty(decision.decisionId) ||
    !nonEmpty(decision.auditEventId)
  ) {
    throw new Error("CONNECTOR_EMERGENCY_STOP_IDENTIFIERS_REQUIRED");
  }
  if (
    decision.requestFingerprint !== connectorEmergencyStopFingerprint(request) ||
    !decision.authenticated ||
    !decision.tenantIsolated ||
    !decision.rolePermitted ||
    decision.crossTenantRiskDetected ||
    !decision.allowed
  ) {
    throw new Error("CONNECTOR_EMERGENCY_STOP_NOT_AUTHORIZED");
  }
}

export function bindConnectorEmergencyStopAuthorization(
  request: ConnectorEmergencyStopRequest,
  decision: ConnectorEmergencyStopAuthorizationDecision,
  now: IsoDateTime = new Date().toISOString(),
): BoundConnectorEmergencyStop {
  assertConnectorEmergencyStopInvariants(request, decision);
  const issuedAt = timestamp(decision.issuedAt);
  const expiresAt = timestamp(decision.expiresAt);
  const boundAt = timestamp(now);
  if (issuedAt > boundAt || expiresAt <= boundAt || expiresAt <= issuedAt) {
    throw new Error("CONNECTOR_EMERGENCY_STOP_AUTHORIZATION_EXPIRED");
  }
  const execution = {
    request: deepFreeze(structuredClone(request)),
    decision: deepFreeze(structuredClone(decision)),
  } as BoundConnectorEmergencyStop;
  Object.defineProperty(execution, connectorEmergencyStopBrand, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return Object.freeze(execution);
}

function assertBoundConnectorEmergencyStopSnapshot(execution: BoundConnectorEmergencyStop): void {
  if (!execution || typeof execution !== "object") {
    throw new Error("CONNECTOR_BOUND_EMERGENCY_STOP_REQUIRED");
  }
  const brand = Object.getOwnPropertyDescriptor(execution, connectorEmergencyStopBrand);
  if (
    brand?.value !== true ||
    brand.enumerable ||
    !Object.isFrozen(execution) ||
    !Object.isFrozen(execution.request) ||
    !Object.isFrozen(execution.decision)
  ) {
    throw new Error("CONNECTOR_BOUND_EMERGENCY_STOP_REQUIRED");
  }
  assertConnectorEmergencyStopInvariants(execution.request, execution.decision);
}

function assertBoundConnectorEmergencyStop(
  execution: BoundConnectorEmergencyStop,
  now: IsoDateTime,
): void {
  assertBoundConnectorEmergencyStopSnapshot(execution);
  const current = timestamp(now);
  if (
    current < timestamp(execution.decision.issuedAt) ||
    current >= timestamp(execution.decision.expiresAt)
  ) {
    throw new Error("CONNECTOR_EMERGENCY_STOP_AUTHORIZATION_EXPIRED");
  }
}

export function assertConnectorEmergencyStopResult(
  execution: BoundConnectorEmergencyStop,
  result: ConnectorEmergencyStopResult,
): ConnectorEmergencyStopResult {
  assertBoundConnectorEmergencyStopSnapshot(execution);
  assertTenantScope({ tenantId: execution.request.tenantId }, { tenantId: result.tenantId });
  if (
    result.requestId !== execution.request.requestId ||
    result.connectorId !== execution.request.connectorId
  ) {
    throw new Error("CONNECTOR_EMERGENCY_STOP_RESULT_MISMATCH");
  }
  if (
    result.active !== true ||
    !Number.isSafeInteger(result.emergencyStopVersion) ||
    result.emergencyStopVersion <= execution.request.observedEmergencyStopVersion ||
    !Array.isArray(result.auditEventIds) ||
    !result.auditEventIds.every(nonEmpty) ||
    !result.auditEventIds.includes(execution.decision.auditEventId) ||
    timestamp(result.appliedAt) < timestamp(execution.request.requestedAt)
  ) {
    throw new Error("CONNECTOR_EMERGENCY_STOP_EVIDENCE_REQUIRED");
  }
  return result;
}

function assertConnectorAuthorizationInvariants<Mode extends "preview" | "execute">(
  request: ConnectorExecutionRequest,
  decision: ConnectorAuthorizationDecision,
  mode: Mode,
): void {
  if (mode !== "preview" && mode !== "execute") throw new Error("CONNECTOR_MODE_INVALID");
  if (!CONNECTOR_EXECUTION_POLICIES.includes(request.policy)) {
    throw new Error("CONNECTOR_POLICY_INVALID");
  }
  assertTenantScope({ tenantId: request.tenantId }, { tenantId: decision.tenantId });
  if (decision.requestId !== request.requestId || decision.connectorId !== request.connectorId) {
    throw new Error("CONNECTOR_AUTHORIZATION_BINDING_MISMATCH");
  }
  if (decision.policy !== request.policy) throw new Error("CONNECTOR_POLICY_BINDING_MISMATCH");
  if (
    !nonEmpty(request.requestId) ||
    !nonEmpty(request.tenantId) ||
    !nonEmpty(request.actorId) ||
    !nonEmpty(request.connectorId) ||
    !nonEmpty(request.correlationId) ||
    !nonEmpty(request.idempotencyKey) ||
    !nonEmpty(decision.decisionId) ||
    !nonEmpty(decision.requestId) ||
    !nonEmpty(decision.tenantId) ||
    !nonEmpty(decision.connectorId) ||
    !nonEmpty(decision.idempotencyKey)
  ) {
    throw new Error("CONNECTOR_EXECUTION_IDENTIFIERS_REQUIRED");
  }
  if (
    decision.idempotencyKey !== request.idempotencyKey ||
    decision.approvalReference !== request.approvalReference ||
    decision.emergencyStopVersion !== request.emergencyStopVersion ||
    decision.requestFingerprint !== connectorRequestFingerprint(request)
  ) {
    throw new Error("CONNECTOR_AUTHORIZATION_SNAPSHOT_MISMATCH");
  }
  if (
    !decision.allowed ||
    !decision.authenticated ||
    !decision.tenantIsolated ||
    !decision.rolePermitted ||
    !decision.toolPermitted ||
    decision.crossTenantRiskDetected ||
    decision.emergencyStopActive ||
    decision.policy === "BLOCK"
  ) {
    throw new Error("CONNECTOR_EXECUTION_NOT_AUTHORIZED");
  }
  if (mode === "execute" && request.policy === "PREVIEW") {
    throw new Error("CONNECTOR_PREVIEW_POLICY_CANNOT_EXECUTE");
  }
  if (
    mode === "execute" &&
    request.policy === "CONFIRM" &&
    (!request.approvalReference || !nonEmpty(request.approvalReference))
  ) {
    throw new Error("CONNECTOR_CONFIRMATION_REQUIRED");
  }
  if (
    mode === "execute" &&
    request.operation.kind !== "read" &&
    (!request.operation.idempotent ||
      !request.operation.supportsVerification ||
      !nonEmpty(request.operation.recoveryStrategy) ||
      request.operation.recoveryStrategy.trim().toLowerCase() === "none")
  ) {
    throw new Error("CONNECTOR_WRITE_SAFETY_CONTROLS_REQUIRED");
  }
}

function assertBoundConnectorExecution<Mode extends "preview" | "execute">(
  execution: BoundConnectorExecution<Mode>,
): void {
  if (!execution || typeof execution !== "object") {
    throw new Error("CONNECTOR_BOUND_EXECUTION_REQUIRED");
  }
  const brand = Object.getOwnPropertyDescriptor(execution, connectorExecutionBrand);
  if (
    brand?.value !== true ||
    brand.enumerable ||
    !Object.isFrozen(execution) ||
    !Object.isFrozen(execution.request) ||
    !Object.isFrozen(execution.request.operation) ||
    !Object.isFrozen(execution.request.parameters) ||
    !Object.isFrozen(execution.decision)
  ) {
    throw new Error("CONNECTOR_BOUND_EXECUTION_REQUIRED");
  }
  assertConnectorAuthorizationInvariants(execution.request, execution.decision, execution.mode);
}

export function bindConnectorAuthorization<Mode extends "preview" | "execute">(
  request: ConnectorExecutionRequest,
  decision: ConnectorAuthorizationDecision,
  mode: Mode,
  now: IsoDateTime = new Date().toISOString(),
): BoundConnectorExecution<Mode> {
  assertConnectorAuthorizationInvariants(request, decision, mode);
  const issuedAt = timestamp(decision.issuedAt);
  const expiresAt = timestamp(decision.expiresAt);
  const boundAt = timestamp(now);
  if (issuedAt > boundAt || expiresAt <= boundAt || expiresAt <= issuedAt) {
    throw new Error("CONNECTOR_AUTHORIZATION_EXPIRED_OR_NOT_YET_VALID");
  }
  const requestSnapshot = deepFreeze(structuredClone(request));
  const decisionSnapshot = deepFreeze(structuredClone(decision));
  const execution = {
    mode,
    request: requestSnapshot,
    decision: decisionSnapshot,
  } as BoundConnectorExecution<Mode>;
  Object.defineProperty(execution, connectorExecutionBrand, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return Object.freeze(execution);
}

export function assertConnectorExecutionFreshness<Mode extends "preview" | "execute">(
  execution: BoundConnectorExecution<Mode>,
  control: ConnectorExecutionControlState,
  now: IsoDateTime = new Date().toISOString(),
): FreshConnectorExecution<Mode> {
  assertBoundConnectorExecution(execution);
  assertTenantScope({ tenantId: execution.request.tenantId }, { tenantId: control.tenantId });
  if (control.connectorId !== execution.request.connectorId) {
    throw new Error("CONNECTOR_CONTROL_BINDING_MISMATCH");
  }
  if (
    control.emergencyStopActive ||
    control.emergencyStopVersion !== execution.request.emergencyStopVersion ||
    control.emergencyStopVersion !== execution.decision.emergencyStopVersion
  ) {
    throw new Error("CONNECTOR_EMERGENCY_STOP_CHANGED");
  }
  const checkedAt = timestamp(control.checkedAt);
  const observedAt = timestamp(now);
  const issuedAt = timestamp(execution.decision.issuedAt);
  const expiresAt = timestamp(execution.decision.expiresAt);
  if (
    observedAt < issuedAt ||
    observedAt >= expiresAt ||
    checkedAt < issuedAt ||
    checkedAt >= expiresAt
  ) {
    throw new Error("CONNECTOR_AUTHORIZATION_STALE");
  }
  if (
    checkedAt > observedAt + CONNECTOR_CONTROL_CLOCK_SKEW_MS ||
    observedAt - checkedAt > CONNECTOR_CONTROL_MAX_AGE_MS
  ) {
    throw new Error("CONNECTOR_CONTROL_STATE_STALE");
  }
  if (connectorRequestFingerprint(execution.request) !== execution.decision.requestFingerprint) {
    throw new Error("CONNECTOR_BOUND_REQUEST_CHANGED");
  }
  const validUntil = new Date(
    Math.min(expiresAt, observedAt + CONNECTOR_FRESHNESS_TOKEN_LIFETIME_MS),
  ).toISOString();
  const freshExecution = {
    mode: execution.mode,
    request: execution.request,
    decision: execution.decision,
    control: deepFreeze(structuredClone(control)),
    observedAt: now,
    validUntil,
  } as FreshConnectorExecution<Mode>;
  Object.defineProperties(freshExecution, {
    [connectorExecutionBrand]: {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    },
    [connectorFreshnessBrand]: {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    },
  });
  return Object.freeze(freshExecution);
}

export function assertFreshConnectorExecution<Mode extends "preview" | "execute">(
  execution: FreshConnectorExecution<Mode>,
  now: IsoDateTime = new Date().toISOString(),
): FreshConnectorExecution<Mode> {
  assertBoundConnectorExecution(execution);
  const freshnessBrand = Object.getOwnPropertyDescriptor(execution, connectorFreshnessBrand);
  if (
    freshnessBrand?.value !== true ||
    freshnessBrand.enumerable ||
    !Object.isFrozen(execution.control)
  ) {
    throw new Error("CONNECTOR_FRESH_EXECUTION_REQUIRED");
  }
  const current = timestamp(now);
  const observedAt = timestamp(execution.observedAt);
  const validUntil = timestamp(execution.validUntil);
  const maximumValidUntil = Math.min(
    timestamp(execution.decision.expiresAt),
    observedAt + CONNECTOR_FRESHNESS_TOKEN_LIFETIME_MS,
  );
  if (
    validUntil <= observedAt ||
    validUntil !== maximumValidUntil ||
    current < observedAt - CONNECTOR_CONTROL_CLOCK_SKEW_MS ||
    current >= validUntil
  ) {
    throw new Error("CONNECTOR_FRESHNESS_TOKEN_EXPIRED");
  }
  if (
    execution.control.emergencyStopActive ||
    execution.control.emergencyStopVersion !== execution.request.emergencyStopVersion ||
    execution.control.emergencyStopVersion !== execution.decision.emergencyStopVersion
  ) {
    throw new Error("CONNECTOR_EMERGENCY_STOP_CHANGED");
  }
  return execution;
}

export function assertConnectorExecutionResult<Mode extends "preview" | "execute">(
  execution: BoundConnectorExecution<Mode>,
  result: ConnectorExecutionResult,
): ConnectorExecutionResult {
  assertBoundConnectorExecution(execution);
  assertTenantScope({ tenantId: execution.request.tenantId }, { tenantId: result.tenantId });
  if (result.requestId !== execution.request.requestId) {
    throw new Error("CONNECTOR_RESULT_REQUEST_MISMATCH");
  }
  if (
    (execution.mode === "preview" &&
      result.status !== "previewed" &&
      result.status !== "blocked") ||
    (execution.mode === "execute" &&
      result.status !== "succeeded" &&
      result.status !== "failed" &&
      result.status !== "blocked")
  ) {
    throw new Error("CONNECTOR_RESULT_MODE_MISMATCH");
  }
  if (
    (result.status === "succeeded" && result.executionOutcome !== "completed") ||
    ((result.status === "previewed" ||
      result.status === "confirmed" ||
      result.status === "blocked") &&
      result.executionOutcome !== "not-started")
  ) {
    throw new Error("CONNECTOR_RESULT_OUTCOME_MISMATCH");
  }
  if (result.status === "blocked" && !nonEmpty(result.errorCode)) {
    throw new Error("CONNECTOR_BLOCK_REASON_REQUIRED");
  }
  if (
    result.status === "succeeded" &&
    (!result.evidence.verified ||
      !nonEmpty(result.evidence.verificationMethod) ||
      !nonEmpty(result.evidence.resultFingerprint) ||
      !result.evidence.auditEventIds.some(nonEmpty))
  ) {
    throw new Error("CONNECTOR_SUCCESS_EVIDENCE_REQUIRED");
  }
  if (
    result.status === "succeeded" &&
    execution.request.operation.kind !== "read" &&
    !result.evidence.recoveryEvidenceReferences.some(nonEmpty)
  ) {
    throw new Error("CONNECTOR_WRITE_RECOVERY_EVIDENCE_REQUIRED");
  }
  if (result.status === "failed") {
    if (!nonEmpty(result.errorCode) || result.result !== null) {
      throw new Error("CONNECTOR_FAILURE_EVIDENCE_REQUIRED");
    }
    if (result.executionOutcome === "not-started") {
      if (result.evidence !== null) throw new Error("CONNECTOR_FAILURE_EVIDENCE_REQUIRED");
    } else {
      const evidence: ConnectorExecutionEvidence | null = result.evidence;
      if (
        !evidence ||
        !nonEmpty(evidence.verificationMethod) ||
        !nonEmpty(evidence.resultFingerprint) ||
        !evidence.auditEventIds.some(nonEmpty)
      ) {
        throw new Error("CONNECTOR_FAILURE_EVIDENCE_REQUIRED");
      }
      if (
        execution.request.operation.kind !== "read" &&
        !evidence.recoveryEvidenceReferences.some(nonEmpty)
      ) {
        throw new Error("CONNECTOR_WRITE_RECOVERY_EVIDENCE_REQUIRED");
      }
      if (result.executionOutcome === "unknown" && result.retryable) {
        throw new Error("CONNECTOR_UNKNOWN_OUTCOME_NOT_RETRYABLE");
      }
      if (result.executionOutcome === "attempted" && result.retryable && !evidence.verified) {
        throw new Error("CONNECTOR_UNVERIFIED_OUTCOME_NOT_RETRYABLE");
      }
    }
  }
  return result;
}

export interface ConnectorExecutionDriver {
  authorize(
    dimensions: ConnectorPolicyDimensions,
    request: ConnectorExecutionRequest,
  ): Promise<ConnectorAuthorizationDecision>;
  readControlState(
    request: Pick<ConnectorExecutionRequest, "tenantId" | "connectorId">,
  ): Promise<ConnectorExecutionControlState>;
  previewAuthorized(
    execution: FreshConnectorExecution<"preview">,
  ): Promise<ConnectorExecutionResult>;
  executeAuthorized(
    execution: FreshConnectorExecution<"execute">,
  ): Promise<ConnectorExecutionResult>;
  authorizeEmergencyStop(
    request: ConnectorEmergencyStopRequest,
  ): Promise<ConnectorEmergencyStopAuthorizationDecision>;
  requestEmergencyStop(
    execution: BoundConnectorEmergencyStop,
  ): Promise<ConnectorEmergencyStopResult>;
}

export interface ConnectorExecutionEngine {
  authorize(
    dimensions: ConnectorPolicyDimensions,
    request: ConnectorExecutionRequest,
  ): Promise<ConnectorAuthorizationDecision>;
  preview(execution: BoundConnectorExecution<"preview">): Promise<ConnectorExecutionResult>;
  execute(execution: BoundConnectorExecution<"execute">): Promise<ConnectorExecutionResult>;
  authorizeEmergencyStop(
    request: ConnectorEmergencyStopRequest,
  ): Promise<ConnectorEmergencyStopAuthorizationDecision>;
  requestEmergencyStop(
    execution: BoundConnectorEmergencyStop,
  ): Promise<ConnectorEmergencyStopResult>;
}

export function createConnectorExecutionEngine(
  driver: ConnectorExecutionDriver,
  clock: () => IsoDateTime = () => new Date().toISOString(),
): ConnectorExecutionEngine {
  async function prepare<Mode extends "preview" | "execute">(
    execution: BoundConnectorExecution<Mode>,
  ): Promise<FreshConnectorExecution<Mode>> {
    assertBoundConnectorExecution(execution);
    const control = await driver.readControlState({
      tenantId: execution.request.tenantId,
      connectorId: execution.request.connectorId,
    });
    const fresh = assertConnectorExecutionFreshness(execution, control, clock());
    return assertFreshConnectorExecution(fresh, clock());
  }

  const engine: ConnectorExecutionEngine = {
    authorize: (dimensions, request) => driver.authorize(dimensions, request),
    preview: async (execution) => {
      const fresh = await prepare(execution);
      return assertConnectorExecutionResult(fresh, await driver.previewAuthorized(fresh));
    },
    execute: async (execution) => {
      const fresh = await prepare(execution);
      return assertConnectorExecutionResult(fresh, await driver.executeAuthorized(fresh));
    },
    authorizeEmergencyStop: (request) => driver.authorizeEmergencyStop(request),
    requestEmergencyStop: async (execution) => {
      assertBoundConnectorEmergencyStop(execution, clock());
      const result = await driver.requestEmergencyStop(execution);
      return assertConnectorEmergencyStopResult(execution, result);
    },
  };
  return Object.freeze(engine);
}
