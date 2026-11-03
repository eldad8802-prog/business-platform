"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { InvLoading, InvPage } from "@/components/inventory/v2/kit";

/**
 * Order history now lives in the orders hub ("היסטוריה" chip). The old route is
 * kept for inbound links and replaced by the hub with that chip selected.
 */
export default function SupplierHistoryRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/inventory/supplier-purchases?tab=history");
  }, [router]);
  return (
    <InvPage title="היסטוריית הזמנות" backFallback="/inventory/supplier-purchases">
      <InvLoading rows={3} />
    </InvPage>
  );
}
