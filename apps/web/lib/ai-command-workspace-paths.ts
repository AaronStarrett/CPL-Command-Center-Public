export type AiCommandWorkspaceView =
  | "company-list"
  | "company-detail"
  | "contact-list"
  | "contact-detail"
  | "lead-list"
  | "lead-detail"
  | "task-list"
  | "task-detail"
  | "activities"
  | "notifications"
  | "workflow-runs"
  | "workflow-run-detail"
  | "integration-health"
  | "sources"
  | "digital-workforce-organization"
  | "digital-workforce-department"
  | "digital-workforce-team"
  | "digital-workforce-agent-list"
  | "digital-workforce-agent-detail"
  | "digital-workforce-run-list"
  | "digital-workforce-run-trace"
  | "digital-workforce-handoff-detail";

export interface ParsedAiCommandWorkspacePath {
  readonly path: string;
  readonly view: AiCommandWorkspaceView;
  readonly recordId: string | null;
  readonly parentPath: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const WORKSPACE_PATHS: Readonly<
  Record<
    string,
    {
      readonly view: AiCommandWorkspaceView;
      readonly detailView?: AiCommandWorkspaceView;
      readonly parentPath?: string;
    }
  >
> = Object.freeze({
  companies: { view: "company-list", detailView: "company-detail" },
  contacts: { view: "contact-list", detailView: "contact-detail" },
  leads: { view: "lead-list", detailView: "lead-detail" },
  tasks: { view: "task-list", detailView: "task-detail" },
  activities: { view: "activities" },
  notifications: { view: "notifications" },
  "workflow-runs": {
    view: "workflow-runs",
    detailView: "workflow-run-detail",
  },
  integrations: { view: "integration-health" },
  sources: { view: "sources" },
});

function normalizePathname(value: string): string {
  const trimmed = value.trim();
  const withoutOrigin = trimmed.replace(/^https?:\/\/[^/]+/iu, "");
  const pathname = withoutOrigin.split(/[?#]/u)[0] ?? "";
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return "";
  return pathname.replace(/\/+$/u, "") || "/";
}

export function isAiCommandWorkspacePath(value: string | null | undefined): boolean {
  return parseAiCommandWorkspacePath(value) !== null;
}

function parseDigitalWorkforcePath(
  segments: readonly string[],
): ParsedAiCommandWorkspacePath | null {
  if (segments[0] !== "digital-workforce") return null;
  if (segments.length === 1) {
    return {
      path: "/digital-workforce",
      view: "digital-workforce-organization",
      recordId: null,
      parentPath: null,
    };
  }
  const collection = segments[1];
  if (segments.length === 2) {
    if (collection === "agents") {
      return {
        path: "/digital-workforce/agents",
        view: "digital-workforce-agent-list",
        recordId: null,
        parentPath: "/digital-workforce",
      };
    }
    if (collection === "runs") {
      return {
        path: "/digital-workforce/runs",
        view: "digital-workforce-run-list",
        recordId: null,
        parentPath: "/digital-workforce",
      };
    }
    return null;
  }
  const recordId = segments[2];
  if (!recordId || !UUID_PATTERN.test(recordId) || segments.length !== 3) return null;
  if (collection === "agents") {
    return {
      path: `/digital-workforce/agents/${recordId}`,
      view: "digital-workforce-agent-detail",
      recordId,
      parentPath: "/digital-workforce/agents",
    };
  }
  if (collection === "runs") {
    return {
      path: `/digital-workforce/runs/${recordId}`,
      view: "digital-workforce-run-trace",
      recordId,
      parentPath: "/digital-workforce/runs",
    };
  }
  if (collection === "handoffs") {
    return {
      path: `/digital-workforce/handoffs/${recordId}`,
      view: "digital-workforce-handoff-detail",
      recordId,
      parentPath: "/digital-workforce/runs",
    };
  }
  if (collection === "departments") {
    return {
      path: `/digital-workforce/departments/${recordId}`,
      view: "digital-workforce-department",
      recordId,
      parentPath: "/digital-workforce",
    };
  }
  if (collection === "teams") {
    return {
      path: `/digital-workforce/teams/${recordId}`,
      view: "digital-workforce-team",
      recordId,
      parentPath: "/digital-workforce",
    };
  }
  return null;
}

export function parseAiCommandWorkspacePath(
  value: string | null | undefined,
): ParsedAiCommandWorkspacePath | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return null;
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) return null;
  const pathname = normalizePathname(trimmed);
  if (!pathname.startsWith("/") || pathname === "/") return null;
  const segments = pathname.slice(1).split("/").filter(Boolean);
  if (segments.length === 0 || segments.length > 3) return null;
  const workforce = parseDigitalWorkforcePath(segments);
  if (workforce) return workforce;
  if (segments.length > 2) return null;
  const root = segments[0];
  if (!root || !(root in WORKSPACE_PATHS)) return null;
  const mapping = WORKSPACE_PATHS[root];
  if (!mapping) return null;
  if (segments.length === 1) {
    return {
      path: `/${root}`,
      view: mapping.view,
      recordId: null,
      parentPath: mapping.parentPath ?? null,
    };
  }
  const recordId = segments[1];
  if (!recordId || !mapping.detailView || !UUID_PATTERN.test(recordId)) return null;
  return {
    path: `/${root}/${recordId}`,
    view: mapping.detailView,
    recordId,
    parentPath: `/${root}`,
  };
}

export function workspacePathForArtifactType(
  type: string,
  recordId?: string | null,
): string | null {
  switch (type) {
    case "company-list":
      return "/companies";
    case "company-detail":
      return recordId ? `/companies/${recordId}` : null;
    case "contact-list":
      return "/contacts";
    case "contact-detail":
      return recordId ? `/contacts/${recordId}` : null;
    case "lead-list":
      return "/leads";
    case "lead-detail":
      return recordId ? `/leads/${recordId}` : null;
    case "task-list":
      return "/tasks";
    case "task-detail":
      return recordId ? `/tasks/${recordId}` : null;
    case "activity-timeline":
      return "/activities";
    case "notification-list":
      return "/notifications";
    case "workflow-run-list":
      return "/workflow-runs";
    case "workflow-run-detail":
      return recordId ? `/workflow-runs/${recordId}` : null;
    case "integration-health-summary":
    case "integration-detail":
      return "/integrations";
    case "digital-workforce-organization":
      return "/digital-workforce";
    case "digital-workforce-agent-list":
      return "/digital-workforce/agents";
    case "digital-workforce-agent-detail":
    case "digital-workforce-agent-draft":
      return recordId ? `/digital-workforce/agents/${recordId}` : "/digital-workforce/agents";
    case "digital-workforce-run-list":
      return "/digital-workforce/runs";
    case "digital-workforce-run-trace":
    case "digital-workforce-artifacts":
      return recordId ? `/digital-workforce/runs/${recordId}` : "/digital-workforce/runs";
    case "digital-workforce-handoff-detail":
    case "digital-workforce-handoff-list":
      return recordId ? `/digital-workforce/handoffs/${recordId}` : "/digital-workforce/runs";
    case "digital-workforce-department":
      return recordId ? `/digital-workforce/departments/${recordId}` : "/digital-workforce";
    case "digital-workforce-team":
      return recordId ? `/digital-workforce/teams/${recordId}` : "/digital-workforce";
    default:
      return null;
  }
}
