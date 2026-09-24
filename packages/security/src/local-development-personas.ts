/** Fixed synthetic selections only. These are never provider claims or roles.
 * The operator bootstrap owns identity creation; the local request/DB boundary
 * must be verified before resolving or issuing a session for any selection. */
export const CPL_LOCAL_PERSONAS = [
  {
    key: "legacy-owner",
    subject: "local-owner",
    email: "local-owner@cpl.invalid",
    label: "Existing development owner",
    platformOperator: false,
  },
  {
    key: "platform-operator",
    subject: "local-platform-operator",
    email: "local-platform-operator@cpl.invalid",
    label: "Synthetic platform operator",
    platformOperator: true,
  },
  {
    key: "owner-alpha",
    subject: "local-owner-alpha",
    email: "local-owner-alpha@cpl.invalid",
    label: "Synthetic company owner Alpha",
    platformOperator: false,
  },
  {
    key: "owner-beta",
    subject: "local-owner-beta",
    email: "local-owner-beta@cpl.invalid",
    label: "Synthetic company owner Beta",
    platformOperator: false,
  },
  {
    key: "manager",
    subject: "local-manager",
    email: "local-manager@cpl.invalid",
    label: "Synthetic manager",
    platformOperator: false,
  },
  {
    key: "reviewer",
    subject: "local-reviewer",
    email: "local-reviewer@cpl.invalid",
    label: "Synthetic reviewer",
    platformOperator: false,
  },
  {
    key: "field-staff",
    subject: "local-field-staff",
    email: "local-field-staff@cpl.invalid",
    label: "Synthetic field staff",
    platformOperator: false,
  },
  {
    key: "member",
    subject: "local-member",
    email: "local-member@cpl.invalid",
    label: "Synthetic team member",
    platformOperator: false,
  },
] as const;
export type CplLocalPersonaKey = (typeof CPL_LOCAL_PERSONAS)[number]["key"];
export function cplLocalPersona(value: unknown) {
  return CPL_LOCAL_PERSONAS.find((persona) => persona.key === value) ?? null;
}
