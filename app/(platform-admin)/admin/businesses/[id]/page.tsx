"use client";

import { useParams } from "next/navigation";
import { BusinessDetailSurface } from "@/components/platform-admin/business-detail-surface";
import { AdminConsole, consoleStyles } from "@/components/platform-admin/console/admin-console";
import { AuditSurface } from "@/components/platform-admin/console/audit-surface";

export default function PlatformAdminBusinessDetailPage() {
  const params = useParams();
  const rawId = params?.id;
  const businessId =
    typeof rawId === "string" ? Number(rawId) : Number.NaN;

  return (
    <AdminConsole title="כרטיס עסק" backHref="/admin/businesses">
      {(session) => (
        <>
          <BusinessDetailSurface session={session} businessId={businessId} />
          {Number.isInteger(businessId) && businessId > 0 ? (
            <section className={consoleStyles.card} aria-labelledby="business-admin-log">
              <div className={consoleStyles.cardHead}>
                <h2 id="business-admin-log">פעולות ניהול על העסק</h2>
              </div>
              <AuditSurface businessId={businessId} />
            </section>
          ) : null}
        </>
      )}
    </AdminConsole>
  );
}
