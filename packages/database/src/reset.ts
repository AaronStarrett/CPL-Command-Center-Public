import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import { seedDatabaseOnExecutor, type SeedSummary } from "./seed.js";

export const DEMO_RESET_CONFIRMATION = "RESET_BEA_DEMO_DATA";

export interface DemoResetContext {
  readonly appMode: "demo" | "production";
  readonly nodeEnv: "development" | "test" | "production";
  readonly confirmation: string;
}

export class DemoResetRefusedError extends Error {
  readonly code = "DEMO_RESET_REFUSED";

  constructor(reason: string) {
    super(`Demo reset refused: ${reason}`);
    this.name = "DemoResetRefusedError";
  }
}

export function assertDemoResetAllowed(context: DemoResetContext): void {
  if (context.appMode !== "demo") {
    throw new DemoResetRefusedError("APP_MODE is not demo");
  }
  if (context.nodeEnv !== "test" || process.env.NODE_ENV !== "test") {
    throw new DemoResetRefusedError("reset requires an isolated NODE_ENV=test harness");
  }
  if (context.confirmation !== DEMO_RESET_CONFIRMATION) {
    throw new DemoResetRefusedError("the explicit confirmation token is missing");
  }
}

export async function resetDemoDatabase(
  database: DatabaseAdapter,
  context: DemoResetContext,
  seedOnExecutor: (executor: SqlExecutor) => Promise<SeedSummary> = seedDatabaseOnExecutor,
): Promise<SeedSummary> {
  assertDemoResetAllowed(context);
  return database.transaction(async (transaction) => {
    await transaction.execute(`
      TRUNCATE TABLE
        notification_outbox,
        work_item_reminders,
        work_item_escalations,
        work_item_events,
        work_item_assignments,
        event_projection_receipts,
        event_projection_failures,
        scheduled_automation_actions,
        reconciliation_runs,
        operational_work_items,
        work_routing_blueprints,
        orchestration_policy_versions,
        proposal_status_events,
        proposal_delivery_manifests,
        proposal_pricing_overrides,
        proposal_reviews,
        proposal_line_items,
        proposal_versions,
        proposals,
        commercial_policy_versions,
        service_catalog_items,
        service_catalog_versions,
        service_catalogs,
        ingestion_staging_runs,
        configuration_validation_runs,
        configuration_artifacts,
        configuration_readiness_items,
        configuration_intake_items,
        configuration_releases,
        sla_stage_intervals,
        report_review_comments,
        report_deliveries,
        delivery_authorizations,
        exception_cases,
        report_versions,
        inspection_validation_results,
        inspection_evidence,
        inspection_findings,
        inspection_submissions,
        inspection_assignments,
        sla_clocks,
        inspection_reports,
        inspections,
        projects,
        report_template_versions,
        report_templates,
        automation_jobs,
        automation_events,
        automation_blueprints,
        connector_readiness,
        guided_demo_decisions,
        guided_demo_events,
        guided_demo_stage_states,
        guided_demo_runs,
        external_object_links,
        digital_workforce_run_events,
        digital_workforce_handoffs,
        digital_workforce_run_steps,
        digital_workforce_runs,
        digital_workforce_agent_versions,
        digital_workforce_agents,
        digital_workforce_teams,
        digital_workforce_departments,
        action_executions,
        action_approvals,
        suggested_actions,
        workspace_artifacts,
        assistant_messages,
        conversations,
        notifications,
        activities,
        tasks,
        lead_status_events,
        lead_parties,
        leads,
        contacts,
        companies,
        workflow_step_runs,
        workflow_runs,
        sessions,
        role_permissions,
        user_roles,
        audit_logs,
        integration_connections,
        feature_flags,
        system_settings,
        permissions,
        roles,
        users
      CASCADE
    `);
    return seedOnExecutor(transaction);
  });
}
