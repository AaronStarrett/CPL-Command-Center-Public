import { AnimatedPage } from "@bea/ui";
import type { ReactNode } from "react";

export default function AuthenticatedTemplate({ children }: { children: ReactNode }) {
  return <AnimatedPage>{children}</AnimatedPage>;
}
