import type {
  AuditEventInput,
  AuditLog,
  AuditSink,
  AuthenticatedUser,
  AuthenticationSession,
  Clock,
  IdGenerator,
  SessionStore,
  UserDirectory,
  WorkflowRun,
  WorkflowRunClaim,
  WorkflowStepRun,
  WorkflowStore,
} from "@bea/domain";
import { DEMO_PERSONAS } from "@bea/domain";

export const FIXED_TEST_TIME = "2026-01-02T03:04:05.000Z";

export class FixedClock implements Clock {
  constructor(private readonly value = FIXED_TEST_TIME) {}
  now(): Date {
    return new Date(this.value);
  }
}

export class SequenceIdGenerator implements IdGenerator {
  private index = 0;
  constructor(private readonly prefix = "test-id") {}
  next(): string {
    this.index += 1;
    return `${this.prefix}-${this.index}`;
  }
}

export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditLog[] = [];
  async record(input: AuditEventInput): Promise<AuditLog> {
    const event: AuditLog = {
      id: `audit-${this.events.length + 1}`,
      eventType: input.eventType,
      action: input.action,
      outcome: input.outcome,
      actorUserId: input.actorUserId ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      correlationId: input.correlationId ?? null,
      metadata: input.metadata ?? {},
      createdAt: input.createdAt ?? FIXED_TEST_TIME,
    };
    this.events.push(event);
    return event;
  }
}

export class InMemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, AuthenticationSession>();
  async createSession(session: AuthenticationSession): Promise<void> {
    this.sessions.set(session.tokenHash, session);
  }
  async findSessionByTokenHash(tokenHash: string): Promise<AuthenticationSession | null> {
    return this.sessions.get(tokenHash) ?? null;
  }
  async revokeSession(sessionId: string, revokedAt: string): Promise<void> {
    for (const [key, session] of this.sessions) {
      if (session.id === sessionId) {
        this.sessions.set(key, {
          ...session,
          revokedAt,
          updatedAt: revokedAt,
          version: session.version + 1,
        });
      }
    }
  }
}

export class InMemoryUserDirectory implements UserDirectory {
  readonly users: readonly AuthenticatedUser[] = DEMO_PERSONAS.map((persona) => ({
    id: persona.id,
    personaKey: persona.key,
    email: persona.email,
    displayName: persona.displayName,
    title: persona.title,
    status: "active",
    createdByUserId: null,
    archivedAt: null,
    createdAt: FIXED_TEST_TIME,
    updatedAt: FIXED_TEST_TIME,
    version: 1,
    roleIds: persona.roleIds,
  }));
  async findActiveUserByPersonaKey(personaKey: string): Promise<AuthenticatedUser | null> {
    return this.users.find((user) => user.personaKey === personaKey) ?? null;
  }
  async findActiveUserById(userId: string): Promise<AuthenticatedUser | null> {
    return this.users.find((user) => user.id === userId) ?? null;
  }
}

export class InMemoryWorkflowStore implements WorkflowStore {
  readonly runs = new Map<string, WorkflowRun>();
  readonly steps: WorkflowStepRun[] = [];
  async claimWorkflowRun(run: WorkflowRun): Promise<WorkflowRunClaim> {
    const existing = this.runs.get(run.idempotencyKey);
    if (existing) return { run: existing, claimed: false };
    this.runs.set(run.idempotencyKey, run);
    return { run, claimed: true };
  }
  async saveWorkflowStepRun(step: WorkflowStepRun): Promise<void> {
    this.steps.push(step);
  }
  async finishWorkflowRun(
    input: Parameters<WorkflowStore["finishWorkflowRun"]>[0],
  ): Promise<WorkflowRun> {
    const entry = [...this.runs.entries()].find(([, run]) => run.id === input.id);
    if (!entry || entry[1].version !== input.expectedVersion)
      throw new Error("Workflow version mismatch.");
    const updated: WorkflowRun = {
      ...entry[1],
      status: input.status,
      finishedAt: input.finishedAt,
      error: input.error,
      updatedAt: input.finishedAt,
      version: entry[1].version + 1,
    };
    this.runs.set(entry[0], updated);
    return updated;
  }
  async getWorkflowRunByIdempotencyKey(idempotencyKey: string): Promise<WorkflowRun | null> {
    return this.runs.get(idempotencyKey) ?? null;
  }
  async getLatestWorkflowRun(workflowKey: string): Promise<WorkflowRun | null> {
    return [...this.runs.values()].filter((run) => run.workflowKey === workflowKey).at(-1) ?? null;
  }
  async listWorkflowStepRuns(workflowRunId: string): Promise<readonly WorkflowStepRun[]> {
    return this.steps
      .filter((step) => step.workflowRunId === workflowRunId)
      .sort((left, right) => left.sequence - right.sequence);
  }
}
