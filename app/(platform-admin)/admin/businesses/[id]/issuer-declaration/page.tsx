"use client";

import { useParams } from "next/navigation";

import { IssuerDesignationSurface } from "@/components/platform-admin/issuer-designation-surface";
import { AdminConsole } from "@/components/platform-admin/console/admin-console";

/** Platform admin — who may make this business's issuer declaration (#1081). */
export default function PlatformAdminIssuerDesignationPage() {
  const params = useParams();
  const rawId = params?.id;
  const businessId = typeof rawId === "string" ? Number(rawId) : Number.NaN;
  return (
    <AdminConsole title="הצהרת מנפיק — מינוי המורשה להצהיר" backHref={Number.isInteger(businessId) ? `/admin/businesses/${businessId}` : "/admin/businesses"}>
      {() => <IssuerDesignationSurface businessId={businessId} />}
    </AdminConsole>
  );
}
