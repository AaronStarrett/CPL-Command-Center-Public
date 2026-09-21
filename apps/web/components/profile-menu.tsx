import { Button, FormField, MotionPreferenceControl, Select } from "@bea/ui";
import Link from "next/link";

import { getDemoPersonas } from "@/lib/auth/personas";
import type { AuthSession } from "@/lib/auth/session-store";

function initials(name: string): string {
  return name
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part.at(0))
    .join("")
    .toUpperCase();
}

export function ProfileMenu({ session }: { session: AuthSession }) {
  const personas = session.provider === "demo" ? getDemoPersonas() : [];

  return (
    <details suppressHydrationWarning className="bea-profile-menu" data-testid="account-menu">
      <summary aria-label={`Account menu for ${session.displayName}`}>
        <span className="bea-profile-menu__avatar" aria-hidden="true">
          {initials(session.displayName)}
        </span>
        <span className="bea-profile-menu__identity">
          <strong>{session.displayName}</strong>
          <span>{session.title}</span>
        </span>
      </summary>
      <div className="bea-profile-menu__panel">
        <MotionPreferenceControl />
        {session.provider === "demo" ? (
          <form action="/api/auth/switch-persona" method="post" className="bea-stack">
            <input type="hidden" name="returnTo" value="/account" />
            <FormField
              label="Demo persona"
              htmlFor="profile-persona"
              hint="Roles are assigned by stable persona ID, never by display name."
            >
              <Select id="profile-persona" name="personaId" defaultValue={session.personaId}>
                {personas.map((persona) => (
                  <option key={persona.id} value={persona.id}>
                    {persona.displayName} — {persona.title}
                  </option>
                ))}
              </Select>
            </FormField>
            <Button type="submit" variant="secondary" size="small">
              Switch persona
            </Button>
          </form>
        ) : null}
        <div className="bea-profile-menu__links">
          <Link href="/account">Account and session</Link>
          <form action="/api/auth/sign-out" method="post">
            <Button type="submit" variant="ghost" size="small">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </details>
  );
}
