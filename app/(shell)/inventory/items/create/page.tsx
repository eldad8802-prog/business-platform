"use client";

import ProductForm from "@/components/inventory/v2/product-form";

/** New product (redesign mockup "מוצר חדש"); the form is shared with edit. */
export default function CreateInventoryItemPage() {
  return <ProductForm mode="create" />;
}
