"use client";

import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from "@bea/ui";
import type {
  DigitalAgentRun,
  DigitalAgentRunStep,
  DigitalWorkforceHandoff,
  DigitalWorkforceRunEvent,
} from "@bea/domain";

export function DigitalWorkforceRunTrace({
  run,
  steps,
  handoffs,
  events,
  onOpenHandoff,
  onOpenArtifact,
}: {
  readonly run: DigitalAgentRun | null;
  readonly steps: readonly DigitalAgentRunStep[];
  readonly handoffs: readonly DigitalWorkforceHandoff[];
  readonly events: readonly DigitalWorkforceRunEvent[];
  readonly onOpenHandoff?: (handoffId: string) => void;
  readonly onOpenArtifact?: (artifactId: string) => void;
}) {
  if (!run) {
    return (
      <EmptyState
        title="No active Digital Workforce run"
        description="Start the executive-team workflow to see agents, handoffs, models, and artifacts."
      />
    );
  }
  return (
    <div className="bea-stack" data-testid="workforce-run-trace">
      <Card>
        <CardHeader>
          <CardTitle>{run.goal}</CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            <Badge tone="info">{run.status.replaceAll("_", " ")}</Badge>
          </p>
          <p>Root Digital Agent {run.rootAgentId}</p>
          <p>Estimated usage ${run.estimatedCostUsd.toFixed(2)}</p>
          {run.executiveSummary ? <p>{run.executiveSummary}</p> : null}
          {run.safeError ? <p role="alert">{run.safeError}</p> : null}
        </CardContent>
      </Card>
      <ol className="bea-workforce-steps" aria-label="Run steps">
        {steps.map((step) => (
          <li key={step.id} data-testid={`workforce-step-${step.stepKey}`}>
            <strong>{step.stepKey}</strong>
            <span> {step.status}</span>
            {step.model ? <small> Model {step.model}</small> : null}
            {step.toolNames.length > 0 ? <small> Tools {step.toolNames.join(", ")}</small> : null}
            <p>{step.assignedWhy}</p>
          </li>
        ))}
      </ol>
      <ul className="bea-workforce-handoffs" aria-label="Handoffs">
        {handoffs.map((handoff) => (
          <li key={handoff.id}>
            <button
              type="button"
              data-testid={`workforce-handoff-${handoff.id}`}
              onClick={() => onOpenHandoff?.(handoff.id)}
            >
              {handoff.packet.reason} → {handoff.status}
            </button>
          </li>
        ))}
      </ul>
      {run.outputArtifactIds.map((artifactId) => (
        <button
          key={artifactId}
          type="button"
          data-testid={`workforce-artifact-${artifactId}`}
          onClick={() => onOpenArtifact?.(artifactId)}
        >
          Open generated PDF
        </button>
      ))}
      <ol className="bea-workforce-events" aria-label="Run progress">
        {events.map((event) => (
          <li key={event.id}>{event.narration ?? event.eventType}</li>
        ))}
      </ol>
    </div>
  );
}
