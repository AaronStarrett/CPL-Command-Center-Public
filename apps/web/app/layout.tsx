import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { MotionProvider } from "@bea/ui";

import "@bea/ui/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "CPL Command Center",
    template: "%s | CPL Command Center",
  },
  description: "Service workflows for your company workspace.",
  applicationName: "CPL Command Center",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#08304a",
};

const MOTION_BOOTSTRAP = String.raw`(() => {
  const root = document.documentElement;
  let preference = "system";
  try {
    const stored = window.localStorage.getItem("bea:motion-profile:v1");
    if (stored === "system" || stored === "full" || stored === "reduced") preference = stored;
  } catch {
    preference = "system";
  }
  let systemReduced = false;
  try {
    systemReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    systemReduced = false;
  }
  root.dataset.motionPreference = preference;
  root.dataset.motionProfile =
    preference === "reduced" || (preference === "system" && systemReduced) ? "reduced" : "full";
  root.dataset.motionVisibility = document.visibilityState === "hidden" ? "hidden" : "visible";
  root.dataset.motionLoad = "idle";
  root.dataset.motionModal = "closed";
  root.dataset.motionReady = "true";
})();`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-motion-modal="closed"
      data-motion-load="idle"
      data-motion-preference="system"
      data-motion-profile="full"
      data-motion-ready="false"
      data-motion-visibility="visible"
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: MOTION_BOOTSTRAP }} />
      </head>
      <body>
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
