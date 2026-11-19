"use client";

import Link from "next/link";
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
          {Number.isInteger(businessId) && businessId > 0 ? (
            <section className={consoleStyles.card} aria-labelledby="business-issuer-declaration">
              <div className={consoleStyles.cardHead}>
                <h2 id="business-issuer-declaration">הצהרת מנפיק</h2>
              </div>
              <p className={consoleStyles.note}>עסק עם כמה משתמשים: מינוי המשתמש המורשה להצהיר, עם אסמכתה וסיבה (דורש אימות מנהל).</p>
              <Link className={consoleStyles.linkBtn} href={`/admin/businesses/${businessId}/issuer-declaration`}>
                למינוי המורשה להצהיר
              </Link>
            </section>
          ) : null}
        </>
      )}
    </AdminConsole>
  );
}
