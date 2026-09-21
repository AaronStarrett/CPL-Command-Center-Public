import { Alert, Button, FormField, Input, Select } from "@bea/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AppLogo } from "@/components/app-logo";
import { getDemoPersonas } from "@/lib/auth/personas";
import {
  getAuthenticationProvider,
  getCurrentSession,
  isDemoAuthEnabled,
} from "@/lib/auth/session-store";
import { isPhase133ProductionPresentationTest } from "@/lib/phase133-production-presentation-test";
import { safeReturnPath } from "@/lib/safe-return-path";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const notices: Record<
  string,
  { tone: "info" | "success" | "warning" | "danger"; title: string; message: string }
> = {
  expired: {
    tone: "warning",
    title: "Session expired",
    message: "Sign in again through the authentication method available for this runtime.",
  },
  required: {
    tone: "info",
    title: "Sign-in required",
    message: "Authentication is required to open the Command Center.",
  },
  "signed-out": { tone: "success", title: "Signed out", message: "The local session was removed." },
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await getCurrentSession()) redirect("/command-center");

  const query = await searchParams;
  const reason = typeof query.reason === "string" ? query.reason : "";
  const error = typeof query.error === "string" ? query.error : "";
  const returnTo = safeReturnPath(
    typeof query.returnTo === "string" ? query.returnTo : undefined,
    "/command-center",
  );
  const provider = await getAuthenticationProvider();
  const productionPresentationTest = isPhase133ProductionPresentationTest();
  const demoEnabled =
    provider === "demo" && (await isDemoAuthEnabled()) && !productionPresentationTest;
  const previewEnabled =
    demoEnabled &&
    process.env.BEA_PREVIEW_MODE === "true" &&
    process.env.BEA_PREVIEW_AUTHORITY === "Start-BEA-Preview.cmd";
  const ownerEvaluationEnabled =
    process.env.BEA_OWNER_EVALUATION === "true" ||
    process.env.BEA_DEPLOYMENT_PROFILE === "owner-evaluation";
  const localOwnerEnabled = provider === "local-owner" || productionPresentationTest;
  const personas = demoEnabled ? getDemoPersonas() : [];
  const notice = notices[reason];

  return (
    <main className="bea-auth-page bea-animated-page">
      <section className="bea-auth-panel" aria-labelledby="sign-in-heading">
        <div className="bea-auth-panel__brand">
          <div>
            <AppLogo priority />
            <h1>
              Operations
              <br />
              Command Center
            </h1>
            <p>
              A controlled operations workspace for BEA’s company, contact, task, and system
              records.
            </p>
          </div>
          <span className="bea-auth-panel__phase">
            {ownerEvaluationEnabled
              ? "Owner Evaluation"
              : previewEnabled
                ? "PREVIEW — NON-PRODUCTION"
                : demoEnabled
                  ? "Local development"
                  : "BEA Operations Command Center"}
          </span>
        </div>
        <div className="bea-auth-panel__form">
          <h2 id="sign-in-heading">
            {ownerEvaluationEnabled
              ? "Open Owner Evaluation"
              : demoEnabled
                ? previewEnabled
                  ? "Open the isolated Preview workspace"
                  : "Open the local development workspace"
                : localOwnerEnabled
                  ? "Local Owner sign-in"
                  : "Enterprise sign-in"}
          </h2>
          <p>
            {ownerEvaluationEnabled
              ? "Synthetic BEA records. Connect OpenAI inside the application after sign-in. External systems are not connected."
              : demoEnabled
                ? previewEnabled
                  ? "Synthetic Preview personas use isolated local data and never connect to live providers."
                  : "Test personas exercise stable role assignments without connecting to an identity provider."
                : localOwnerEnabled
                  ? "Use the Local Owner credential configured on this loopback-only workstation."
                  : "BEA is in production mode. Microsoft Entra must be configured before sign-in."}
          </p>
          {notice ? (
            <Alert tone={notice.tone} title={notice.title}>
              {notice.message}
            </Alert>
          ) : null}
          {error === "invalid-persona" ? (
            <Alert tone="danger" title="Persona unavailable">
              {ownerEvaluationEnabled
                ? "Select one of the configured Owner Evaluation accounts."
                : "Select one of the configured demo personas."}
            </Alert>
          ) : null}
          {error === "invalid-credentials" ? (
            <Alert tone="danger" title="Sign-in unsuccessful">
              The supplied Local Owner credentials could not be accepted.
            </Alert>
          ) : null}
          {provider === "microsoft-entra" ? (
            <Alert tone="warning" title="Production authentication not connected">
              This runtime correctly excludes test personas. Ask an authorized administrator to
              complete Microsoft Entra activation before sign-in.
            </Alert>
          ) : null}
          {demoEnabled ? (
            <>
              <form action="/api/auth/sign-in" method="post" className="bea-stack">
                <input type="hidden" name="returnTo" value={returnTo} />
                <FormField
                  label={ownerEvaluationEnabled ? "Owner Evaluation account" : "Demo persona"}
                  htmlFor="persona"
                  hint={
                    ownerEvaluationEnabled
                      ? "Authorization uses this account’s role. Connect OpenAI separately inside the application."
                      : "Authorization uses the persona’s stable role IDs, not this display name."
                  }
                  required
                >
                  <Select id="persona" name="personaId" defaultValue={personas[0]?.id} required>
                    {personas.map((persona) => (
                      <option key={persona.id} value={persona.id}>
                        {persona.displayName} — {persona.title}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <Button type="submit">Sign in to Command Center</Button>
              </form>
              <Alert
                tone="info"
                title={
                  ownerEvaluationEnabled
                    ? "Owner Evaluation boundary"
                    : previewEnabled
                      ? "Preview boundary"
                      : "Development boundary"
                }
              >
                {ownerEvaluationEnabled
                  ? "Live OpenAI · Synthetic BEA Data · External Systems Not Connected. PostgreSQL is not required."
                  : previewEnabled
                    ? "This isolated Preview uses synthetic data, isolated persistence, and no production secrets or providers."
                    : "Test accounts and fixtures are isolated from the production runtime."}
              </Alert>
            </>
          ) : null}
          {localOwnerEnabled ? (
            <>
              <form action="/api/auth/sign-in" method="post" className="bea-stack">
                <input type="hidden" name="returnTo" value={returnTo} />
                <FormField label="Username" htmlFor="local-owner-username" required>
                  <Input
                    id="local-owner-username"
                    name="username"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    minLength={3}
                    maxLength={64}
                    required
                  />
                </FormField>
                <FormField label="Passphrase" htmlFor="local-owner-password" required>
                  <Input
                    id="local-owner-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    minLength={14}
                    maxLength={1024}
                    required
                  />
                </FormField>
                <Button type="submit">Sign in to Command Center</Button>
                <Link href="/recover">Recover Local Owner access</Link>
              </form>
              <Alert tone="info" title="Local Live boundary">
                Local Owner authentication is available only through the configured HTTPS loopback
                origin on this workstation.
              </Alert>
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}
