import type { Metadata } from "next";

import { makeArtifactPage } from "../artifact-kind-page";

const page = makeArtifactPage(
  "Inspection schemas",
  "Inspection schemas",
  "Canonical field dictionaries. These are synthetic demonstration schemas, not BEA production fields.",
  "inspection_schema",
);

export const metadata: Metadata = page.metadata;
export const dynamic = "force-dynamic";
export default page.Page;
