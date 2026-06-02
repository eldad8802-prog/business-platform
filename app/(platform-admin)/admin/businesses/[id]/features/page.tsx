"use client";

import { useParams } from "next/navigation";
import { BusinessFeaturesSurface } from "@/components/platform-admin/business-features-surface";
import { PlatformAdminGate } from "@/components/platform-admin/platform-admin-gate";

export default function PlatformAdminBusinessFeaturesPage() {
  const params = useParams();
  const rawId = params?.id;
  const businessId =
    typeof rawId === "string" ? Number(rawId) : Number.NaN;

  return (
    <PlatformAdminGate>
      {(session) => (
        <BusinessFeaturesSurface session={session} businessId={businessId} />
      )}
    </PlatformAdminGate>
  );
}
