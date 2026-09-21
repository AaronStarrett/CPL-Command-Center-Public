"use client";

import {
  GUIDED_DEMO_STAGES,
  GUIDED_DEMO_TRUTH_LABELS,
  SYNTHETIC_DEMONSTRATION_NOTICE,
} from "@bea/domain";

import { useGuidedDemo } from "@/components/guided-demo-runtime";
import styles from "@/components/phase34a.module.css";
import Link from "next/link";

const TEAM = [
  {
    role: "Owner",
    can: "Start and reset the demo, approve proposals, authorize demonstration delivery.",
    cannot: "Treat this as production delivery.",
  },
  {
    role: "Sales",
    can: "Prepare commercial records and add simulated authorization.",
    cannot: "Approve proposals, technically approve reports, or authorize delivery.",
  },
  {
    role: "Operations",
    can: "Perform authorized technical review.",
    cannot: "Approve proposal pricing or authorize final delivery.",
  },
  {
    role: "Integration Administrator",
    can: "View configuration readiness and safe automation health.",
    cannot: "Approve proposals or reports, or authorize delivery.",
  },
  {
    role: "Executive Read-only",
    can: "Watch the story and view safe summaries.",
    cannot: "Start, reset, approve, retry, or deliver.",
  },
] as const;

const CONFIG = [
  ["Synthetic Lead Demo", "Ready"],
  ["Synthetic Service Catalog", "Ready"],
  ["Synthetic Proposal Template", "Ready"],
  ["Synthetic Inspection Mapping", "Ready"],
  ["Synthetic Report", "Ready"],
  ["Production Service Catalog", "Unconfigured"],
  ["Production Pricing", "Unconfigured"],
  ["Production Report Template", "Unconfigured"],
  ["BEA SLA Policy", "Unconfigured"],
] as const;

const INTEGRATIONS = [
  ["Outlook", "Not connected"],
  ["SharePoint", "Not connected"],
  ["Teams", "Not connected"],
  ["Calendar", "Not connected"],
  ["E-signature", "Not connected"],
  ["Accounting", "Not connected"],
  ["AI Provider", "Not required for this demonstration"],
] as const;

export function CompanyDetailsExperience() {
  const { envelope } = useGuidedDemo();
  return (
    <div className={styles.companyPage} data-page="company-details">
      <p className={styles.notice}>{SYNTHETIC_DEMONSTRATION_NOTICE}</p>
      <p className={styles.eyebrow}>Company Details</p>
      <h1>Cyber Pirate Labs</h1>
      <p>
        Operating purpose: inspect, document, and deliver building-envelope findings through a
        governed automation path. Demonstration status: {envelope?.snapshot.status ?? "not loaded"}.
      </p>
      <span className={styles.badge}>Synthetic environment</span>

      <section>
        <h2>Team & responsibilities</h2>
        {TEAM.map((member) => (
          <article key={member.role} className={styles.roleCard}>
            <h3>{member.role}</h3>
            <p>May: {member.can}</p>
            <p>May not: {member.cannot}</p>
          </article>
        ))}
      </section>

      <section data-testid="automation-coverage">
        <h2>Automation coverage</h2>
        <ul className={styles.coverageList}>
          {GUIDED_DEMO_STAGES.map((stage) => (
            <li key={stage.key}>
              <strong>{stage.title}</strong>
              <span>{GUIDED_DEMO_TRUTH_LABELS[stage.backingType]}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Configuration readiness</h2>
        <ul>
          {CONFIG.map(([label, status]) => (
            <li key={label}>
              {label}: {status}
            </li>
          ))}
        </ul>
      </section>

      <section data-testid="integration-readiness">
        <h2>Integration readiness</h2>
        <ul>
          {INTEGRATIONS.map(([label, status]) => (
            <li key={label}>
              {label}: {status}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>System truth</h2>
        <ul>
          <li>Demo mode</li>
          <li>No real client data</li>
          <li>No live message delivery</li>
          <li>No production activation</li>
          <li>Scenario version phase34a-v1</li>
        </ul>
      </section>

      <section>
        <h2>Deep links</h2>
        <ul className={styles.deepLinks}>
          <li>
            <Link href="/configuration">Configuration Studio</Link>
          </li>
          <li>
            <Link href="/integrations">Integrations</Link>
          </li>
          <li>
            <Link href="/work">Work queues</Link>
          </li>
          <li>
            <Link href="/leads">Leads</Link>
          </li>
          <li>
            <Link href="/proposals">Proposals</Link>
          </li>
          <li>
            <Link href="/projects">Projects</Link>
          </li>
          <li>
            <Link href="/inspections">Inspections</Link>
          </li>
          <li>
            <Link href="/reports">Reports</Link>
          </li>
          <li>
            <Link href="/audit">Audit</Link>
          </li>
        </ul>
      </section>
    </div>
  );
}
