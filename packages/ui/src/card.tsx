import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "./utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn("bea-card", "bea-floating-surface", className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bea-card__header", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("bea-card__title", className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("bea-card__description", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bea-card__content", className)} {...props} />;
}

export interface MetricCardProps {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  status?: "neutral" | "success" | "warning" | "danger";
}

export function MetricCard({ label, value, detail, status = "neutral" }: MetricCardProps) {
  return (
    <Card className="bea-metric-card">
      <span className="bea-eyebrow">{label}</span>
      <strong className="bea-metric-card__value">{value}</strong>
      {detail ? (
        <span className={cn("bea-metric-card__detail", `bea-text--${status}`)}>{detail}</span>
      ) : null}
    </Card>
  );
}
