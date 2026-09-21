import type { HTMLAttributes } from "react";

import { cn } from "./utils";

export function AnimatedPage({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bea-animated-page", className)} {...props} />;
}

export function GlassSurface({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bea-glass-surface", className)} {...props} />;
}

export function FloatingSurface({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bea-floating-surface", className)} {...props} />;
}

export function AnimatedList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bea-animated-list", className)} {...props} />;
}
