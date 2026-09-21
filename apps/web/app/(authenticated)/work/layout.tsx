import { Link } from "@bea/ui";
import type { ReactNode } from "react";

import { WORK_STUDIO_LINKS } from "@/lib/work-presentation";

export default function WorkLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bea-stack bea-stack--large">
      <nav aria-label="Operational work" className="bea-cluster">
        {WORK_STUDIO_LINKS.map((item) => (
          <Link key={item.href} href={item.href}>
            {item.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
