import { JOB_LEASE_MS } from "@bea/domain";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";

export { JOB_LEASE_MS };

const RUNNABLE_JOB = `(
  (status='pending' AND available_at<=$1)
  OR (
    status='claimed'
    AND (
      (lease_expires_at IS NOT NULL AND lease_expires_at<=$1)
      OR (lease_expires_at IS NULL AND claimed_at IS NOT NULL AND claimed_at<=$2)
    )
  )
)`;

const RUNNABLE_JOB_QUALIFIED = `(
  (job.status='pending' AND job.available_at<=$1)
  OR (
    job.status='claimed'
    AND (
      (job.lease_expires_at IS NOT NULL AND job.lease_expires_at<=$1)
      OR (job.lease_expires_at IS NULL AND job.claimed_at IS NOT NULL AND job.claimed_at<=$2)
    )
  )
)`;

const AGGREGATE_FILTER = `($4::text IS NULL OR aggregate_id::text=$4)`;
const AGGREGATE_FILTER_QUALIFIED = `($4::text IS NULL OR job.aggregate_id::text=$4)`;

export function claimRunnableJobStatement(kind: DatabaseAdapter["kind"]): string {
  if (kind === "postgres") {
    return `
      WITH candidate AS (
        SELECT id
          FROM automation_jobs
         WHERE ${RUNNABLE_JOB}
           AND ${AGGREGATE_FILTER}
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE automation_jobs AS job
         SET status='claimed',
             claimed_by=$3,
             claimed_at=$1,
             lease_expires_at=$5,
             attempt_count=job.attempt_count+1,
             updated_at=$1,
             version=job.version+1
        FROM candidate
       WHERE job.id=candidate.id
         AND ${RUNNABLE_JOB_QUALIFIED}
         AND ${AGGREGATE_FILTER_QUALIFIED}
       RETURNING job.*
    `;
  }
  return `
    UPDATE automation_jobs
       SET status='claimed',
           claimed_by=$3,
           claimed_at=$1,
           lease_expires_at=$5,
           attempt_count=attempt_count+1,
           updated_at=$1,
           version=version+1
     WHERE id=(
       SELECT id FROM automation_jobs
        WHERE ${RUNNABLE_JOB}
          AND ${AGGREGATE_FILTER}
        ORDER BY created_at
        LIMIT 1
     )
       AND ${RUNNABLE_JOB}
       AND ${AGGREGATE_FILTER}
     RETURNING *
  `;
}

export async function claimRunnableJob(
  adapter: Pick<DatabaseAdapter, "kind">,
  transaction: SqlExecutor,
  input: {
    readonly claimOwner: string;
    readonly now: string;
    readonly aggregateId?: string;
    readonly leaseMs?: number;
  },
): Promise<Record<string, unknown> | null> {
  const leaseMs = input.leaseMs ?? JOB_LEASE_MS;
  const stale = new Date(Date.parse(input.now) - leaseMs).toISOString();
  const leaseExpiresAt = new Date(Date.parse(input.now) + leaseMs).toISOString();
  const result = await transaction.query<Record<string, unknown>>(
    claimRunnableJobStatement(adapter.kind),
    [input.now, stale, input.claimOwner, input.aggregateId ?? null, leaseExpiresAt],
  );
  return result.rows[0] ?? null;
}

export const SUCCEED_CLAIMED_JOB_SQL = `
  UPDATE automation_jobs
     SET status='succeeded', finished_at=$3, updated_at=$3, version=version+1
   WHERE id=$1 AND status='claimed' AND claimed_by=$2
   RETURNING *
`;

export const FAIL_CLAIMED_JOB_SQL = `
  UPDATE automation_jobs
     SET status=$3,
         attempt_count=$4,
         available_at=$5,
         finished_at=$6,
         last_error=$7::jsonb,
         claimed_at=NULL,
         claimed_by=NULL,
         lease_expires_at=NULL,
         updated_at=$6,
         version=version+1
   WHERE id=$1 AND status='claimed' AND claimed_by=$2
   RETURNING *
`;

export async function succeedClaimedJob(
  executor: SqlExecutor,
  input: { readonly jobId: string; readonly claimOwner: string; readonly now: string },
): Promise<Record<string, unknown> | null> {
  const result = await executor.query<Record<string, unknown>>(SUCCEED_CLAIMED_JOB_SQL, [
    input.jobId,
    input.claimOwner,
    input.now,
  ]);
  return result.rows[0] ?? null;
}

export async function failClaimedJob(
  executor: SqlExecutor,
  input: {
    readonly jobId: string;
    readonly claimOwner: string;
    readonly status: "pending" | "dead_letter";
    readonly attemptCount: number;
    readonly availableAt: string;
    readonly now: string;
    readonly lastError: string;
  },
): Promise<Record<string, unknown> | null> {
  const result = await executor.query<Record<string, unknown>>(FAIL_CLAIMED_JOB_SQL, [
    input.jobId,
    input.claimOwner,
    input.status,
    input.attemptCount,
    input.availableAt,
    input.now,
    input.lastError,
  ]);
  return result.rows[0] ?? null;
}
