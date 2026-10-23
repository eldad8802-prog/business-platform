"use client";

import { AdminConsole } from "@/components/platform-admin/console/admin-console";
import { AuditSurface } from "@/components/platform-admin/console/audit-surface";

export default function PlatformAdminAuditPage() {
  return <AdminConsole title="יומן פעולות">{() => <AuditSurface />}</AdminConsole>;
}
