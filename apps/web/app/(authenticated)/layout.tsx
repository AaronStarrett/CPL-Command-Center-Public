import { getServerRuntime } from "@bea/database";
import { ApplicationShell, Badge, Header } from "@bea/ui";
import Link from "next/link";
import type { ReactNode } from "react";

import { AppLogo } from "@/components/app-logo";
import { GlobalSearch } from "@/components/global-search";
import { CompactNavigation, DesktopNavigation } from "@/components/navigation";
import { GuidedDemoRuntime, GuidedDemoStatusBar } from "@/components/guided-demo-runtime";
import { ProfileMenu } from "@/components/profile-menu";
import { requireSession } from "@/lib/auth/authorization";
import { navigationForUser, primaryNavigationForUser } from "@/lib/navigation";
import { OperatingModeBanner } from "@/components/operating-mode-banner";
import { isPhase133ProductionPresentationTest } from "@/lib/phase133-production-presentation-test";
import { createRuntimePresentation } from "@/lib/production-presentation";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const [session, runtime] = await Promise.all([requireSession(), getServerRuntime()]);
  const productionPresentationTest = isPhase133ProductionPresentationTest();
  const presentation = createRuntimePresentation(
    productionPresentationTest
      ? { appMode: "production", runtimeMode: "production", deploymentProfile: "local-live" }
      : runtime.environment,
    productionPresentationTest ? "local-live" : process.env.BEA_DEPLOYMENT_PROFILE,
  );
  const presentedSession = productionPresentationTest
    ? { ...session, provider: "local-owner" as const, email: null }
    : session;
  const [primary, navigation] = await Promise.all([
    primaryNavigationForUser(session.personaId),
    navigationForUser(session.personaId),
  ]);
  const canSearch = navigation.some((item) => item.href === "/search");
  const canViewNotifications = navigation.some((item) => item.href === "/notifications");

  return (
    <GuidedDemoRuntime
      displayName={presentedSession.displayName}
      appMode={runtime.environment.appMode}
    >
      <ApplicationShell
        logo={<AppLogo priority />}
        productName="BEA Operations Command Center"
        navigation={<DesktopNavigation primary={primary} secondary={navigation} />}
        mobileNavigation={<CompactNavigation primary={primary} secondary={navigation} />}
        banner={<OperatingModeBanner />}
        header={
          <Header
            leading={
              <>
                <GuidedDemoStatusBar />
                {canSearch ? <GlobalSearch /> : null}
              </>
            }
            actions={
              <>
                {canViewNotifications ? (
                  <Link
                    className="bea-header-notifications"
                    href="/notifications"
                    aria-label="Open notifications"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
                    </svg>
                    <span aria-hidden="true" />
                  </Link>
                ) : null}
                <ProfileMenu session={presentedSession} />
              </>
            }
          />
        }
        footer={
          <div className="bea-cluster">
            <Badge tone="info">
              {presentation.ownerEvaluation
                ? "Owner Evaluation"
                : presentation.production
                  ? presentation.profileLabel
                  : "BEA"}
            </Badge>
            <span>BEA Operations Command Center</span>
          </div>
        }
      >
        {children}
      </ApplicationShell>
    </GuidedDemoRuntime>
  );
}
