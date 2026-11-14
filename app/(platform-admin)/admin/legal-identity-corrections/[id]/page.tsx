"use client";

/** One legal identity correction request: review, approve / reject / request more information. */
import { useParams } from "next/navigation";

import { AdminConsole } from "@/components/platform-admin/console/admin-console";
import { EmptyBlock } from "@/components/platform-admin/console/console-states";
import { CorrectionDetailSurface } from "@/components/platform-admin/console/legal-identity-corrections-surface";

export default function PlatformAdminLegalIdentityCorrectionPage() {
  const params = useParams();
  const raw = params?.id;
  const id = typeof raw === "string" ? Number(raw) : Number.NaN;
  return (
    <AdminConsole title="בקשה לתיקון זהות עסקית" backHref="/admin/legal-identity-corrections">
      {() => (Number.isInteger(id) && id > 0 ? <CorrectionDetailSurface id={id} /> : <EmptyBlock title="מזהה בקשה לא תקין" />)}
    </AdminConsole>
  );
}
