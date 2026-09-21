"use client";

import { Alert, Badge, Button } from "@bea/ui";
import {
  ARTIFACT_BRAND_POLICY_VERSION,
  ARTIFACT_TEMPLATE_VERSION,
  BEA_CHART_PALETTE,
} from "@bea/artifacts/brand";
import type { ReactNode } from "react";

import { ApplicationPdfViewer } from "@/components/application-pdf-viewer";
import { DigitalWorkforceRunTrace } from "@/components/digital-workforce-run-trace";
import styles from "@/components/ai-command.module.css";
import type { AiCommandArtifactView } from "@/lib/ai-command-contracts";
import { parsePresentationFromPayload } from "@bea/ai/presentation";
import type { AiPresentationPacket, AiSafeWorkspaceSelection } from "@bea/domain";
import { safeInternalHref } from "@/lib/safe-return-path";

export interface WorkspaceRendererProps {
  readonly artifact: AiCommandArtifactView;
  readonly canExecuteTaskAction: boolean;
  readonly onConfirmAction: (actionId: string) => void;
  readonly titleRenderedByParent?: boolean;
  readonly activeVisualElementId?: string | null;
  readonly selectedElementId?: string | null;
  readonly autoFollow?: boolean;
  readonly narrationActive?: boolean;
  readonly onSelectWorkspaceItem?: (selection: AiSafeWorkspaceSelection) => void;
  readonly onFollowNarration?: () => void;
}

type Renderer = (props: WorkspaceRendererProps) => ReactNode;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeHref(value: unknown): string | null {
  return safeInternalHref(value);
}

function safeExternalHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  const internal = safeInternalHref(value);
  if (internal) return internal;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function recordList(value: unknown, limit = 80): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord).slice(0, limit) : [];
}

function textList(value: unknown, limit = 30): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .slice(0, limit)
    .map((entry) => entry.trim());
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function GenericRecords({
  artifact,
  selectedElementId,
  activeVisualElementId,
  autoFollow = true,
  onSelectWorkspaceItem,
}: WorkspaceRendererProps) {
  const payload = artifact.payload as Record<string, unknown>;
  const presentation = parsePresentationFromPayload(payload);
  const items = Array.isArray(payload.items) ? payload.items.filter(isRecord) : [];
  if (items.length === 0) {
    return (
      <div className="bea-ai-artifact-empty">
        <p>No authorized records matched this request.</p>
      </div>
    );
  }
  return (
    <div
      className="bea-ai-record-list bea-workspace-records"
      data-workspace-content="records"
      data-testid={presentation ? "lead-presentation" : undefined}
      data-presentation-run={presentation?.presentationRunId}
      data-auto-follow={presentation ? (autoFollow ? "true" : "false") : undefined}
    >
      {presentation ? (
        <section data-visual-element="summary">
          <p>{presentation.summary}</p>
        </section>
      ) : null}
      {items.map((item, index) => {
        const href = safeHref(item.href);
        const title = displayValue(
          item.title ?? item.name ?? item.displayName ?? `Record ${index + 1}`,
        );
        const itemId = String(item.id ?? index);
        const visualId = `lead:${itemId}`;
        const selectedHere = selectedElementId === itemId || selectedElementId === `lead-${itemId}`;
        return (
          <article
            className={
              activeVisualElementId === visualId || selectedHere
                ? `${styles.narrationHighlight} bea-ai-record bea-workspace-record-row`
                : "bea-ai-record bea-workspace-record-row"
            }
            key={itemId}
            data-visual-element={visualId}
            data-selected={selectedHere ? "true" : "false"}
            data-testid={`record-${itemId}`}
          >
            <div>
              <h3>
                {presentation && onSelectWorkspaceItem ? (
                  <button
                    type="button"
                    data-workspace-select="true"
                    onClick={() =>
                      onSelectWorkspaceItem({
                        presentationRunId: presentation.presentationRunId,
                        artifactId: presentation.visualArtifactId || artifact.id,
                        kind: "lead",
                        elementId: `lead-${itemId}`,
                        recordType: "lead",
                        recordId: itemId,
                      })
                    }
                  >
                    {title}
                  </button>
                ) : href ? (
                  <a href={href}>{title}</a>
                ) : (
                  title
                )}
              </h3>
              {item.subtitle ? <p>{displayValue(item.subtitle)}</p> : null}
            </div>
            <div className="bea-cluster">
              {item.status ? <Badge tone="info">{displayValue(item.status)}</Badge> : null}
              {item.priority ? <Badge tone="warning">{displayValue(item.priority)}</Badge> : null}
              {item.dueAt ? (
                <span>
                  Due{" "}
                  <time dateTime={String(item.dueAt)}>
                    {displayValue(item.dueLabel ?? item.dueAt)}
                  </time>
                </span>
              ) : null}
              {href ? (
                <a href={href} data-testid={`open-record-${itemId}`}>
                  Open record
                </a>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ActivityRecords({ artifact }: WorkspaceRendererProps) {
  const payload = artifact.payload as Record<string, unknown>;
  const items = recordList(payload.items);
  if (items.length === 0) {
    return (
      <div className="bea-ai-artifact-empty">
        <p>No authorized activity matched this request.</p>
      </div>
    );
  }
  return (
    <ol className={`${styles.timeline} bea-workspace-activity`} data-workspace-content="activity">
      {items.map((item, index) => {
        const href = safeHref(item.href);
        const title = displayValue(item.title ?? item.name ?? `Activity ${index + 1}`);
        return (
          <li key={String(item.id ?? index)}>
            <strong>{href ? <a href={href}>{title}</a> : title}</strong>
            {item.subtitle ? <small>{displayValue(item.subtitle)}</small> : null}
            {item.status ? <span>{displayValue(item.status)}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function Detail({ artifact }: WorkspaceRendererProps) {
  const payload = artifact.payload as Record<string, unknown>;
  const record = isRecord(payload.record) ? payload.record : payload;
  const entries = Object.entries(record).filter(
    ([key]) => !["id", "href", "title", "name", "displayName", "items"].includes(key),
  );
  return (
    <dl className="bea-meta-list bea-workspace-details" data-workspace-content="record-detail">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key.replace(/([A-Z])/gu, " $1").replaceAll("_", " ")}</dt>
          <dd>{displayValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Summary({ artifact }: WorkspaceRendererProps) {
  const payload = artifact.payload as Record<string, unknown>;
  const metrics = Array.isArray(payload.metrics) ? payload.metrics.filter(isRecord) : [];
  return (
    <div className="bea-ai-metrics bea-workspace-metrics" data-workspace-content="metrics">
      {metrics.map((metric, index) => {
        const href = safeHref(metric.href);
        return (
          <article key={String(metric.label ?? index)}>
            <span>{displayValue(metric.label)}</span>
            <strong>{displayValue(metric.value)}</strong>
            {href ? <a href={href}>Open records</a> : null}
          </article>
        );
      })}
    </div>
  );
}

function Help({ artifact }: WorkspaceRendererProps) {
  const payload = artifact.payload as Record<string, unknown>;
  const commands = Array.isArray(payload.commands) ? payload.commands : [];
  return (
    <div className="bea-workspace-empty" data-workspace-content="empty">
      <p>Ask BEA to open an authorized record, research a topic, or prepare an artifact.</p>
      {commands.length > 0 ? (
        <span className="bea-visually-hidden">
          Available commands: {commands.map((command) => displayValue(command)).join(". ")}
        </span>
      ) : null}
    </div>
  );
}

function EmptyWorkspace(props: WorkspaceRendererProps) {
  const { artifact } = props;
  const payload = payloadRecord(artifact);
  const componentStatus = isRecord(payload.componentStatus) ? payload.componentStatus : null;
  if (!componentStatus) return <GenericRecords {...props} />;
  const rows = [
    ["OpenAI text", componentStatus.openAiText],
    ["Web search", componentStatus.webSearch],
    ["File search", componentStatus.fileSearch],
    ["Voice", componentStatus.voice],
    ["BEA data", componentStatus.beaData],
    ["Business integrations", componentStatus.businessIntegrations],
  ] as const;
  return (
    <div className="bea-stack bea-workspace-empty" data-workspace-content="setup-required">
      <p>
        BEA will not substitute provider answers or business records. An authorized administrator
        can connect OpenAI securely in this workspace.
      </p>
      <dl className="bea-meta-list" aria-label="Production component status">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{displayValue(value ?? "Not connected")}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ActionPreview({
  artifact,
  canExecuteTaskAction,
  onConfirmAction,
}: WorkspaceRendererProps) {
  const payload = artifact.payload as Record<string, unknown>;
  const fields = isRecord(payload.fields) ? payload.fields : {};
  const actionId = typeof payload.actionId === "string" ? payload.actionId : null;
  const superseded = payload.superseded === true;
  const executable = !superseded && payload.executable === true && canExecuteTaskAction;
  return (
    <div
      className="bea-stack bea-workspace-action-overlay"
      data-workspace-overlay="action-confirmation"
    >
      {superseded ? (
        <Alert tone="info" title="Preview superseded">
          A newer request was reserved. This prior proposal can no longer be confirmed.
        </Alert>
      ) : (
        <Alert tone="warning" title="Awaiting confirmation">
          Review every field below. No task has been created yet.
        </Alert>
      )}
      <dl className="bea-meta-list">
        {Object.entries(fields).map(([key, value]) => (
          <div key={key}>
            <dt>{key.replace(/([A-Z])/gu, " $1")}</dt>
            <dd>{displayValue(value)}</dd>
          </div>
        ))}
        <div>
          <dt>Required permission</dt>
          <dd className="bea-code">{displayValue(payload.requiredPermission)}</dd>
        </div>
        <div>
          <dt>Acting user</dt>
          <dd>{displayValue(payload.actingUser)}</dd>
        </div>
      </dl>
      {executable && actionId ? (
        <Button onClick={() => onConfirmAction(actionId)}>Review and confirm task</Button>
      ) : (
        <Alert tone="info" title={superseded ? "Confirmation unavailable" : "View-only preview"}>
          {superseded
            ? "This proposal was invalidated before the newer request was processed."
            : "Your role may review this proposal but cannot execute the write."}
        </Alert>
      )}
    </div>
  );
}

function ActionResult({ artifact }: WorkspaceRendererProps) {
  const payload = artifact.payload as Record<string, unknown>;
  const href = safeHref(payload.href);
  return (
    <div className="bea-workspace-action-result" data-workspace-content="action-result">
      <Alert tone="success" title="Task created">
        <p>{displayValue(payload.message ?? "The task was verified in the database.")}</p>
        {href ? <a href={href}>Open the created task</a> : null}
        {payload.idempotent === true ? (
          <p>Repeated confirmation restores this same verified result without another task.</p>
        ) : null}
      </Alert>
    </div>
  );
}

function Failure({ artifact }: WorkspaceRendererProps) {
  return (
    <Alert tone="danger" title="Workspace unavailable">
      {displayValue((artifact.payload as Record<string, unknown>).message ?? artifact.errorCode)}
    </Alert>
  );
}

export const APPLICATION_RENDERER_NAMES = [
  "research-board",
  "source-board",
  "document",
  "email",
  "report",
  "line-chart",
  "bar-chart",
  "stacked-bar-chart",
  "area-chart",
  "donut-chart",
  "scatter-chart",
  "timeline-chart",
  "metric-chart",
  "comparison-chart",
  "table",
  "comparison",
  "analysis",
  "pdf-preview",
  "image",
  "file",
  "progress",
] as const;

export type ApplicationRendererName = (typeof APPLICATION_RENDERER_NAMES)[number];

export const NORMALIZED_ARTIFACT_RENDERER_NAMES = [
  "pdf",
  "image",
  "chart",
  "table",
  "data",
  "research",
  "source-board",
  "metric",
  "timeline",
  "comparison",
  "analysis",
  "error",
] as const;

type NormalizedArtifactRendererName = (typeof NORMALIZED_ARTIFACT_RENDERER_NAMES)[number];

const CHART_COLORS = BEA_CHART_PALETTE;

function isApplicationRendererName(value: string): value is ApplicationRendererName {
  return (APPLICATION_RENDERER_NAMES as readonly string[]).includes(value);
}

function isNormalizedArtifactRendererName(value: string): value is NormalizedArtifactRendererName {
  return (NORMALIZED_ARTIFACT_RENDERER_NAMES as readonly string[]).includes(value);
}

function payloadRecord(artifact: AiCommandArtifactView): Record<string, unknown> {
  return artifact.payload as Record<string, unknown>;
}

function applicationItems(payload: Record<string, unknown>): Record<string, unknown>[] {
  return recordList(
    payload.items ?? payload.results ?? payload.sections ?? payload.sources ?? payload.data,
  );
}

function paragraphList(value: unknown, limit = 80): string[] {
  if (Array.isArray(value)) return textList(value, limit);
  if (typeof value !== "string") return [];
  return value
    .split(/\r?\n\s*\r?\n/gu)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .slice(0, limit);
}

const LONG_FORM_METADATA_FIELDS = [
  ["from", "From"],
  ["to", "To"],
  ["cc", "Cc"],
  ["subject", "Subject"],
  ["date", "Date"],
  ["author", "Author"],
  ["preparedFor", "Prepared for"],
] as const;

function LongFormDocument({
  artifact,
  kindOverride,
  ...props
}: WorkspaceRendererProps & { readonly kindOverride?: string }) {
  const payload = payloadRecord(artifact);
  const sections = recordList(payload.sections, 40);
  const findings = textList(payload.findings ?? payload.keyPoints ?? payload.bullets, 80);
  const normalizedAnalysis = payload.schemaVersion === 1 && payload.renderer === "analysis";
  const body = paragraphList(
    payload.body ??
      payload.analysis ??
      payload.text ??
      payload.content ??
      (normalizedAnalysis ? undefined : payload.summary),
  );
  const metadata = LONG_FORM_METADATA_FIELDS.flatMap(([key, label]) => {
    const value = payload[key];
    if (value === undefined || value === null || value === "") return [];
    return [
      {
        key,
        label,
        value: Array.isArray(value) ? value.map(displayValue).join(", ") : displayValue(value),
      },
    ];
  });
  const kind = textValue(
    kindOverride ?? payload.documentType ?? payload.kind ?? payload.format ?? payload.renderer,
    "document",
  ).toLowerCase();
  if (body.length === 0 && sections.length === 0 && findings.length === 0) return null;
  return (
    <article
      className={`${styles.longForm} bea-workspace-long-form`}
      data-workspace-content="long-form"
      data-long-form-kind={kind}
    >
      {metadata.length > 0 ? (
        <dl className="bea-meta-list" aria-label={`${kind} metadata`}>
          {metadata.map((entry) => (
            <div key={entry.key}>
              <dt>{entry.label}</dt>
              <dd>{entry.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {body.map((paragraph, index) => (
        <p key={`body-${index}`}>{paragraph}</p>
      ))}
      {sections.map((section, index) => {
        const sectionParagraphs = paragraphList(
          section.paragraphs ?? section.body ?? section.text ?? section.content,
        );
        const bullets = textList(section.bullets ?? section.items ?? section.points, 80);
        const numbered = textList(section.steps ?? section.orderedItems, 80);
        return (
          <section
            className="bea-workspace-long-form-section"
            key={textValue(section.id, `long-form-section-${index}`)}
          >
            <h3>{textValue(section.heading ?? section.title, `Section ${index + 1}`)}</h3>
            {sectionParagraphs.map((paragraph, paragraphIndex) => (
              <p key={`section-${index}-paragraph-${paragraphIndex}`}>{paragraph}</p>
            ))}
            {bullets.length > 0 ? (
              <ul>
                {bullets.map((bullet, bulletIndex) => (
                  <li key={`${bullet}-${bulletIndex}`}>{bullet}</li>
                ))}
              </ul>
            ) : null}
            {numbered.length > 0 ? (
              <ol>
                {numbered.map((item, itemIndex) => (
                  <li key={`${item}-${itemIndex}`}>{item}</li>
                ))}
              </ol>
            ) : null}
            {isRecord(section.table) ? (
              <ApplicationTable
                {...withPayload({ artifact, ...props }, { table: section.table })}
              />
            ) : null}
          </section>
        );
      })}
      {findings.length > 0 ? (
        <section className="bea-workspace-long-form-section">
          <h3>Key findings</h3>
          <ul>
            {findings.map((finding, index) => (
              <li key={`${finding}-${index}`}>{finding}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

function ResearchBoard(props: WorkspaceRendererProps) {
  const { artifact } = props;
  const payload = payloadRecord(artifact);
  const presentation = parsePresentationFromPayload(payload);
  if (presentation) {
    return <CoPresenterResearch {...props} presentation={presentation} />;
  }
  const findings = textList(payload.findings ?? payload.keyPoints ?? payload.bullets);
  const body = paragraphList(
    payload.body ??
      payload.analysis ??
      payload.text ??
      (payload.schemaVersion === 1 ? undefined : payload.summary),
  );
  const sections = recordList(payload.sections, 40);
  const hasSources =
    applicationItems(payload).length > 0 ||
    recordList(payload.citations, 64).length > 0 ||
    artifact.sources.length > 0;
  if (findings.length === 0 && body.length === 0 && sections.length === 0 && !hasSources) {
    return <p>No research items are available for this artifact.</p>;
  }
  if (findings.length === 0 && body.length === 0 && sections.length === 0) return null;
  return <LongFormDocument {...props} kindOverride="research" />;
}

function presentationLabel(packet: AiPresentationPacket): string | null {
  if (packet.routeKey !== "public_web_research") {
    return packet.beaRecordsLive
      ? "AUTHORIZED BEA RECORDS"
      : "DEMONSTRATION BEA RECORDS · NOT LIVE BUSINESS DATA";
  }
  if (!packet.liveWebSearch && !(packet.simulated && packet.sources.length > 0)) return null;
  return packet.simulated ? "SIMULATED WEB RESEARCH" : "LIVE WEB RESEARCH";
}

function CoPresenterResearch({
  artifact,
  presentation,
  activeVisualElementId,
  selectedElementId,
  autoFollow = true,
  narrationActive = false,
  onSelectWorkspaceItem,
}: WorkspaceRendererProps & { readonly presentation: AiPresentationPacket }) {
  const selected = selectedElementId ?? presentation.selected?.elementId ?? null;
  const active = activeVisualElementId ?? null;
  const label = presentationLabel(presentation);

  function select(
    kind: AiSafeWorkspaceSelection["kind"],
    elementId: string,
    recordType?: AiSafeWorkspaceSelection["recordType"],
    recordId?: string,
  ) {
    onSelectWorkspaceItem?.({
      presentationRunId: presentation.presentationRunId,
      artifactId: presentation.visualArtifactId || artifact.id,
      kind,
      elementId,
      ...(recordType ? { recordType } : {}),
      ...(recordId ? { recordId } : {}),
    });
  }

  return (
    <article
      className="bea-workspace-research"
      data-testid="research-presentation"
      data-presentation-run={presentation.presentationRunId}
      data-presentation-status={presentation.status}
      data-auto-follow={autoFollow ? "true" : "false"}
      data-narration-active={narrationActive ? "true" : "false"}
      data-workspace-content="research"
    >
      <header className={styles.artifactHeader}>
        {label ? (
          <Badge tone={presentation.simulated ? "warning" : "success"}>{label}</Badge>
        ) : null}
        {presentation.status === "insufficient_evidence" ? (
          <Badge tone="warning">Insufficient evidence</Badge>
        ) : null}
        {presentation.status === "provider_disconnected" ? (
          <Badge tone="danger">Provider disconnected</Badge>
        ) : null}
      </header>
      <section
        data-visual-element="summary"
        data-active-narration={active === "summary" ? "true" : "false"}
        className={active === "summary" ? styles.narrationHighlight : undefined}
      >
        <h3>Executive summary</h3>
        <p>{presentation.summary}</p>
      </section>
      {presentation.findings.length > 0 ? (
        <section>
          <h3>Key findings</h3>
          {presentation.findings.map((finding) => {
            const visualId = `finding:${finding.id}`;
            const selectedHere = selected === finding.id;
            return (
              <button
                type="button"
                key={finding.id}
                className={
                  active === visualId || selectedHere
                    ? styles.narrationHighlight
                    : styles.findingCard
                }
                data-visual-element={visualId}
                data-selected={selectedHere ? "true" : "false"}
                data-testid={`finding-${finding.id}`}
                data-workspace-select="true"
                onClick={() =>
                  select(
                    finding.id.startsWith("lead-") ? "lead" : "finding",
                    finding.id,
                    finding.id.startsWith("lead-") ? "lead" : undefined,
                    finding.id.startsWith("lead-") ? finding.id.slice(5) : undefined,
                  )
                }
              >
                <strong>{finding.title}</strong>
                <p>{finding.body}</p>
              </button>
            );
          })}
        </section>
      ) : null}
      {presentation.analysisValidated === false ? (
        <p data-testid="analysis-unavailable">
          Situation-specific analysis is unavailable. Verified sources are retained.
        </p>
      ) : null}
      {presentation.implications.map((item) => {
        const visualId = `implication:${item.id}`;
        return (
          <section
            key={item.id}
            data-visual-element={visualId}
            data-selected={selected === item.id ? "true" : "false"}
            className={
              active === visualId || selected === item.id ? styles.narrationHighlight : undefined
            }
          >
            <button
              type="button"
              data-workspace-select="true"
              onClick={() => select("implication", item.id)}
            >
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </button>
          </section>
        );
      })}
      {presentation.risks.map((item) => {
        const visualId = `risk:${item.id}`;
        return (
          <section
            key={item.id}
            data-visual-element={visualId}
            data-selected={selected === item.id ? "true" : "false"}
            className={
              active === visualId || selected === item.id ? styles.narrationHighlight : undefined
            }
          >
            <button
              type="button"
              data-workspace-select="true"
              onClick={() => select("risk", item.id)}
            >
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </button>
          </section>
        );
      })}
      {presentation.recommendations.map((item) => {
        const visualId = `recommendation:${item.id}`;
        return (
          <section
            key={item.id}
            data-visual-element={visualId}
            data-selected={selected === item.id ? "true" : "false"}
            className={
              active === visualId || selected === item.id ? styles.narrationHighlight : undefined
            }
          >
            <button
              type="button"
              data-workspace-select="true"
              onClick={() => select("recommendation", item.id)}
            >
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </button>
          </section>
        );
      })}
      {presentation.suggestedNextStep ? (
        <p>
          <strong>Suggested next step.</strong> {presentation.suggestedNextStep}
        </p>
      ) : null}
      <CoPresenterSourceBoard
        presentation={presentation}
        artifactId={artifact.id}
        activeVisualElementId={active}
        selectedElementId={selected}
        onSelect={select}
      />
    </article>
  );
}

function CoPresenterSourceBoard({
  presentation,
  artifactId,
  activeVisualElementId,
  selectedElementId,
  onSelect,
}: {
  readonly presentation: AiPresentationPacket;
  readonly artifactId: string;
  readonly activeVisualElementId: string | null;
  readonly selectedElementId: string | null;
  readonly onSelect: (
    kind: AiSafeWorkspaceSelection["kind"],
    elementId: string,
    recordType?: AiSafeWorkspaceSelection["recordType"],
    recordId?: string,
  ) => void;
}) {
  if (presentation.sources.length === 0 && presentation.citations.length === 0) {
    return (
      <aside data-testid="source-board" aria-label="Source board">
        <h3>Sources and citations</h3>
        <p>No valid citation was returned.</p>
      </aside>
    );
  }
  return (
    <aside
      className={`bea-ai-sources ${styles.provenance} bea-workspace-provenance`}
      data-testid="source-board"
      aria-label="Source board"
    >
      <h3>Sources and citations</h3>
      <ol className="bea-workspace-source-list">
        {presentation.sources.map((source) => {
          const href = source.url.startsWith("/")
            ? safeHref(source.url)
            : safeExternalHref(source.url);
          const visualId = `source:${source.id}`;
          const selectedHere = selectedElementId === source.id;
          const supports = presentation.findings
            .filter((finding) => finding.sourceIds.includes(source.id))
            .map((finding) => finding.title)
            .join(", ");
          return (
            <li
              key={source.id}
              className={
                activeVisualElementId === visualId || selectedHere
                  ? styles.narrationHighlight
                  : "bea-workspace-source-row"
              }
              data-visual-element={visualId}
              data-selected={selectedHere ? "true" : "false"}
              data-testid={`source-${source.id}`}
            >
              <button
                type="button"
                data-workspace-select="true"
                onClick={() => onSelect("source", source.id)}
              >
                <strong>
                  Source {source.number}. {source.title}
                </strong>
                <small>{source.domain}</small>
                <time dateTime={source.retrievedAt}>{source.retrievedAt}</time>
                {supports ? <p>Supports: {supports}</p> : null}
              </button>
              {href && !source.simulated ? (
                <a
                  href={href}
                  data-testid={`citation-${source.id}`}
                  rel={href.startsWith("/") ? undefined : "noopener noreferrer"}
                  target={href.startsWith("/") ? undefined : "_blank"}
                >
                  Open source
                </a>
              ) : source.simulated ? (
                <span data-testid={`citation-${source.id}`} data-simulated-source="true">
                  Simulated source (not a live URL)
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {presentation.citations.length > 0 ? (
        <ul aria-label="Inline citations">
          {presentation.citations.map((citation) => {
            const href = safeExternalHref(citation.url) ?? safeHref(citation.url);
            return (
              <li key={citation.id}>
                {href && !citation.simulated ? (
                  <a
                    href={href}
                    data-testid={`citation-link-${citation.id}`}
                    rel={href.startsWith("/") ? undefined : "noopener noreferrer"}
                    target={href.startsWith("/") ? undefined : "_blank"}
                  >
                    {citation.title}
                  </a>
                ) : (
                  <span data-testid={`citation-link-${citation.id}`}>{citation.title}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      <span className="bea-visually-hidden">{artifactId}</span>
    </aside>
  );
}

function ApplicationTable({ artifact }: WorkspaceRendererProps) {
  const payload = payloadRecord(artifact);
  const table = isRecord(payload.table) ? payload.table : payload;
  const explicitColumns = Array.isArray(table.columns)
    ? table.columns.slice(0, 24).flatMap((column) => {
        if (typeof column === "string" && column.trim()) {
          return [{ key: column.trim(), label: column.trim() }];
        }
        if (!isRecord(column)) return [];
        const key = textValue(column.key ?? column.id);
        if (!key) return [];
        return [{ key, label: textValue(column.label ?? column.title, key) }];
      })
    : [];
  const rawRows = Array.isArray(table.rows ?? table.items ?? table.data)
    ? (table.rows ?? table.items ?? table.data)
    : [];
  const rows = (rawRows as unknown[]).slice(0, 120).flatMap((row) => {
    if (isRecord(row)) return [row];
    if (!Array.isArray(row) || explicitColumns.length === 0) return [];
    return [
      Object.fromEntries(explicitColumns.map((column, index) => [column.key, row[index] ?? null])),
    ];
  });
  const columns =
    explicitColumns.length > 0
      ? explicitColumns
      : [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 24).map((key) => ({
          key,
          label: key.replace(/([A-Z])/gu, " $1").replaceAll("_", " "),
        }));
  if (rows.length === 0 || columns.length === 0) return <p>No table rows are available.</p>;
  return (
    <div className={`${styles.tableWrap} bea-workspace-table`} data-workspace-content="table">
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th scope="col" key={column.key}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={textValue(row.id, `row-${rowIndex}`)}>
              {columns.map((column) => {
                const href = column.key === "href" ? safeHref(row[column.key]) : null;
                return (
                  <td key={column.key}>
                    {href ? <a href={href}>Open</a> : displayValue(row[column.key])}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Comparison({ artifact }: WorkspaceRendererProps) {
  const payload = payloadRecord(artifact);
  const items = applicationItems(payload);
  if (items.length === 0) return <p>No comparison entries are available.</p>;
  return (
    <div
      className={`${styles.metricGrid} bea-workspace-comparison`}
      data-workspace-content="comparison"
    >
      {items.map((item, index) => (
        <article className={styles.metricCard} key={textValue(item.id, `comparison-${index}`)}>
          <span>
            {displayValue(item.label ?? item.title ?? item.name ?? `Option ${index + 1}`)}
          </span>
          {item.value !== undefined ? <strong>{displayValue(item.value)}</strong> : null}
          {(item.detail ?? item.description) ? (
            <p>{displayValue(item.detail ?? item.description)}</p>
          ) : null}
          {textList(item.points).length > 0 ? (
            <ul>
              {textList(item.points).map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function Analysis(props: WorkspaceRendererProps) {
  return (
    <div className={`${styles.analysis} bea-workspace-analysis`} data-workspace-content="analysis">
      <LongFormDocument {...props} kindOverride="analysis" />
    </div>
  );
}

interface NumericPoint {
  readonly label: string;
  readonly value: number;
}

interface NumericSeries {
  readonly label: string;
  readonly points: readonly NumericPoint[];
}

function numericPoints(value: unknown): NumericPoint[] {
  return recordList(value, 64).flatMap((item, index) => {
    const numeric = numberValue(item.y ?? item.value ?? item.amount ?? item.total);
    if (numeric === null) return [];
    return [
      {
        label: textValue(item.label ?? item.x ?? item.name ?? item.date, String(index + 1)),
        value: numeric,
      },
    ];
  });
}

function numericSeries(payload: Record<string, unknown>): NumericSeries[] {
  const series = recordList(payload.series, 8).flatMap((entry, index) => {
    const points = numericPoints(entry.points ?? entry.data ?? entry.items ?? entry.values);
    return points.length > 0
      ? [{ label: textValue(entry.label ?? entry.name, `Series ${index + 1}`), points }]
      : [];
  });
  if (series.length > 0) return series;
  const points = numericPoints(payload.points ?? payload.data ?? payload.items ?? payload.values);
  return points.length > 0 ? [{ label: textValue(payload.label, "Value"), points }] : [];
}

function chartCoordinates(series: readonly NumericSeries[]) {
  const values = series.flatMap((entry) => entry.points.map((point) => point.value));
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const span = Math.max(1, maximum - minimum);
  const maxPoints = Math.max(2, ...series.map((entry) => entry.points.length));
  return {
    x: (index: number) => 48 + (index / (maxPoints - 1)) * 548,
    y: (value: number) => 236 - ((value - minimum) / span) * 190,
    zero: 236 - ((0 - minimum) / span) * 190,
  };
}

function LineAreaScatterChart({
  artifact,
  kind,
}: WorkspaceRendererProps & { readonly kind: "area" | "line" | "scatter" }) {
  const series = numericSeries(payloadRecord(artifact));
  if (series.length === 0) return <p>No validated numeric points are available.</p>;
  const scale = chartCoordinates(series);
  return (
    <div className={`${styles.chart} bea-workspace-chart`} data-workspace-content="chart">
      <svg viewBox="0 0 640 280" role="img" aria-label={`${artifact.title} ${kind} chart`}>
        <line x1="48" y1={scale.zero} x2="604" y2={scale.zero} stroke="#71959d" opacity="0.45" />
        {series.map((entry, seriesIndex) => {
          const color = CHART_COLORS[seriesIndex % CHART_COLORS.length];
          const points = entry.points.map(
            (point, index) => `${scale.x(index)},${scale.y(point.value)}`,
          );
          if (kind === "scatter") {
            return (
              <g key={entry.label}>
                {entry.points.map((point, index) => (
                  <circle
                    cx={scale.x(index)}
                    cy={scale.y(point.value)}
                    fill={color}
                    key={`${point.label}-${index}`}
                    r="5"
                  >
                    <title>{`${point.label}: ${point.value}`}</title>
                  </circle>
                ))}
              </g>
            );
          }
          const firstX = scale.x(0);
          const lastX = scale.x(entry.points.length - 1);
          return (
            <g key={entry.label}>
              {kind === "area" ? (
                <polygon
                  fill={color}
                  opacity="0.18"
                  points={`${firstX},${scale.zero} ${points.join(" ")} ${lastX},${scale.zero}`}
                />
              ) : null}
              <polyline
                fill="none"
                points={points.join(" ")}
                stroke={color}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="4"
              />
            </g>
          );
        })}
      </svg>
      <ChartLegend series={series} />
    </div>
  );
}

function ChartLegend({ series }: { readonly series: readonly NumericSeries[] }) {
  return (
    <div className={styles.chartLegend} aria-label="Chart legend">
      {series.map((entry, index) => (
        <span key={entry.label}>
          <i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
          {entry.label}
        </span>
      ))}
    </div>
  );
}

function BarChart({ artifact, stacked }: WorkspaceRendererProps & { readonly stacked: boolean }) {
  const series = numericSeries(payloadRecord(artifact));
  if (series.length === 0) return <p>No validated numeric values are available.</p>;
  const maximum = Math.max(
    1,
    ...series.flatMap((entry) => entry.points.map((point) => point.value)),
  );
  const count = Math.max(...series.map((entry) => entry.points.length));
  const groupWidth = 540 / Math.max(1, count);
  return (
    <div className={`${styles.chart} bea-workspace-chart`} data-workspace-content="chart">
      <svg viewBox="0 0 640 280" role="img" aria-label={`${artifact.title} bar chart`}>
        <line x1="48" y1="238" x2="604" y2="238" stroke="#71959d" opacity="0.45" />
        {Array.from({ length: count }, (_, pointIndex) => {
          let stackY = 238;
          return series.map((entry, seriesIndex) => {
            const point = entry.points[pointIndex];
            if (!point) return null;
            const height = Math.max(
              1,
              (Math.max(0, point.value) / maximum) * (stacked ? 184 / series.length : 184),
            );
            const width = stacked
              ? Math.min(48, groupWidth * 0.62)
              : Math.min(38, (groupWidth * 0.7) / series.length);
            const x =
              54 + pointIndex * groupWidth + (stacked ? groupWidth * 0.18 : seriesIndex * width);
            const y = stacked ? stackY - height : 238 - height;
            if (stacked) stackY = y;
            return (
              <rect
                fill={CHART_COLORS[seriesIndex % CHART_COLORS.length]}
                height={height}
                key={`${entry.label}-${pointIndex}`}
                rx="4"
                width={width}
                x={x}
                y={y}
              >
                <title>{`${point.label}: ${point.value}`}</title>
              </rect>
            );
          });
        })}
      </svg>
      <ChartLegend series={series} />
    </div>
  );
}

function DonutChart({ artifact }: WorkspaceRendererProps) {
  const points =
    numericSeries(payloadRecord(artifact))[0]?.points.filter((point) => point.value > 0) ?? [];
  const total = points.reduce((sum, point) => sum + point.value, 0);
  if (total <= 0) return <p>No positive values are available for this donut chart.</p>;
  const circumference = Math.PI * 2 * 78;
  const segmentLengths = points.map((point) => (point.value / total) * circumference);
  const legendSeries = points.map((point) => ({ label: point.label, points: [point] }));
  return (
    <div className={`${styles.chart} bea-workspace-chart`} data-workspace-content="chart">
      <svg viewBox="0 0 640 280" role="img" aria-label={`${artifact.title} donut chart`}>
        <g transform="rotate(-90 320 140)">
          {points.map((point, index) => {
            const length = segmentLengths[index] ?? 0;
            const dashOffset = -segmentLengths
              .slice(0, index)
              .reduce((sum, segmentLength) => sum + segmentLength, 0);
            return (
              <circle
                cx="320"
                cy="140"
                fill="none"
                key={`${point.label}-${index}`}
                r="78"
                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={dashOffset}
                strokeWidth="36"
              >
                <title>{`${point.label}: ${point.value}`}</title>
              </circle>
            );
          })}
        </g>
        <text x="320" y="147" fill="#edf8f7" fontSize="24" textAnchor="middle">
          {displayValue(total)}
        </text>
      </svg>
      <ChartLegend series={legendSeries} />
    </div>
  );
}

function TimelineChart({ artifact }: WorkspaceRendererProps) {
  const payload = payloadRecord(artifact);
  const items = recordList(payload.items ?? payload.events ?? payload.data, 64);
  if (items.length === 0) return <p>No timeline entries are available.</p>;
  return (
    <ol className={`${styles.timeline} bea-workspace-activity`} data-workspace-content="activity">
      {items.map((item, index) => (
        <li key={textValue(item.id, `timeline-${index}`)}>
          <time dateTime={textValue(item.at ?? item.date ?? item.timestamp)}>
            {displayValue(
              item.dateLabel ?? item.at ?? item.date ?? item.timestamp ?? `Step ${index + 1}`,
            )}
          </time>
          <strong>{displayValue(item.label ?? item.title ?? item.name)}</strong>
          {(item.description ?? item.detail) ? (
            <small>{displayValue(item.description ?? item.detail)}</small>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function MetricChart({ artifact }: WorkspaceRendererProps) {
  const payload = payloadRecord(artifact);
  const items = applicationItems(payload);
  const metrics = items.length > 0 ? items : [payload];
  return (
    <div className={`${styles.metricGrid} bea-workspace-metrics`} data-workspace-content="metrics">
      {metrics.slice(0, 24).map((metric, index) => (
        <article className={styles.metricCard} key={textValue(metric.id, `metric-${index}`)}>
          <span>{displayValue(metric.label ?? metric.title ?? metric.name ?? "Metric")}</span>
          <strong>{displayValue(metric.value ?? metric.total ?? metric.amount)}</strong>
          {(metric.delta ?? metric.detail) ? (
            <small>{displayValue(metric.delta ?? metric.detail)}</small>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function PdfPreview({ artifact }: WorkspaceRendererProps) {
  const payload = payloadRecord(artifact);
  const src = safeHref(payload.src ?? payload.href ?? payload.url);
  if (!src) {
    return (
      <Alert tone="danger" title="PDF preview blocked">
        The artifact does not contain an authorized application URL.
      </Alert>
    );
  }
  const downloadHref = safeHref(payload.downloadHref);
  return (
    <ApplicationPdfViewer
      src={src.split("#", 1)[0] ?? src}
      title={textValue(payload.title, `${artifact.title} preview`)}
      downloadHref={downloadHref}
    />
  );
}

function ImagePreview({ artifact }: WorkspaceRendererProps) {
  const payload = payloadRecord(artifact);
  const src = safeHref(payload.src ?? payload.href ?? payload.url);
  if (!src) {
    return (
      <Alert tone="danger" title="Image preview blocked">
        The artifact does not contain an authorized application URL.
      </Alert>
    );
  }
  return (
    <figure
      className={`${styles.mediaPreview} bea-workspace-document`}
      data-workspace-content="image"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- artifacts use authorized app URLs */}
      <img alt={textValue(payload.alt, artifact.title)} src={src} />
    </figure>
  );
}

function FileArtifact(props: WorkspaceRendererProps) {
  const { artifact } = props;
  const payload = payloadRecord(artifact);
  const href = safeHref(payload.downloadHref ?? payload.href ?? payload.url);
  const hasLongFormContent =
    paragraphList(payload.body ?? payload.text ?? payload.content).length > 0 ||
    recordList(payload.sections, 40).length > 0;
  const fileCard = (
    <div className={`${styles.fileCard} bea-workspace-file`} data-workspace-content="file">
      <div>
        <strong>{displayValue(payload.name ?? payload.filename ?? artifact.title)}</strong>
        {(payload.size ?? payload.mediaType) ? (
          <p>{displayValue(payload.size ?? payload.mediaType)}</p>
        ) : null}
      </div>
      {href ? (
        <a className="bea-link" href={href} download={payload.download === true ? "" : undefined}>
          Download file
        </a>
      ) : (
        <span>Download unavailable</span>
      )}
    </div>
  );
  if (hasLongFormContent) {
    return (
      <div className="bea-workspace-document-flow" data-workspace-content="document">
        <LongFormDocument {...props} kindOverride="document" />
        {fileCard}
      </div>
    );
  }
  return fileCard;
}

function ProgressArtifact({ artifact }: WorkspaceRendererProps) {
  const payload = payloadRecord(artifact);
  const progress = Math.min(
    100,
    Math.max(0, numberValue(payload.progress ?? payload.percent) ?? 0),
  );
  const status = textValue(payload.status, progress >= 100 ? "complete" : "in progress");
  const tone = status === "failed" || status === "failure" ? "danger" : "info";
  return (
    <div className="bea-workspace-progress" data-workspace-content="progress">
      <Alert tone={tone} title={textValue(payload.label ?? payload.title, "Artifact progress")}>
        {displayValue(payload.message ?? status)}
      </Alert>
      <div
        aria-label={`${progress}% complete`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progress}
        className={styles.progressTrack}
        role="progressbar"
      >
        <span style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

const storedArtifactIdPattern = /^art_[a-f0-9]{32}$/u;

function normalizedFile(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const id = textValue(value.id);
  const filename = textValue(value.filename);
  const mimeType = textValue(value.mimeType);
  const size = numberValue(value.size);
  if (!storedArtifactIdPattern.test(id) || !filename || !mimeType || size === null || size < 0) {
    return null;
  }
  return { ...value, filename, id, mimeType, size };
}

function artifactFileHref(file: Record<string, unknown>, action: "download" | "preview"): string {
  return `/api/artifacts/${encodeURIComponent(String(file.id))}/${action}`;
}

function withPayload(
  props: WorkspaceRendererProps,
  payload: Record<string, unknown>,
): WorkspaceRendererProps {
  return {
    ...props,
    artifact: {
      ...props.artifact,
      payload: payload as AiCommandArtifactView["payload"],
    },
  };
}

function ExecutiveDocumentChrome({ artifact }: WorkspaceRendererProps) {
  const payload = payloadRecord(artifact);
  const document = isRecord(payload.executiveDocument) ? payload.executiveDocument : null;
  if (!document) return null;
  const versions = recordList(document.versions, 20);
  const relatedLeadPath = safeHref(document.relatedLeadPath);
  return (
    <aside className={styles.fileCard} data-testid="executive-pdf-chrome">
      <p data-testid="executive-pdf-review-status">
        {displayValue(document.reviewLabel ?? "DRAFT — HUMAN REVIEW REQUIRED")}
      </p>
      <p data-testid="executive-pdf-version">
        Version {displayValue(document.version)}
        {document.parentVersion ? ` · parent v${displayValue(document.parentVersion)}` : ""}
      </p>
      {relatedLeadPath ? (
        <p>
          <a className="bea-link" href={relatedLeadPath} data-testid="executive-pdf-open-lead">
            Open related lead
          </a>
        </p>
      ) : null}
      {versions.length > 0 ? (
        <ol data-testid="executive-pdf-version-history">
          {versions.map((version, index) => (
            <li key={textValue(version.id, `version-${index}`)}>
              v{displayValue(version.version)} · {displayValue(version.title)}
            </li>
          ))}
        </ol>
      ) : null}
    </aside>
  );
}

function NormalizedPdf(props: WorkspaceRendererProps) {
  const payload = payloadRecord(props.artifact);
  const file = normalizedFile(payload.file);
  if (!file || file.mimeType !== "application/pdf") {
    return (
      <Alert tone="danger" title="PDF preview blocked">
        The normalized PDF file reference is invalid or is not a PDF.
      </Alert>
    );
  }
  return (
    <>
      <ExecutiveDocumentChrome {...props} />
      <PdfPreview
        {...withPayload(props, {
          createdAt: payload.createdAt,
          downloadHref: artifactFileHref(file, "download"),
          filename: file.filename,
          size: file.size,
          src: artifactFileHref(file, "preview"),
          title: payload.title,
        })}
      />
    </>
  );
}

function NormalizedImage(props: WorkspaceRendererProps) {
  const payload = payloadRecord(props.artifact);
  const file = normalizedFile(payload.file);
  if (!file || !String(file.mimeType).startsWith("image/")) {
    return (
      <Alert tone="danger" title="Image preview blocked">
        The normalized image file reference is invalid or is not an image.
      </Alert>
    );
  }
  return (
    <ImagePreview
      {...withPayload(props, {
        alt: payload.altText,
        src: artifactFileHref(file, "preview"),
      })}
    />
  );
}

function NormalizedData(props: WorkspaceRendererProps) {
  const payload = payloadRecord(props.artifact);
  const data = isRecord(payload.data) ? payload.data : {};
  const file = normalizedFile(data.file);
  if (!file) {
    return (
      <Alert tone="danger" title="Data artifact unavailable">
        The normalized data file reference is invalid.
      </Alert>
    );
  }
  return (
    <FileArtifact
      {...withPayload(props, {
        download: true,
        downloadHref: artifactFileHref(file, "download"),
        filename: file.filename,
        mediaType: file.mimeType,
        name: file.filename,
        recordCount: data.recordCount,
        size: file.size,
      })}
    />
  );
}

function NormalizedMetric(props: WorkspaceRendererProps) {
  const payload = payloadRecord(props.artifact);
  const metric = isRecord(payload.metric) ? payload.metric : {};
  const suffix = textValue(metric.unit);
  return (
    <MetricChart
      {...withPayload(props, {
        items: [
          {
            delta: metric.trend,
            label: metric.label,
            value:
              suffix && metric.value !== undefined
                ? `${displayValue(metric.value)} ${suffix}`
                : metric.value,
          },
        ],
      })}
    />
  );
}

function NormalizedChart(props: WorkspaceRendererProps) {
  const payload = payloadRecord(props.artifact);
  const chart = isRecord(payload.chart) ? payload.chart : {};
  const type = textValue(chart.type);
  const series = recordList(chart.series, 64);
  const adapted = withPayload(props, { data: series, events: series, items: series, series });
  const provenance = isRecord(chart.provenance) ? chart.provenance : {};
  const status = textValue(provenance.dataStatus);
  const content = (() => {
    if (type === "line") return <LineAreaScatterChart {...adapted} kind="line" />;
    if (type === "bar") return <BarChart {...adapted} stacked={false} />;
    if (type === "stacked_bar") return <BarChart {...adapted} stacked />;
    if (type === "area") return <LineAreaScatterChart {...adapted} kind="area" />;
    if (type === "pie_or_donut") return <DonutChart {...adapted} />;
    if (type === "scatter") return <LineAreaScatterChart {...adapted} kind="scatter" />;
    if (type === "timeline") return <TimelineChart {...adapted} />;
    if (type === "single_metric") return <MetricChart {...adapted} />;
    if (type === "comparison") return <Comparison {...adapted} />;
    return (
      <Alert tone="danger" title="Unsupported chart type">
        The normalized chart type is not allowlisted.
      </Alert>
    );
  })();
  return (
    <section className="bea-workspace-chart-composition" data-workspace-content="chart">
      {status === "partial" ? (
        <Alert tone="warning" title="Partial chart data">
          This chart contains verified partial data.
        </Alert>
      ) : null}
      {content}
      {provenance.calculationNotes ? (
        <p className={styles.analysis}>{displayValue(provenance.calculationNotes)}</p>
      ) : null}
    </section>
  );
}

function NormalizedError({ artifact }: WorkspaceRendererProps) {
  const payload = payloadRecord(artifact);
  const error = isRecord(payload.error) ? payload.error : {};
  return (
    <Alert tone="danger" title="Artifact generation failed">
      {displayValue(error.message ?? "The normalized artifact reports a failure.")}
    </Alert>
  );
}

export const normalizedArtifactRendererRegistry: Readonly<
  Record<NormalizedArtifactRendererName, Renderer>
> = {
  pdf: NormalizedPdf,
  image: NormalizedImage,
  chart: NormalizedChart,
  table: ApplicationTable,
  data: NormalizedData,
  research: ResearchBoard,
  "source-board": ResearchBoard,
  metric: NormalizedMetric,
  timeline: TimelineChart,
  comparison: (props) => {
    const payload = payloadRecord(props.artifact);
    return <ApplicationTable {...withPayload(props, { table: payload.comparison })} />;
  },
  analysis: Analysis,
  error: NormalizedError,
};

function RendererState({ artifact }: WorkspaceRendererProps) {
  const payload = payloadRecord(artifact);
  const status = textValue(payload.status).toLowerCase();
  if (["failed", "failure", "error"].includes(status)) {
    return (
      <Alert tone="danger" title="Artifact generation failed">
        {displayValue(payload.message ?? "The artifact could not be completed.")}
      </Alert>
    );
  }
  if (status === "partial") {
    return (
      <Alert tone="warning" title="Partial artifact">
        {displayValue(payload.message ?? "Verified partial results are shown below.")}
      </Alert>
    );
  }
  return null;
}

interface WorkspaceSourceRow {
  readonly detail: string;
  readonly domain: string;
  readonly href: string | null;
  readonly key: string;
  readonly label: string;
  readonly timestamp: string;
}

function workspaceSourceRow(
  source: Record<string, unknown>,
  index: number,
  allowExternalHref: boolean,
): WorkspaceSourceRow {
  const label = textValue(
    source.title ?? source.label ?? source.name ?? source.domain,
    `Source ${index + 1}`,
  );
  const href = allowExternalHref
    ? safeExternalHref(source.href ?? source.url)
    : safeHref(source.href ?? source.url);
  const identity = textValue(source.id, href ?? `${label.toLocaleLowerCase()}-${index}`);
  return {
    detail: textValue(source.summary ?? source.description),
    domain: textValue(source.domain),
    href,
    key: href ?? identity,
    label,
    timestamp: textValue(source.publishedAt ?? source.timestamp ?? source.accessedAt),
  };
}

function workspaceSourceRows(
  artifact: AiCommandArtifactView,
  includePayloadSources: boolean,
): WorkspaceSourceRow[] {
  const payload = payloadRecord(artifact);
  const rows = [
    ...artifact.sources.map((source, index) =>
      workspaceSourceRow(source as unknown as Record<string, unknown>, index, false),
    ),
    ...recordList(payload.citations, 64).map((source, index) =>
      workspaceSourceRow(source, index, true),
    ),
    ...recordList(payload.sources, 64).map((source, index) =>
      workspaceSourceRow(source, index, true),
    ),
    ...(includePayloadSources
      ? applicationItems(payload).map((source, index) => workspaceSourceRow(source, index, true))
      : []),
  ];
  const unique = new Map<string, WorkspaceSourceRow>();
  for (const row of rows) {
    const existing = unique.get(row.key);
    if (!existing) {
      unique.set(row.key, row);
      continue;
    }
    unique.set(row.key, {
      detail: existing.detail || row.detail,
      domain: existing.domain || row.domain,
      href: existing.href ?? row.href,
      key: existing.key,
      label: existing.label || row.label,
      timestamp: existing.timestamp || row.timestamp,
    });
  }
  return [...unique.values()];
}

function ArtifactProvenance({
  artifact,
  includePayloadSources = false,
  excludedHrefs = new Set<string>(),
}: WorkspaceRendererProps & {
  readonly excludedHrefs?: ReadonlySet<string>;
  readonly includePayloadSources?: boolean;
}) {
  const payload = payloadRecord(artifact);
  const downloads = recordList(payload.downloads ?? payload.files, 24);
  const sources = workspaceSourceRows(artifact, includePayloadSources).filter(
    (source) => !source.href || !excludedHrefs.has(source.href),
  );
  const links = artifact.links.flatMap((link) => {
    const href = safeHref(link.href);
    return href && !excludedHrefs.has(href) ? [{ href, label: link.label }] : [];
  });
  const safeDownloads = downloads.flatMap((download, index) => {
    const href = safeHref(download.href ?? download.url);
    return href
      ? [
          {
            href,
            key: textValue(download.id, `download-${index}`),
            label: textValue(download.label ?? download.name, `Download ${index + 1}`),
          },
        ]
      : [];
  });
  if (sources.length === 0 && links.length === 0 && safeDownloads.length === 0) return null;
  return (
    <aside
      className={`bea-ai-sources ${styles.provenance} bea-workspace-provenance`}
      aria-label="Artifact sources"
      data-workspace-provenance="single"
      data-brand-policy-version={ARTIFACT_BRAND_POLICY_VERSION}
      data-template-version={ARTIFACT_TEMPLATE_VERSION}
    >
      <span
        className="bea-visually-hidden"
        data-testid="bea-artifact-brand-frame"
        data-brand-provenance="bea-artifact"
      >
        BEA branded artifact
      </span>
      {sources.length > 0 ? (
        <>
          <h3>Sources and citations</h3>
          <ul className="bea-workspace-source-list">
            {sources.map((source) => (
              <li className="bea-workspace-source-row" key={source.key}>
                <div>
                  {source.href ? (
                    <a
                      href={source.href}
                      rel={source.href.startsWith("/") ? undefined : "noopener noreferrer"}
                      target={source.href.startsWith("/") ? undefined : "_blank"}
                    >
                      {source.label}
                    </a>
                  ) : (
                    <span>{source.label}</span>
                  )}
                  {source.domain ? <small>{source.domain}</small> : null}
                </div>
                {source.detail ? <p>{source.detail}</p> : null}
                {source.timestamp ? (
                  <time dateTime={source.timestamp}>{source.timestamp}</time>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div className={styles.artifactActions}>
        {links.map((link) => (
          <a href={link.href} key={`${link.label}:${link.href}`}>
            {link.label}
          </a>
        ))}
        {safeDownloads.map((download) => (
          <a href={download.href} key={download.key} download>
            {download.label}
          </a>
        ))}
      </div>
    </aside>
  );
}

function UnsupportedApplicationRenderer({ artifact }: WorkspaceRendererProps) {
  return (
    <Alert tone="danger" title="Unsupported artifact renderer">
      {`The requested renderer “${textValue(payloadRecord(artifact).renderer, "unknown")}” is not allowlisted.`}
    </Alert>
  );
}

export const applicationRendererRegistry: Readonly<Record<ApplicationRendererName, Renderer>> = {
  "research-board": ResearchBoard,
  "source-board": ResearchBoard,
  document: (props) => <LongFormDocument {...props} kindOverride="document" />,
  email: (props) => <LongFormDocument {...props} kindOverride="email" />,
  report: (props) => <LongFormDocument {...props} kindOverride="report" />,
  "line-chart": (props) => <LineAreaScatterChart {...props} kind="line" />,
  "bar-chart": (props) => <BarChart {...props} stacked={false} />,
  "stacked-bar-chart": (props) => <BarChart {...props} stacked />,
  "area-chart": (props) => <LineAreaScatterChart {...props} kind="area" />,
  "donut-chart": DonutChart,
  "scatter-chart": (props) => <LineAreaScatterChart {...props} kind="scatter" />,
  "timeline-chart": TimelineChart,
  "metric-chart": MetricChart,
  "comparison-chart": Comparison,
  table: ApplicationTable,
  comparison: Comparison,
  analysis: Analysis,
  "pdf-preview": PdfPreview,
  image: ImagePreview,
  file: FileArtifact,
  progress: ProgressArtifact,
};

function WorkforceTrace(props: WorkspaceRendererProps) {
  const payload = isRecord(props.artifact.payload) ? props.artifact.payload : {};
  return (
    <DigitalWorkforceRunTrace
      run={isRecord(payload.run) ? (payload.run as never) : null}
      steps={Array.isArray(payload.steps) ? (payload.steps as never) : []}
      handoffs={Array.isArray(payload.handoffs) ? (payload.handoffs as never) : []}
      events={Array.isArray(payload.events) ? (payload.events as never) : []}
    />
  );
}

export const workspaceRendererRegistry: Readonly<Record<AiCommandArtifactView["type"], Renderer>> =
  {
    "command-center-summary": Summary,
    "search-results": GenericRecords,
    "company-list": GenericRecords,
    "company-detail": Detail,
    "contact-list": GenericRecords,
    "contact-detail": Detail,
    "task-list": GenericRecords,
    "task-detail": Detail,
    "lead-list": GenericRecords,
    "lead-detail": Detail,
    "activity-timeline": ActivityRecords,
    "notification-list": GenericRecords,
    "integration-health-summary": GenericRecords,
    "integration-detail": Detail,
    "workflow-run-list": GenericRecords,
    "workflow-run-detail": Detail,
    "audit-summary": GenericRecords,
    "action-preview": ActionPreview,
    "action-result": ActionResult,
    help: Help,
    empty: EmptyWorkspace,
    error: Failure,
    "digital-workforce-organization": GenericRecords,
    "digital-workforce-department": Detail,
    "digital-workforce-team": Detail,
    "digital-workforce-agent-list": GenericRecords,
    "digital-workforce-agent-detail": Detail,
    "digital-workforce-agent-draft": Detail,
    "digital-workforce-run-list": GenericRecords,
    "digital-workforce-run-trace": WorkforceTrace,
    "digital-workforce-handoff-list": GenericRecords,
    "digital-workforce-handoff-detail": Detail,
    "digital-workforce-approval": ActionPreview,
    "digital-workforce-error": Failure,
    "digital-workforce-artifacts": GenericRecords,
  };

type WorkspaceLayout =
  "action" | "activity" | "chart" | "document" | "empty" | "generic" | "record" | "research";

function workspaceLayout(
  artifactType: AiCommandArtifactView["type"],
  normalizedRenderer: NormalizedArtifactRendererName | null,
  applicationRenderer: ApplicationRendererName | null,
): WorkspaceLayout {
  if (
    normalizedRenderer === "research" ||
    normalizedRenderer === "source-board" ||
    applicationRenderer === "research-board" ||
    applicationRenderer === "source-board"
  ) {
    return "research";
  }
  if (
    normalizedRenderer === "chart" ||
    normalizedRenderer === "metric" ||
    applicationRenderer === "line-chart" ||
    applicationRenderer === "bar-chart" ||
    applicationRenderer === "stacked-bar-chart" ||
    applicationRenderer === "area-chart" ||
    applicationRenderer === "donut-chart" ||
    applicationRenderer === "scatter-chart" ||
    applicationRenderer === "metric-chart" ||
    applicationRenderer === "comparison-chart"
  ) {
    return "chart";
  }
  if (normalizedRenderer === "timeline" || applicationRenderer === "timeline-chart") {
    return "activity";
  }
  if (
    normalizedRenderer === "pdf" ||
    normalizedRenderer === "image" ||
    normalizedRenderer === "data" ||
    applicationRenderer === "pdf-preview" ||
    applicationRenderer === "image" ||
    applicationRenderer === "file" ||
    applicationRenderer === "document" ||
    applicationRenderer === "email" ||
    applicationRenderer === "report" ||
    normalizedRenderer === "analysis" ||
    applicationRenderer === "analysis"
  ) {
    return "document";
  }
  if (artifactType === "activity-timeline") return "activity";
  if (artifactType === "action-preview" || artifactType === "action-result") return "action";
  if (artifactType === "empty" || artifactType === "help") return "empty";
  if (
    artifactType === "command-center-summary" ||
    artifactType === "search-results" ||
    artifactType.endsWith("-list") ||
    artifactType.endsWith("-detail") ||
    artifactType === "audit-summary"
  ) {
    return "record";
  }
  return "generic";
}

export function WorkspaceRenderer(props: WorkspaceRendererProps) {
  const payload = payloadRecord(props.artifact);
  const requestedRenderer = textValue(payload.renderer);
  const normalizedRenderer =
    payload.schemaVersion === 1 && isNormalizedArtifactRendererName(requestedRenderer)
      ? requestedRenderer
      : null;
  const applicationRenderer = isApplicationRendererName(requestedRenderer)
    ? requestedRenderer
    : null;
  const layout = workspaceLayout(props.artifact.type, normalizedRenderer, applicationRenderer);
  const headerAlreadyDisclosesSyntheticState = /demo|simulat|synthetic/iu.test(
    props.artifact.subtitle ?? "",
  );
  const compactDisclosure = headerAlreadyDisclosesSyntheticState ? null : payload.disclosure;
  const RendererComponent = normalizedRenderer
    ? normalizedArtifactRendererRegistry[normalizedRenderer]
    : requestedRenderer
      ? applicationRenderer
        ? applicationRendererRegistry[applicationRenderer]
        : UnsupportedApplicationRenderer
      : (workspaceRendererRegistry[props.artifact.type] ?? Failure);
  const content =
    props.artifact.state === "loading" ? (
      <p role="status">Loading authorized workspace data…</p>
    ) : props.artifact.state === "failed" ? (
      <Failure {...props} />
    ) : (
      <RendererComponent {...props} />
    );
  const primaryRecordHrefs =
    layout === "record" || layout === "activity"
      ? new Set(
          applicationItems(payload).flatMap((item) => {
            const href = safeHref(item.href ?? item.url);
            return href ? [href] : [];
          }),
        )
      : new Set<string>();
  return (
    <section
      className={`bea-ai-artifact ${styles.artifactShell} bea-workspace-artifact${
        props.artifact.type === "action-preview" ? " bea-floating-surface" : ""
      }`}
      data-testid={`workspace-artifact-${props.artifact.type}`}
      data-workspace-layout={layout}
      data-workspace-region="body"
      data-workspace-surface="continuous"
      data-brand-policy-version={ARTIFACT_BRAND_POLICY_VERSION}
      data-template-version={ARTIFACT_TEMPLATE_VERSION}
    >
      {props.titleRenderedByParent ? null : (
        <h2 className="bea-card__title bea-visually-hidden">{props.artifact.title}</h2>
      )}
      <div
        className={`${styles.artifactContent} bea-workspace-artifact-body`}
        data-workspace-artifact-body="single"
      >
        <div
          className="bea-workspace-renderer"
          data-testid="workspace-artifact-renderer"
          data-renderer={
            normalizedRenderer ??
            applicationRenderer ??
            (requestedRenderer ? "unsupported" : props.artifact.type)
          }
          data-artifact-state={props.artifact.state}
          data-pdf-processing={
            props.artifact.state === "loading" && normalizedRenderer === "pdf" ? "true" : undefined
          }
        >
          <RendererState {...props} />
          {normalizedRenderer && (compactDisclosure || payload.summary) ? (
            <div
              className="bea-workspace-disclosure"
              data-workspace-disclosure="compact"
              role="note"
            >
              {compactDisclosure ? <strong>{displayValue(compactDisclosure)}</strong> : null}
              {payload.summary ? <p>{displayValue(payload.summary)}</p> : null}
            </div>
          ) : null}
          {content}
        </div>
        <ArtifactProvenance
          {...props}
          excludedHrefs={primaryRecordHrefs}
          includePayloadSources={layout === "research"}
        />
      </div>
    </section>
  );
}
