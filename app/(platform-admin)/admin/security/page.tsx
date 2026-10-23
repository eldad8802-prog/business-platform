"use client";

import { AdminConsole } from "@/components/platform-admin/console/admin-console";
import { SecuritySurface } from "@/components/platform-admin/console/security-surface";

export default function PlatformAdminSecurityPage() {
  return (
    <AdminConsole title="אבטחה">{(session) => <SecuritySurface initial={session} />}</AdminConsole>
  );
}
