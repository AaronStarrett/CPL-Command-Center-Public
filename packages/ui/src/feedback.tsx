import type { HTMLAttributes, ReactNode } from "react";

import { Link } from "./link";
import { cn } from "./utils";

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
}

export function Alert({ className, tone = "info", title, children, ...props }: AlertProps) {
  return (
    <div
      className={cn("bea-alert", `bea-alert--${tone}`, className)}
      role={tone === "danger" ? "alert" : "status"}
      {...props}
    >
      {title ? <strong className="bea-alert__title">{title}</strong> : null}
      <div>{children}</div>
    </div>
  );
}

export interface StateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

function StatePanel({ title, description, action, kind }: StateProps & { kind: string }) {
  return (
    <section className={cn("bea-state", `bea-state--${kind}`)} aria-live="polite">
      <span className="bea-state__mark" aria-hidden="true" />
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div className="bea-state__action">{action}</div> : null}
    </section>
  );
}

export function EmptyState(props: StateProps) {
  return <StatePanel {...props} kind="empty" />;
}

export function ErrorState(props: StateProps) {
  return <StatePanel {...props} kind="error" />;
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="bea-loading-state" role="status" aria-live="polite">
      <span className="bea-spinner bea-spinner--dark" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export interface AccessDeniedProps {
  title?: string;
  description?: string;
  returnHref?: string;
}

export function AccessDenied({
  title = "Access denied",
  description = "Your current role does not allow access to this area.",
  returnHref = "/",
}: AccessDeniedProps) {
  return (
    <ErrorState
      title={title}
      description={description}
      action={<Link href={returnHref}>Return to Command Center</Link>}
    />
  );
}

export function DemoModeBanner({ children }: { children?: ReactNode }) {
  return (
    <div className="bea-demo-banner" role="status">
      <strong>Demo mode</strong>
      <span>
        {children ?? "Simulated data and adapters only. No external systems are connected."}
      </span>
    </div>
  );
}
