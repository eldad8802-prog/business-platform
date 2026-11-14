"use client";

/** Legal identity corrections — the approver's queue (dedicated permission; the server enforces it). */
import { AdminConsole } from "@/components/platform-admin/console/admin-console";
import { CorrectionsListSurface } from "@/components/platform-admin/console/legal-identity-corrections-surface";

export default function PlatformAdminLegalIdentityCorrectionsPage() {
  return <AdminConsole title="תיקוני זהות עסקית" backHref="/admin/security">{() => <CorrectionsListSurface />}</AdminConsole>;
}
