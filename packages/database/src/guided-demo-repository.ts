import { randomUUID } from "node:crypto";
import {
  GUIDED_DEMO_SCENARIO_KEY,
  GUIDED_DEMO_SCENARIO_VERSION,
  GUIDED_DEMO_STAGES,
  SEEDED_MERIDIAN_IDS,
  gateKeyForState,
  isGuidedDemoDecisionKey,
  isGuidedDemoMachineState,
  isGuidedDemoRunStatus,
  isGuidedDemoSpeedMode,
  isGuidedDemoStageKey,
  nodeStatusForMachineState,
  runStatusForMachineState,
  stageKeyForMachineState,
  type GuidedDemoEvent,
  type GuidedDemoMachineState,
  type GuidedDemoRecordBindings,
  type GuidedDemoRunStatus,
  type GuidedDemoSnapshot,
  type GuidedDemoSpeedMode,
  type GuidedDemoStageKey,
  type GuidedDemoStageState,
  type JsonObject,
} from "@bea/domain";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import { iso, jsonValue, nullableIso, nullableString } from "./operations-repository.js";

type Row = Record<string, unknown>;

function bool(value: unknown): boolean {
  return value === true || value === "t" || value === 1 || value === "1";
}

function asBindings(value: unknown): GuidedDemoRecordBindings {
  const object = jsonValue<JsonObject>(value, {});
  const bindings: Record<string, string> = {};
  const keys: readonly (keyof GuidedDemoRecordBindings)[] = [
    "companyId",
    "contactId",
    "leadId",
    "proposalId",
    "proposalVersionId",
    "catalogVersionId",
    "projectId",
    "inspectionId",
    "submissionId",
    "reportId",
    "reportVersionId",
    "deliveryAuthorizationId",
    "exceptionId",
    "proposalWorkItemId",
    "technicalWorkItemId",
    "deliveryWorkItemId",
  ];
  for (const key of keys) {
    const raw = object[key];
    if (typeof raw === "string" && raw.length > 0) {
      bindings[key] = raw;
    }
  }
  return bindings as GuidedDemoRecordBindings;
}

export interface GuidedDemoRunRow {
  readonly id: string;
  readonly scenarioKey: string;
  readonly scenarioVersion: string;
  readonly status: GuidedDemoRunStatus;
  readonly machineState: GuidedDemoMachineState;
  readonly pausedFromState: GuidedDemoMachineState | null;
  readonly currentStageKey: GuidedDemoStageKey | null;
  readonly currentGateKey: string | null;
  readonly speedMode: GuidedDemoSpeedMode;
  readonly recordBindings: GuidedDemoRecordBindings;
  readonly currentActivity: string | null;
  readonly currentActivityIndex: number;
  readonly currentBlocker: string | null;
  readonly failureArmed: boolean;
  readonly presentationMode: boolean;
  readonly startedByUserId: string | null;
  readonly optimisticVersion: number;
  readonly startedAt: string | null;
  readonly pausedAt: string | null;
  readonly completedAt: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function mapGuidedDemoRun(row: Row): GuidedDemoRunRow {
  const machineState = isGuidedDemoMachineState(String(row.machine_state))
    ? (row.machine_state as GuidedDemoMachineState)
    : "not_started";
  const pausedFrom = row.paused_from_state
    ? isGuidedDemoMachineState(String(row.paused_from_state))
      ? (row.paused_from_state as GuidedDemoMachineState)
      : null
    : null;
  const stageKey = row.current_stage_key
    ? isGuidedDemoStageKey(String(row.current_stage_key))
      ? (row.current_stage_key as GuidedDemoStageKey)
      : null
    : null;
  return {
    id: String(row.id),
    scenarioKey: String(row.scenario_key),
    scenarioVersion: String(row.scenario_version),
    status: isGuidedDemoRunStatus(String(row.status))
      ? (row.status as GuidedDemoRunStatus)
      : "not_started",
    machineState,
    pausedFromState: pausedFrom,
    currentStageKey: stageKey,
    currentGateKey: nullableString(row.current_gate_key),
    speedMode: isGuidedDemoSpeedMode(String(row.speed_mode))
      ? (row.speed_mode as GuidedDemoSpeedMode)
      : "normal",
    recordBindings: asBindings(row.record_bindings),
    currentActivity: nullableString(row.current_activity),
    currentActivityIndex: Number(row.current_activity_index ?? 0),
    currentBlocker: nullableString(row.current_blocker),
    failureArmed: bool(row.failure_armed),
    presentationMode: bool(row.presentation_mode),
    startedByUserId: nullableString(row.started_by_user_id),
    optimisticVersion: Number(row.optimistic_version ?? 1),
    startedAt: nullableIso(row.started_at),
    pausedAt: nullableIso(row.paused_at),
    completedAt: nullableIso(row.completed_at),
    archivedAt: nullableIso(row.archived_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapEvent(row: Row): GuidedDemoEvent {
  return {
    id: String(row.id),
    sequenceNumber: Number(row.sequence_number),
    stageKey:
      row.stage_key && isGuidedDemoStageKey(String(row.stage_key))
        ? (row.stage_key as GuidedDemoStageKey)
        : null,
    eventKind: String(row.event_kind),
    plainLanguageMessage: String(row.plain_language_message),
    actorUserId: nullableString(row.actor_user_id),
    safeMetadata: jsonValue<JsonObject>(row.safe_metadata, {}),
    createdAt: iso(row.created_at),
  };
}

function completedStageKeys(run: GuidedDemoRunRow): GuidedDemoStageKey[] {
  const active = stageKeyForMachineState(run.machineState);
  const activeOrder = active
    ? (GUIDED_DEMO_STAGES.find((item) => item.key === active)?.order ?? 0)
    : run.machineState === "completed"
      ? 99
      : 0;
  return GUIDED_DEMO_STAGES.filter((stage) => {
    if (run.machineState === "completed") return true;
    if (stage.key === active) return false;
    return stage.order < activeOrder;
  }).map((stage) => stage.key);
}

export class SqlGuidedDemoRepository {
  constructor(private readonly database: DatabaseAdapter) {}

  async getActiveRun(executor: SqlExecutor = this.database): Promise<GuidedDemoRunRow | null> {
    const result = await executor.query<Row>(
      `SELECT * FROM guided_demo_runs
        WHERE scenario_key=$1 AND archived_at IS NULL AND status <> 'archived'
        ORDER BY created_at DESC LIMIT 1`,
      [GUIDED_DEMO_SCENARIO_KEY],
    );
    return result.rows[0] ? mapGuidedDemoRun(result.rows[0]) : null;
  }

  async lockActiveRun(executor: SqlExecutor): Promise<GuidedDemoRunRow | null> {
    const result = await executor.query<Row>(
      `SELECT * FROM guided_demo_runs
        WHERE scenario_key=$1 AND archived_at IS NULL AND status <> 'archived'
        ORDER BY created_at DESC LIMIT 1
        FOR UPDATE`,
      [GUIDED_DEMO_SCENARIO_KEY],
    );
    return result.rows[0] ? mapGuidedDemoRun(result.rows[0]) : null;
  }

  async insertFreshRun(
    executor: SqlExecutor,
    input: { readonly id?: string; readonly now: string; readonly catalogVersionId: string },
  ): Promise<GuidedDemoRunRow> {
    const id = input.id ?? randomUUID();
    const inserted = await executor.query<Row>(
      `INSERT INTO guided_demo_runs
       (id,scenario_key,scenario_version,status,machine_state,speed_mode,record_bindings,
        current_activity_index,failure_armed,presentation_mode,optimistic_version,created_at,updated_at)
       VALUES ($1,$2,$3,'not_started','not_started','normal',$4::jsonb,0,FALSE,FALSE,1,$5,$5)
       RETURNING *`,
      [
        id,
        GUIDED_DEMO_SCENARIO_KEY,
        GUIDED_DEMO_SCENARIO_VERSION,
        JSON.stringify({
          catalogVersionId: input.catalogVersionId,
          companyId: SEEDED_MERIDIAN_IDS.company,
          contactId: SEEDED_MERIDIAN_IDS.contact,
        }),
        input.now,
      ],
    );
    const run = mapGuidedDemoRun(inserted.rows[0] as Row);
    for (const stage of GUIDED_DEMO_STAGES) {
      await executor.query(
        `INSERT INTO guided_demo_stage_states
         (id,demo_run_id,stage_key,stage_order,status,backing_type,owner_role_key,
          input_summary,output_summary,linked_records,updated_at)
         VALUES ($1,$2,$3,$4,'waiting',$5,$6,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$7)`,
        [
          randomUUID(),
          run.id,
          stage.key,
          stage.order,
          stage.backingType,
          stage.ownerRoleKey,
          input.now,
        ],
      );
    }
    return run;
  }

  async archiveRun(executor: SqlExecutor, runId: string, now: string): Promise<void> {
    await executor.query(
      `UPDATE guided_demo_runs
          SET status='archived', machine_state='archived', archived_at=$2, updated_at=$2,
              optimistic_version=optimistic_version+1
        WHERE id=$1`,
      [runId, now],
    );
  }

  async saveRun(
    executor: SqlExecutor,
    run: GuidedDemoRunRow,
    expectedVersion: number,
    now: string,
  ): Promise<GuidedDemoRunRow> {
    const updated = await executor.query<Row>(
      `UPDATE guided_demo_runs SET
         status=$2, machine_state=$3, paused_from_state=$4, current_stage_key=$5, current_gate_key=$6,
         speed_mode=$7, record_bindings=$8::jsonb, current_activity=$9, current_activity_index=$10,
         current_blocker=$11, failure_armed=$12, presentation_mode=$13, started_by_user_id=$14,
         optimistic_version=optimistic_version+1, started_at=$15, paused_at=$16, completed_at=$17,
         archived_at=$18, updated_at=$19
       WHERE id=$1 AND optimistic_version=$20
       RETURNING *`,
      [
        run.id,
        run.status,
        run.machineState,
        run.pausedFromState,
        run.currentStageKey,
        run.currentGateKey,
        run.speedMode,
        JSON.stringify(run.recordBindings),
        run.currentActivity,
        run.currentActivityIndex,
        run.currentBlocker,
        run.failureArmed,
        run.presentationMode,
        run.startedByUserId,
        run.startedAt,
        run.pausedAt,
        run.completedAt,
        run.archivedAt,
        now,
        expectedVersion,
      ],
    );
    if (!updated.rows[0]) {
      return Promise.reject(new Error("GUIDED_DEMO_CONCURRENCY"));
    }
    return mapGuidedDemoRun(updated.rows[0]);
  }

  async replaceStageStates(
    executor: SqlExecutor,
    run: GuidedDemoRunRow,
    now: string,
  ): Promise<void> {
    const completed = completedStageKeys(run);
    for (const stage of GUIDED_DEMO_STAGES) {
      const status = nodeStatusForMachineState(stage.key, run.machineState, completed);
      const active = stageKeyForMachineState(run.machineState) === stage.key;
      await executor.query(
        `UPDATE guided_demo_stage_states SET
           status=$3, current_activity=$4, started_at=COALESCE(started_at,$5),
           completed_at=CASE WHEN $3='completed' THEN COALESCE(completed_at,$5) ELSE completed_at END,
           failed_at=CASE WHEN $3='failed' THEN COALESCE(failed_at,$5) ELSE failed_at END,
           linked_records=$6::jsonb, updated_at=$5
         WHERE demo_run_id=$1 AND stage_key=$2`,
        [
          run.id,
          stage.key,
          status,
          active ? run.currentActivity : null,
          now,
          JSON.stringify(run.recordBindings),
        ],
      );
    }
  }

  async appendEvent(
    executor: SqlExecutor,
    input: {
      readonly runId: string;
      readonly stageKey: GuidedDemoStageKey | null;
      readonly eventKind: string;
      readonly message: string;
      readonly actorUserId: string | null;
      readonly metadata?: JsonObject;
      readonly now: string;
    },
  ): Promise<void> {
    const sequence = await executor.query<{ value: string | number }>(
      `SELECT COALESCE(MAX(sequence_number),0)+1 AS value FROM guided_demo_events WHERE demo_run_id=$1`,
      [input.runId],
    );
    await executor.query(
      `INSERT INTO guided_demo_events
       (id,demo_run_id,sequence_number,stage_key,event_kind,plain_language_message,actor_user_id,safe_metadata,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [
        randomUUID(),
        input.runId,
        Number(sequence.rows[0]?.value ?? 1),
        input.stageKey,
        input.eventKind,
        input.message,
        input.actorUserId,
        JSON.stringify(input.metadata ?? {}),
        input.now,
      ],
    );
  }

  async recordDecision(
    executor: SqlExecutor,
    input: {
      readonly runId: string;
      readonly decisionKey: string;
      readonly stageKey: GuidedDemoStageKey;
      readonly actorUserId: string;
      readonly idempotencyKey: string;
      readonly outcome: string;
      readonly metadata?: JsonObject;
      readonly now: string;
    },
  ): Promise<{ readonly inserted: boolean }> {
    const existing = await executor.query<Row>(
      `SELECT id FROM guided_demo_decisions WHERE demo_run_id=$1 AND idempotency_key=$2`,
      [input.runId, input.idempotencyKey],
    );
    if (existing.rows[0]) return { inserted: false };
    try {
      await executor.query(
        `INSERT INTO guided_demo_decisions
         (id,demo_run_id,decision_key,stage_key,actor_user_id,idempotency_key,outcome,safe_metadata,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        [
          randomUUID(),
          input.runId,
          input.decisionKey,
          input.stageKey,
          input.actorUserId,
          input.idempotencyKey,
          input.outcome,
          JSON.stringify(input.metadata ?? {}),
          input.now,
        ],
      );
      return { inserted: true };
    } catch {
      const again = await executor.query<Row>(
        `SELECT id FROM guided_demo_decisions WHERE demo_run_id=$1 AND idempotency_key=$2`,
        [input.runId, input.idempotencyKey],
      );
      if (again.rows[0]) return { inserted: false };
      throw new Error("GUIDED_DEMO_DECISION_INSERT_FAILED");
    }
  }

  async listEvents(
    runId: string,
    limit = 40,
    executor: SqlExecutor = this.database,
  ): Promise<readonly GuidedDemoEvent[]> {
    const result = await executor.query<Row>(
      `SELECT * FROM guided_demo_events WHERE demo_run_id=$1 ORDER BY sequence_number DESC LIMIT $2`,
      [runId, limit],
    );
    return [...result.rows].reverse().map(mapEvent);
  }

  async listStageStates(
    runId: string,
    executor: SqlExecutor = this.database,
  ): Promise<readonly GuidedDemoStageState[]> {
    const result = await executor.query<Row>(
      `SELECT * FROM guided_demo_stage_states WHERE demo_run_id=$1 ORDER BY stage_order`,
      [runId],
    );
    return result.rows.map((row) => ({
      stageKey: String(row.stage_key) as GuidedDemoStageKey,
      stageOrder: Number(row.stage_order),
      status: String(row.status) as GuidedDemoStageState["status"],
      backingType: String(row.backing_type) as GuidedDemoStageState["backingType"],
      ownerRoleKey: String(row.owner_role_key),
      currentActivity: nullableString(row.current_activity),
      inputSummary: jsonValue<JsonObject>(row.input_summary, {}),
      outputSummary: jsonValue<JsonObject>(row.output_summary, {}),
      linkedRecords: jsonValue<JsonObject>(row.linked_records, {}),
      startedAt: nullableIso(row.started_at),
      completedAt: nullableIso(row.completed_at),
      failedAt: nullableIso(row.failed_at),
    }));
  }

  async loadSnapshot(
    run: GuidedDemoRunRow,
    executor: SqlExecutor = this.database,
  ): Promise<GuidedDemoSnapshot> {
    const stages = await this.listStageStates(run.id, executor);
    const recentEvents = await this.listEvents(run.id, 40, executor);
    return {
      id: run.id,
      scenarioKey: GUIDED_DEMO_SCENARIO_KEY,
      scenarioVersion: GUIDED_DEMO_SCENARIO_VERSION,
      status: run.status,
      machineState: run.machineState,
      pausedFromState: run.pausedFromState,
      currentStageKey: run.currentStageKey,
      currentGateKey:
        run.currentGateKey && isGuidedDemoDecisionKey(run.currentGateKey)
          ? run.currentGateKey
          : gateKeyForState(run.machineState),
      speedMode: run.speedMode,
      currentActivity: run.currentActivity,
      currentActivityIndex: run.currentActivityIndex,
      currentBlocker: run.currentBlocker,
      failureArmed: run.failureArmed,
      presentationMode: run.presentationMode,
      recordBindings: run.recordBindings,
      optimisticVersion: run.optimisticVersion,
      startedByUserId: run.startedByUserId,
      startedAt: run.startedAt,
      pausedAt: run.pausedAt,
      completedAt: run.completedAt,
      archivedAt: run.archivedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      stages,
      recentEvents,
    };
  }

  applyMachineState(
    run: GuidedDemoRunRow,
    next: GuidedDemoMachineState,
    extra: Partial<GuidedDemoRunRow> = {},
  ): GuidedDemoRunRow {
    const stageKey = stageKeyForMachineState(next);
    return {
      ...run,
      ...extra,
      machineState: next,
      status: runStatusForMachineState(next),
      currentStageKey: stageKey,
      currentGateKey: gateKeyForState(next),
    };
  }
}
