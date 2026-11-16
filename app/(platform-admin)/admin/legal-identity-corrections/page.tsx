"use client";

/** Legal identity corrections — the approver's queue (dedicated permission; the server enforces it). */
import { SignedInAs } from "@/components/legal-identity/signed-in-as";
import { AdminConsole } from "@/components/platform-admin/console/admin-console";
import { CorrectionsListSurface } from "@/components/platform-admin/console/legal-identity-corrections-surface";

export default function PlatformAdminLegalIdentityCorrectionsPage() {
  return <AdminConsole title="תיקוני זהות עסקית" backHref="/admin/security">{() => (
        <div style={{ display: "grid", gap: 14 }}>
          <SignedInAs />
          <CorrectionsListSurface />
        </div>
      )}</AdminConsole>;
}
