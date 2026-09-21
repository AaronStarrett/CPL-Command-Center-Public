export const DEMO_ROUTER_VERSION = "phase1-router-v1";

export type DemoIntentType =
  | "command-center-summary"
  | "open-tasks"
  | "overdue-tasks"
  | "unread-notifications"
  | "recent-activity"
  | "company-list"
  | "company-open"
  | "company-contacts"
  | "lead-list"
  | "lead-open"
  | "lead-missing-info"
  | "lead-needs-info-list"
  | "research-presentation"
  | "search"
  | "integration-health"
  | "disconnected-systems"
  | "workflow-run-list"
  | "workflow-run-latest"
  | "help"
  | "create-task"
  | "digital-workforce-organization"
  | "digital-workforce-active"
  | "digital-workforce-handoff-latest"
  | "digital-workforce-agent-open"
  | "digital-workforce-create-draft"
  | "digital-workforce-run-start"
  | "digital-workforce-run-stop"
  | "digital-workforce-failures"
  | "digital-workforce-models"
  | "digital-workforce-records"
  | "unsupported";

export interface DemoTaskDraft {
  readonly title: string | null;
  readonly description: string | null;
  readonly assignee: string | null;
  readonly dueDate: string | null;
  readonly companyName: string | null;
  readonly contactName: string | null;
  readonly leadTerm: string | null;
}

export interface DemoIntent {
  readonly type: DemoIntentType;
  readonly normalizedInput: string;
  readonly term?: string;
  readonly companyName?: string;
  readonly leadTerm?: string;
  readonly agentTerm?: string;
  readonly taskDraft?: DemoTaskDraft;
}

function cleanCaptured(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .trim()
    .replace(/^["“']|["”']$/gu, "")
    .replace(/[.!?]+$/gu, "")
    .trim();
  return cleaned || null;
}

function capture(input: string, pattern: RegExp): string | null {
  return cleanCaptured(pattern.exec(input)?.[1]);
}

function taskDraft(input: string): DemoTaskDraft {
  const explicitTitle =
    capture(
      input,
      /(?:called|named|titled)\s+["“']?(.+?)["”']?(?=\s+(?:assigned|assign|due|for company|for contact|with description)\b|$)/iu,
    ) ??
    capture(
      input,
      /create\s+(?:an?\s+)?(?:internal\s+)?(?:follow[- ]?up\s+)?task\s*:\s*(.+?)(?=\s+(?:assigned|assign|due|for company|for contact|with description)\b|$)/iu,
    );
  const exactFollowUp = /^create\s+(?:an?\s+)?internal\s+follow[- ]?up\s+task[.!?]*$/iu.test(
    input.trim(),
  );
  const leadFollowUp = /create\s+(?:an?\s+)?(?:internal\s+)?follow[- ]?up\s+task\b/iu.test(input);

  return {
    title: explicitTitle ?? (exactFollowUp || leadFollowUp ? "Internal follow-up task" : null),
    description: capture(
      input,
      /(?:with\s+)?description\s*[:=]\s*(.+?)(?=\s+(?:assigned|assign|due|for company|for contact|for lead)\b|$)/iu,
    ),
    assignee: capture(
      input,
      /(?:assigned\s+to|assign\s+to|owner\s*[:=])\s+(.+?)(?=\s+(?:due|for company|for contact|for lead|with description)\b|$)/iu,
    ),
    dueDate: capture(
      input,
      /due(?:\s+date)?\s*[:=]?\s*(today|tomorrow|\d{4}-\d{2}-\d{2})(?=\s|$)/iu,
    ),
    companyName: capture(
      input,
      /for\s+company\s+["“']?(.+?)["”']?(?=\s+(?:assigned|assign|due|for contact|for lead|with description)\b|$)/iu,
    ),
    contactName: capture(
      input,
      /for\s+contact\s+["“']?(.+?)["”']?(?=\s+(?:assigned|assign|due|for company|for lead|with description)\b|$)/iu,
    ),
    leadTerm: capture(
      input,
      /for\s+lead\s+["“']?(.+?)["”']?(?=\s+(?:assigned|assign|due|for company|for contact|with description)\b|$)/iu,
    ),
  };
}

export function routeDemoCommand(input: string): DemoIntent {
  const normalizedInput = input.replace(/\s+/gu, " ").trim();
  const lower = normalizedInput.toLocaleLowerCase("en-US");

  if (!normalizedInput) return { type: "unsupported", normalizedInput };
  if (/\bcreate\b.*\btask\b/iu.test(normalizedInput)) {
    return { type: "create-task", normalizedInput, taskDraft: taskDraft(normalizedInput) };
  }
  if (/\b(?:what can i do|help|capabilities)\b/iu.test(normalizedInput)) {
    return { type: "help", normalizedInput };
  }
  if (/\bcreate (?:an? )?(?:digital )?agent\b/iu.test(lower) && !/\bpublish\b/iu.test(lower)) {
    return { type: "digital-workforce-create-draft", normalizedInput };
  }
  if (/\b(?:stop|cancel) (?:this |the )?(?:run|workforce run|team run)\b/iu.test(lower)) {
    return { type: "digital-workforce-run-stop", normalizedInput };
  }
  if (
    /\bhave (?:my |the )?(?:executive team|digital workforce|andrew)\b/iu.test(lower) ||
    (/\breview the leads that still need information\b/iu.test(lower) &&
      /\b(?:research|briefing|pdf)\b/iu.test(lower))
  ) {
    return { type: "digital-workforce-run-start", normalizedInput };
  }
  if (/\b(?:what failed|which (?:work|steps?) failed)\b/iu.test(lower)) {
    return { type: "digital-workforce-failures", normalizedInput };
  }
  if (/\bwhich model did (?:each|the) agent/iu.test(lower)) {
    return { type: "digital-workforce-models", normalizedInput };
  }
  if (/\bwhat records could this agent access\b/iu.test(lower)) {
    return { type: "digital-workforce-records", normalizedInput };
  }
  if (/\b(?:latest|most recent) handoff\b/iu.test(lower)) {
    return { type: "digital-workforce-handoff-latest", normalizedInput };
  }
  if (
    /\b(?:which agents are working|agents? working right now|active (?:work|runs?))\b/iu.test(lower)
  ) {
    return { type: "digital-workforce-active", normalizedInput };
  }
  const agentTerm =
    capture(normalizedInput, /(?:open|show)\s+(?:the\s+)?(.+?)\s+agent\b/iu) ??
    capture(normalizedInput, /(?:open|show)\s+agent\s+["“']?(.+?)["”']?/iu);
  if (agentTerm) {
    return { type: "digital-workforce-agent-open", normalizedInput, agentTerm };
  }
  if (
    /\b(?:digital workforce|agent hierarchy|company agent hierarchy|show me my digital workforce)\b/iu.test(
      lower,
    )
  ) {
    return { type: "digital-workforce-organization", normalizedInput };
  }
  if (/\b(?:today'?s priorities|priorities today|command center summary)\b/iu.test(lower)) {
    return { type: "command-center-summary", normalizedInput };
  }
  if (/\b(?:overdue tasks?|tasks?(?: are)? overdue)\b/iu.test(lower)) {
    return { type: "overdue-tasks", normalizedInput };
  }
  if (/\b(?:open tasks?|tasks? that are open)\b/iu.test(lower)) {
    return { type: "open-tasks", normalizedInput };
  }
  if (/\b(?:unread notifications?|notifications? unread)\b/iu.test(lower)) {
    return { type: "unread-notifications", normalizedInput };
  }
  if (/\b(?:recent activity|latest activity)\b/iu.test(lower)) {
    return { type: "recent-activity", normalizedInput };
  }
  if (/\b(?:connector|integration) health\b/iu.test(lower)) {
    return { type: "integration-health", normalizedInput };
  }
  if (
    /\b(?:systems?|connectors?|integrations?)\b.*\b(?:not connected|disconnected)\b/iu.test(lower)
  ) {
    return { type: "disconnected-systems", normalizedInput };
  }
  if (/\b(?:open|show)\b.*\b(?:latest|most recent)\b.*\bworkflow run\b/iu.test(lower)) {
    return { type: "workflow-run-latest", normalizedInput };
  }
  if (/\b(?:recent|latest|show)\b.*\bworkflow runs?\b/iu.test(lower)) {
    return { type: "workflow-run-list", normalizedInput };
  }

  if (
    /\b(?:leads? that (?:still )?need (?:information|info)|blocked leads|missing information on (?:the )?leads|what is blocking (?:the )?leads|leads that still need information)\b/iu.test(
      lower,
    )
  ) {
    return { type: "lead-needs-info-list", normalizedInput };
  }

  if (/\b(?:show|list|open)\b.*\b(?:lead review queue|review queue|leads)\b/iu.test(lower)) {
    return { type: "lead-list", normalizedInput };
  }
  if (
    (/\b(?:search the (?:public )?web|public web research|web search)\b/iu.test(lower) ||
      /\bresearch\b.*\b(?:latest|public web|current)\b/iu.test(lower) ||
      /\b(?:latest information relevant to|research the latest information|research current)\b/iu.test(
        lower,
      )) &&
    !/\b(?:open|show|summarize|retrieve)\b.*\b(?:lead|project|record)\b/iu.test(lower) &&
    !/\bsynthetic envelope sources\b/iu.test(lower)
  ) {
    return { type: "research-presentation", normalizedInput };
  }

  const missingLead = capture(
    normalizedInput,
    /(?:what is missing|missing information|explain missing(?: information)?)\s+(?:on|for|about)\s+(?:lead\s+)?["“']?(.+?)["”']?[.!?]*$/iu,
  );
  if (missingLead) {
    return { type: "lead-missing-info", normalizedInput, leadTerm: missingLead };
  }

  const leadTerm =
    capture(
      normalizedInput,
      /(?:open|show|summarize|retrieve)\s+lead\s+["“']?(.+?)["”']?[.!?]*$/iu,
    ) ??
    capture(
      normalizedInput,
      /(?:open|show|summarize|retrieve)\s+(?:the\s+|our\s+)?(.+?)\s+lead\b/iu,
    );
  if (leadTerm && !/^(?:review queue|leads)$/iu.test(leadTerm)) {
    return { type: "lead-open", normalizedInput, leadTerm };
  }

  const contactsCompany = capture(
    normalizedInput,
    /(?:show|list|find)\s+contacts\s+(?:for|at|with)\s+["“']?(.+?)["”']?[.!?]*$/iu,
  );
  if (contactsCompany) {
    return {
      type: "company-contacts",
      normalizedInput,
      companyName: contactsCompany,
    };
  }

  const companyName = capture(
    normalizedInput,
    /(?:open|show)\s+(?:company\s+)?["“']?(.+?)["”']?[.!?]*$/iu,
  );
  if (companyName && !/^(?:all\s+)?companies$/iu.test(companyName)) {
    return { type: "company-open", normalizedInput, companyName };
  }
  if (/\b(?:show|list)\s+(?:all\s+)?companies\b/iu.test(lower)) {
    return { type: "company-list", normalizedInput };
  }

  const term = capture(normalizedInput, /\b(?:search|find|look up)\s+(?:for\s+)?(.+?)[.!?]*$/iu);
  if (term) return { type: "search", normalizedInput, term };

  return { type: "unsupported", normalizedInput };
}

export function resolveDemoDueDate(value: string | null, now: Date = new Date()): string | null {
  if (!value) return null;
  const normalized = value.toLocaleLowerCase("en-US");
  const date = new Date(now);
  date.setUTCHours(17, 0, 0, 0);
  if (normalized === "tomorrow") date.setUTCDate(date.getUTCDate() + 1);
  else if (normalized !== "today") {
    const parsed = new Date(`${normalized}T17:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  }
  return date.toISOString();
}
