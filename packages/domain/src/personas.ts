export const DEMO_ROLE_IDS = {
  OWNER_ADMIN: "owner-admin",
  SALES: "sales",
  OPERATIONS: "operations",
  EXECUTIVE_READONLY: "executive-readonly",
  INTEGRATION_ADMIN: "integration-admin",
} as const;

export type RoleId = (typeof DEMO_ROLE_IDS)[keyof typeof DEMO_ROLE_IDS];

export interface DemoPersona {
  id: string;
  key: string;
  displayName: string;
  email: `${string}@example.invalid`;
  title: string;
  roleIds: readonly RoleId[];
}

export const DEMO_PERSONAS = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    key: "owner-administrator",
    displayName: "Workspace Owner",
    email: "owner.admin@example.invalid",
    title: "Chief Executive Officer",
    roleIds: [DEMO_ROLE_IDS.OWNER_ADMIN],
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    key: "sales-specialist",
    displayName: "Sales Specialist",
    email: "sales@example.invalid",
    title: "Sales",
    roleIds: [DEMO_ROLE_IDS.SALES],
  },
  {
    id: "10000000-0000-4000-8000-000000000003",
    key: "operations-coordinator",
    displayName: "Operations Coordinator",
    email: "operations@example.invalid",
    title: "Operations",
    roleIds: [DEMO_ROLE_IDS.OPERATIONS],
  },
  {
    id: "10000000-0000-4000-8000-000000000004",
    key: "executive-viewer",
    displayName: "Executive Viewer",
    email: "executive@example.invalid",
    title: "Read-only Executive",
    roleIds: [DEMO_ROLE_IDS.EXECUTIVE_READONLY],
  },
  {
    id: "10000000-0000-4000-8000-000000000005",
    key: "integration-administrator",
    displayName: "Integration Administrator",
    email: "integrations.admin@example.invalid",
    title: "Integration Administrator",
    roleIds: [DEMO_ROLE_IDS.INTEGRATION_ADMIN],
  },
  {
    id: "10000000-0000-4000-8000-000000000006",
    key: "operations-coordinator-b",
    displayName: "Operations Coordinator B",
    email: "operations.b@example.invalid",
    title: "Operations",
    roleIds: [DEMO_ROLE_IDS.OPERATIONS],
  },
] as const satisfies readonly DemoPersona[];

export function findDemoPersona(personaKey: string): DemoPersona | undefined {
  return DEMO_PERSONAS.find((persona) => persona.key === personaKey);
}
