import "server-only";

import { DEMO_PERSONAS, type DemoPersona } from "@bea/domain";

export type ConfiguredDemoPersona = DemoPersona & { displayName: string };

function personaNameEnvironmentKey(persona: DemoPersona): string {
  const suffix = persona.key
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toUpperCase();
  return `BEA_DEMO_PERSONA_${suffix}_NAME`;
}

export function getDemoPersonas(): readonly ConfiguredDemoPersona[] {
  return DEMO_PERSONAS.map((persona) => ({
    ...persona,
    // Display names are configurable; stable persona IDs and role IDs remain authoritative.
    displayName: process.env[personaNameEnvironmentKey(persona)]?.trim() || persona.displayName,
  }));
}

export function getDemoPersona(personaId: string): ConfiguredDemoPersona | undefined {
  return getDemoPersonas().find((persona) => persona.id === personaId);
}
