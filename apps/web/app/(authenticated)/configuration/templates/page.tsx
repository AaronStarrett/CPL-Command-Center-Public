import type { Metadata } from "next";

import { makeArtifactPage } from "../artifact-kind-page";

const page = makeArtifactPage(
  "Report templates",
  "Report templates",
  "Renderer-neutral report document definitions. Layout differences come from configuration, not fixture-id branches.",
  "report_template",
);

export const metadata: Metadata = page.metadata;
export const dynamic = "force-dynamic";
export default page.Page;
