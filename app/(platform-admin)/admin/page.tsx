"use client";

import { AdminControlSurface } from "@/components/platform-admin/admin-control-surface";
import { PlatformAdminGate } from "@/components/platform-admin/platform-admin-gate";

export default function PlatformAdminPage() {
  return (
    <PlatformAdminGate>
      {(session) => <AdminControlSurface session={session} />}
    </PlatformAdminGate>
  );
}
