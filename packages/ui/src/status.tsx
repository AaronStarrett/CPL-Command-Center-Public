import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "./utils";

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
}

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return <span className={cn("bea-badge", `bea-badge--${tone}`, className)} {...props} />;
}

export interface StatusIndicatorProps {
  label: string;
  tone?: StatusTone;
  detail?: ReactNode;
}

export function StatusIndicator({ label, tone = "neutral", detail }: StatusIndicatorProps) {
  return (
    <span className="bea-status-indicator">
      <span
        className={cn("bea-status-indicator__dot", `bea-status-indicator__dot--${tone}`)}
        aria-hidden="true"
      />
      <span>{label}</span>
      {detail ? <span className="bea-status-indicator__detail">{detail}</span> : null}
    </span>
  );
}

export interface HealthIndicatorProps {
  label: string;
  state: "healthy" | "degraded" | "unavailable" | "simulated";
}

const healthTone: Record<HealthIndicatorProps["state"], StatusTone> = {
  healthy: "success",
  degraded: "warning",
  unavailable: "danger",
  simulated: "info",
};

export function HealthIndicator({ label, state }: HealthIndicatorProps) {
  return <StatusIndicator label={label} detail={state} tone={healthTone[state]} />;
}
