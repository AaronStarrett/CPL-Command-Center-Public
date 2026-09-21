import { Alert, Button, FormField, Input } from "@bea/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AppLogo } from "@/components/app-logo";
import { getAuthenticationProvider } from "@/lib/auth/session-store";

export const metadata: Metadata = { title: "Recover Local Owner access" };
export const dynamic = "force-dynamic";

export default async function RecoverLocalOwnerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if ((await getAuthenticationProvider()) !== "local-owner") redirect("/sign-in");
  const query = await searchParams;
  const failed = query.status === "failed";

  return (
    <main className="bea-auth-page bea-animated-page">
      <section className="bea-auth-panel" aria-labelledby="recovery-heading">
        <div className="bea-auth-panel__brand">
          <div>
            <AppLogo priority />
            <h1>
              Operations
              <br />
              Command Center
            </h1>
            <p>Recover the single Local Owner identity on this workstation.</p>
          </div>
          <span className="bea-auth-panel__phase">Local Live recovery</span>
        </div>
        <div className="bea-auth-panel__form">
          <h2 id="recovery-heading">Recover Local Owner access</h2>
          <p>
            Enter the one-time recovery code issued during setup and choose a new strong passphrase.
          </p>
          {failed ? (
            <Alert tone="danger" title="Recovery unsuccessful">
              Recovery could not be completed. Check the supplied information and try again.
            </Alert>
          ) : null}
          <form action="/api/auth/recover" method="post" className="bea-stack">
            <FormField label="Username" htmlFor="recovery-username" required>
              <Input
                id="recovery-username"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                minLength={3}
                maxLength={64}
                required
              />
            </FormField>
            <FormField label="Current recovery code" htmlFor="recovery-code" required>
              <Input
                id="recovery-code"
                name="recoveryCode"
                type="password"
                autoComplete="one-time-code"
                maxLength={128}
                required
              />
            </FormField>
            <FormField
              label="New passphrase"
              htmlFor="recovery-new-password"
              hint="Use at least 14 characters. A longer unique passphrase is recommended."
              required
            >
              <Input
                id="recovery-new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={14}
                maxLength={1024}
                required
              />
            </FormField>
            <FormField label="Confirm new passphrase" htmlFor="recovery-confirm-password" required>
              <Input
                id="recovery-confirm-password"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                minLength={14}
                maxLength={1024}
                required
              />
            </FormField>
            <Button type="submit">Recover Local Owner access</Button>
          </form>
          <Alert tone="warning" title="One-time rotation">
            Successful recovery revokes every existing session and displays a replacement recovery
            code once. Store that code securely before leaving the result page.
          </Alert>
          <Alert tone="info" title="Protected Local Live boundary">
            Recovery requests are accepted only from the configured HTTPS loopback origin.
          </Alert>
          <Link href="/sign-in">Return to sign-in</Link>
        </div>
      </section>
    </main>
  );
}
