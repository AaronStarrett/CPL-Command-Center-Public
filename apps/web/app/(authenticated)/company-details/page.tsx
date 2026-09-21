import { PERMISSIONS } from "@bea/security";
import type { Metadata } from "next";

import { CompanyDetailsExperience } from "@/components/company-details-experience";
import { requirePermission } from "@/lib/auth/authorization";

export const metadata: Metadata = { title: "Company Details" };
export const dynamic = "force-dynamic";

export default async function CompanyDetailsPage() {
  await requirePermission(PERMISSIONS.HOME_VIEW, "company-details");
  return <CompanyDetailsExperience />;
}
