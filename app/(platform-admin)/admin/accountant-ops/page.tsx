"use client";

/** Accountant package monitoring (G5 milestone 1) — operational state of the monthly accountant package. */
import { AdminConsole } from "@/components/platform-admin/console/admin-console";
import { AccountantOpsSurface } from "@/components/platform-admin/console/accountant-ops-surface";

export default function PlatformAdminAccountantOpsPage() {
  return <AdminConsole title="ניטור חבילת רו״ח" backHref="/admin/security">{() => <AccountantOpsSurface />}</AdminConsole>;
}
