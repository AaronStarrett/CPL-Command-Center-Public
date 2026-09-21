import type { AnchorHTMLAttributes } from "react";

import { cn } from "./utils";

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: "default" | "subtle" | "button";
}

export function Link({ className, variant = "default", ...props }: LinkProps) {
  return <a className={cn("bea-link", `bea-link--${variant}`, className)} {...props} />;
}
