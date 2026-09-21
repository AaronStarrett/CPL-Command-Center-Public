"use client";

import { GUIDED_DEMO_SIMULATED_COMMAND_LABEL } from "@bea/domain";
import { Button } from "@bea/ui";
import Link from "next/link";

import { HumanDecisionCard, useGuidedDemo } from "@/components/guided-demo-runtime";
import { meridianReportSections } from "@/lib/guided-demo-presentation";
import styles from "@/components/phase34a.module.css";

export function MeridianReportWorkspace({ onClose }: { onClose: () => void }) {
  const { envelope, refresh } = useGuidedDemo();
  const report = envelope?.report;
  const workspace = report?.workspace ?? null;
  const workspaceError = report?.workspaceError ?? null;
  const snapshot = envelope?.snapshot;
  const sections = workspace
    ? meridianReportSections().filter(
        (section) => section.id !== "review-update" || Boolean(workspace.reviewUpdate),
      )
    : meridianReportSections();

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const sources = workspace?.sources ?? envelope?.command?.sources ?? [];

  return (
    <section
      className={styles.reportWorkspace}
      data-testid="report-workspace"
      aria-labelledby="report-workspace-title"
    >
      <header className={styles.reportHeader}>
        <div>
          <p className={styles.eyebrow}>{workspace?.projectName ?? "Meridian Commerce Center"}</p>
          <h2 id="report-workspace-title">{workspace?.title ?? "Building Envelope Assessment"}</h2>
          <p>
            {report?.reference ?? "Report pending"} · Version {report?.versionNumber ?? "—"} ·{" "}
            {report?.status ?? snapshot?.status}
          </p>
          {workspace ? <p data-testid="report-version-marker">{workspace.versionMarker}</p> : null}
          {workspace?.artifactChecksum ? (
            <p data-testid="report-artifact-identity">
              Artifact {workspace.artifactFilename ?? report?.reference} ·{" "}
              {workspace.artifactChecksum.slice(0, 12)}
            </p>
          ) : null}
        </div>
        <div className={styles.reportHeaderActions}>
          <span className={styles.badge}>Synthetic</span>
          {report ? (
            <a className={styles.link} href={`/reports/${encodeURIComponent(report.id)}`}>
              Open full record
            </a>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>
      <p className={styles.simulated}>{GUIDED_DEMO_SIMULATED_COMMAND_LABEL}</p>
      {workspace ? (
        <>
          <nav className={styles.sourceChips} aria-label="Report sources">
            {sources.map((source) => (
              <button
                key={source.key}
                type="button"
                className={styles.chip}
                data-testid={`source-chip-${source.key}`}
                data-record-id={source.recordId ?? ""}
                onClick={() => {
                  if (source.href && !source.sectionId) window.location.assign(source.href);
                  else if (source.sectionId) scrollTo(source.sectionId);
                  else if (source.href) window.location.assign(source.href);
                }}
              >
                {source.label}
              </button>
            ))}
          </nav>
          <div className={styles.reportScroll}>
            <nav className={styles.toc} aria-label="Report contents">
              {sections.map((section) => (
                <button key={section.id} type="button" onClick={() => scrollTo(section.id)}>
                  {section.title}
                </button>
              ))}
            </nav>
            <article className={styles.reportBody}>
              <section id="cover">
                <h3>Cover</h3>
                <p>
                  {workspace.projectName} · {workspace.clientName}
                </p>
                <p>
                  Prepared for {workspace.contactName}, {workspace.contactTitle}.
                </p>
              </section>
              <section id="synthetic-notice">
                <h3>Synthetic Demonstration Notice</h3>
                <p>{workspace.syntheticNotice}</p>
                <p>This wording is not Owner-approved production language.</p>
              </section>
              <section id="executive-summary">
                <h3>Executive Summary</h3>
                <p>{workspace.executiveSummary}</p>
                <p>Current stored status: {workspace.reportStatus}.</p>
              </section>
              <section id="property">
                <h3>Property and Inspection Details</h3>
                <p>{workspace.propertyDetails}</p>
                <p>
                  Inspection {workspace.inspectionReference}
                  {workspace.inspectionCompletedAt
                    ? ` completed ${workspace.inspectionCompletedAt}`
                    : ""}
                  .
                </p>
              </section>
              <section id="scope">
                <h3>Scope of Assessment</h3>
                <p>{workspace.scope}</p>
              </section>
              <section id="documents">
                <h3>Documents and Information Reviewed</h3>
                <ul>
                  {workspace.documentsReviewed.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
              <section id="observed">
                <h3>Observed Conditions</h3>
                <p>{workspace.observedConditions}</p>
              </section>
              <section id="findings" data-testid="report-findings">
                <h3>Findings</h3>
                {workspace.findings.map((finding) => (
                  <article
                    key={finding.id}
                    data-testid={`finding-${finding.code}`}
                    data-finding-id={finding.id}
                  >
                    <h4>
                      {finding.code}. {finding.title}
                    </h4>
                    <p>Priority: {finding.priority}</p>
                    <p>{finding.observation}</p>
                    <p>{finding.recommendation}</p>
                    {finding.evidenceIds.length > 0 ? (
                      <p>Linked evidence: {finding.evidenceIds.join(", ")}</p>
                    ) : null}
                  </article>
                ))}
              </section>
              <section id="photos">
                <h3>Photo Evidence</h3>
                <div className={styles.photoGrid} data-testid="synthetic-photo-grid">
                  {workspace.evidence.map((item) => (
                    <figure key={item.id} data-evidence-id={item.id}>
                      <div className={styles.photo} aria-hidden="true" />
                      <figcaption>{item.caption}. Synthetic only.</figcaption>
                    </figure>
                  ))}
                </div>
              </section>
              <section id="recommended">
                <h3>Recommended Actions</h3>
                <p>{workspace.recommendations}</p>
              </section>
              <section id="priorities">
                <h3>Repair Priorities</h3>
                {workspace.repairPriorities.map((item) => (
                  <p key={item.band}>
                    {item.band}: {item.text}
                  </p>
                ))}
              </section>
              <section id="limitations">
                <h3>Limitations</h3>
                <p>{workspace.limitations}</p>
              </section>
              {workspace.reviewUpdate ? (
                <section id="review-update" data-testid="report-review-update">
                  <h3>Review Update</h3>
                  <p>{workspace.reviewUpdate}</p>
                </section>
              ) : null}
              <section id="review-history" data-testid="report-review-history">
                <h3>Review History</h3>
                {workspace.reviewHistory.length === 0 ? (
                  <p>No stored review records yet for this Report version.</p>
                ) : (
                  workspace.reviewHistory.map((item) => (
                    <p key={`${item.versionId}-${item.reviewedAt ?? item.decision ?? "pending"}`}>
                      Version {item.versionNumber}
                      {item.historical ? " (historical)" : ""}
                      {item.decision ? ` · ${item.decision.replaceAll("_", " ")}` : " · pending"}
                      {item.comment ? ` · ${item.comment}` : ""}
                    </p>
                  ))
                )}
              </section>
              <section id="approval-status" data-testid="report-approval-status">
                <h3>Approval Status</h3>
                <p>{workspace.approvalStatus}</p>
              </section>
              <section id="delivery-status" data-testid="report-delivery-status">
                <h3>Delivery Status</h3>
                <p>{workspace.deliveryStatus}</p>
                {workspace.recipient ? <p>Recipient {workspace.recipient}.</p> : null}
              </section>
            </article>
          </div>
        </>
      ) : (
        <div className={styles.unavailable} data-testid="stored-report-unavailable">
          <h3>Stored Report content is unavailable for this demonstration run.</h3>
          <p>{workspaceError ?? "The Command Center will not display a static fallback Report."}</p>
          <div className={styles.reportHeaderActions}>
            <Button onClick={() => void refresh()}>Retry</Button>
            {report ? (
              <a className={styles.link} href={`/reports/${encodeURIComponent(report.id)}`}>
                Open full record
              </a>
            ) : null}
            <Link className={styles.link} href="/automation-flow">
              Return to Automation Flow
            </Link>
          </div>
        </div>
      )}
      {workspace ? <HumanDecisionCard /> : null}
    </section>
  );
}
