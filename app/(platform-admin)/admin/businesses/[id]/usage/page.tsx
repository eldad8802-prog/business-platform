"use client";

/** One business's subscription, usage, adjustments and lifecycle actions (subscriptions stage C). */
import { useParams } from "next/navigation";

import { AdminConsole } from "@/components/platform-admin/console/admin-console";
import { BusinessUsageSurface } from "@/components/platform-admin/console/business-usage-surface";

export default function PlatformAdminBusinessUsagePage() {
  const params = useParams();
  const rawId = params?.id;
  const businessId = typeof rawId === "string" ? Number(rawId) : Number.NaN;
  return (
    <AdminConsole title="מנוי ושימוש" backHref={Number.isInteger(businessId) ? `/admin/businesses/${businessId}` : "/admin/businesses"}>
      {() => <BusinessUsageSurface businessId={businessId} />}
    </AdminConsole>
  );
}
