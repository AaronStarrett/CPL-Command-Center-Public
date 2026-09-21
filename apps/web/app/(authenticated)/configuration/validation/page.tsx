import type { Metadata } from "next";

import { makeArtifactPage } from "../artifact-kind-page";

const page = makeArtifactPage(
  "Validation rules",
  "Validation rules",
  "Deterministic rule sets. These are synthetic demonstration rules, not BEA production policy.",
  "validation_rule_set",
);

export const metadata: Metadata = page.metadata;
export const dynamic = "force-dynamic";
export default page.Page;
