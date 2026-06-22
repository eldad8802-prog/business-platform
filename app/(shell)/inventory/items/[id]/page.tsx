"use client";

import { useParams } from "next/navigation";
import ProductDetailView from "@/components/inventory/product-detail-view";

export default function InventoryItemPage() {
  const params = useParams();
  const itemId = Number(params?.id);
  return <ProductDetailView itemId={itemId} chrome="page" />;
}
