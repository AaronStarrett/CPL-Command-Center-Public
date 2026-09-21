import type { ButtonHTMLAttributes } from "react";

import { cn } from "./utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "small" | "medium";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
}

export function Button({
  className,
  variant = "primary",
  size = "medium",
  busy = false,
  disabled,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn("bea-button", `bea-button--${variant}`, `bea-button--${size}`, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      type={type}
      {...props}
    >
      {busy ? <span className="bea-spinner" aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}
