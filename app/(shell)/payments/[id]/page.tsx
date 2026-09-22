"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { collectionFetch } from "@/components/collection/collection-client";

/**
 * Legacy: a collection request page. The request now lives inside its
 * customer's financial thread, anchored to it. The customer is resolved
 * through the authenticated API (the business comes from the session only).
 */
export default function LegacyPaymentRequestRedirect() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  useEffect(() => {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) {
      router.replace("/collection");
      return;
    }
    collectionFetch<{ request: { customerId: number | null } }>(`/api/payments/requests/${id}`)
      .then((d) =>
        router.replace(
          d.request.customerId ? `/collection/c/${d.request.customerId}?request=${id}` : "/collection"
        )
      )
      .catch(() => router.replace("/collection"));
  }, [params.id, router]);
  return <p dir="rtl" style={{ padding: 24 }}>מעביר לתיק הלקוח…</p>;
}
