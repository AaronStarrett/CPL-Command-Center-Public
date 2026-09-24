import { PublicInquiryForm } from "../../workspace/public-inquiry-form";

export const dynamic = "force-dynamic";
export default async function InquiryPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  const development =
    process.env.NODE_ENV !== "production" && process.env.CPL_LOCAL_DEVELOPMENT_AUTH === "true";
  return <PublicInquiryForm key={publicId} publicId={publicId} development={development} />;
}
