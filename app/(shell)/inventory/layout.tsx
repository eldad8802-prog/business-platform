import type { ReactNode } from "react";
import { inventoryFoundationCss } from "@/components/inventory/inventory-foundation.css";
import { InventoryToastHost } from "@/components/inventory/inventory-toast";

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
