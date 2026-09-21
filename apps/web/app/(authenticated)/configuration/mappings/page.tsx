import type { Metadata } from "next";

import { makeArtifactPage } from "../artifact-kind-page";

const page = makeArtifactPage(
  "Mapping profiles",
  "Mapping profiles",
  "Source-to-canonical mappings with controlled transforms only. JSON and CSV demonstration profiles are shown.",
  "mapping_profile",
);

export const metadata: Metadata = page.metadata;
export const dynamic = "force-dynamic";
export default page.Page;
