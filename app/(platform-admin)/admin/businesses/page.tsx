"use client";

import { Suspense } from "react";
import { AdminConsole } from "@/components/platform-admin/console/admin-console";
import { BusinessesSurface } from "@/components/platform-admin/console/businesses-surface";
import { LoadingBlock } from "@/components/platform-admin/console/console-states";

export default function PlatformAdminBusinessesPage() {
  return (
    <AdminConsole title="עסקים">
      {() => (
        // useSearchParams (the ?q= from the global search) needs a boundary.
        <Suspense fallback={<LoadingBlock height={320} label="טוען עסקים" />}>
          <BusinessesSurface />
        </Suspense>
      )}
    </AdminConsole>
  );
}
