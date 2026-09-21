import type { HTMLAttributes, TableHTMLAttributes } from "react";

import { cn } from "./utils";

export function TableFoundation({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bea-table-shell", className)} {...props} />;
}

export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn("bea-table", className)} {...props} />;
}
