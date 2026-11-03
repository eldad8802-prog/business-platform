"use client";

import { useParams } from "next/navigation";
import ProductForm from "@/components/inventory/v2/product-form";

/** Edit product (redesign; replaces the old edit bottom sheet on the product page). */
export default function EditInventoryItemPage() {
  const params = useParams();
  const itemId = Number(params?.id);
  return <ProductForm mode="edit" itemId={itemId} />;
}
