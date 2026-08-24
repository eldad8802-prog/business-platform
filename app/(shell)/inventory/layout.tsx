import type { ReactNode } from "react";
import type { Metadata } from "next";
import { inventoryFoundationCss } from "@/components/inventory/inventory-foundation.css";
import { InventoryToastHost } from "@/components/inventory/inventory-toast";

export const metadata: Metadata = { title: "מלאי" };

export default function InventoryLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div data-inventory-module>
      <style>{inventoryFoundationCss}</style>
      {children}
      <InventoryToastHost />
    </div>
  );
}
