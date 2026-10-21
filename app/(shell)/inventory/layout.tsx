import type { ReactNode } from "react";
import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import { inventoryFoundationCss } from "@/components/inventory/inventory-foundation.css";
import { InventoryToastHost } from "@/components/inventory/inventory-toast";

// Tab title in the interface language (Hebrew source "מלאי": lib/i18n/messages/he.ts → meta.titles.inventory).
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.titles.inventory") };
}

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
