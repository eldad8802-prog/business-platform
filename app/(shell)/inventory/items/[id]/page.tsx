"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import ProductDetailView from "@/components/inventory/product-detail-view";

export default function InventoryItemPage() {
  const params = useParams();
  const itemId = Number(params?.id);
  // useSearchParams() (the ?move= deep link) needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <ProductDetailView itemId={itemId} />
    </Suspense>
  );
}
