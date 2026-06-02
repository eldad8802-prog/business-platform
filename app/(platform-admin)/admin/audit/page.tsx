"use client";

import { AuditViewerSurface } from "@/components/platform-admin/audit-viewer-surface";
import { PlatformAdminGate } from "@/components/platform-admin/platform-admin-gate";

export default function PlatformAdminAuditPage() {
  return (
    <PlatformAdminGate>
      {(session) => <AuditViewerSurface session={session} />}
    </PlatformAdminGate>
  );
}
