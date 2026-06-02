"use client";

import { useParams } from "next/navigation";
import { BusinessDetailSurface } from "@/components/platform-admin/business-detail-surface";
import { PlatformAdminGate } from "@/components/platform-admin/platform-admin-gate";

export default function PlatformAdminBusinessDetailPage() {
  const params = useParams();
  const rawId = params?.id;
  const businessId =
    typeof rawId === "string" ? Number(rawId) : Number.NaN;

  return (
    <PlatformAdminGate>
      {(session) => (
        <BusinessDetailSurface session={session} businessId={businessId} />
      )}
    </PlatformAdminGate>
  );
}
