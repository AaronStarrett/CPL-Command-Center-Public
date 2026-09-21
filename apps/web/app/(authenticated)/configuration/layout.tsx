import { Link } from "@bea/ui";
import type { ReactNode } from "react";

import { CONFIGURATION_STUDIO_LINKS } from "@/lib/configuration-presentation";

export default function ConfigurationLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bea-stack bea-stack--large">
      <nav aria-label="Configuration studio" className="bea-cluster">
        {CONFIGURATION_STUDIO_LINKS.map((item) => (
          <Link key={item.href} href={item.href}>
            {item.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
