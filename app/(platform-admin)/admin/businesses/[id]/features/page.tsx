"use client";

import { useParams } from "next/navigation";
import { BusinessFeaturesSurface } from "@/components/platform-admin/business-features-surface";
import { AdminConsole } from "@/components/platform-admin/console/admin-console";

export default function PlatformAdminBusinessFeaturesPage() {
  const params = useParams();
  const rawId = params?.id;
  const businessId =
    typeof rawId === "string" ? Number(rawId) : Number.NaN;

  return (
    <AdminConsole
      title="גישה לפיצ׳רים"
      backHref={Number.isInteger(businessId) ? `/admin/businesses/${businessId}` : "/admin/businesses"}
    >
      {(session) => <BusinessFeaturesSurface session={session} businessId={businessId} />}
    </AdminConsole>
  );
}
