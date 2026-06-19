"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import { InventoryRow, InventoryBadge, ConfirmModal } from "@/components/inventory/inventory-design";

function ConnectButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        minHeight: 38,
        padding: "0 16px",
        borderRadius: 11,
        border: "1px solid var(--inv-accent)",
        background: "var(--inv-accent)",
        color: "#fff",
        fontFamily: "inherit",
        fontWeight: 700,
        fontSize: 13.5,
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}

export default function SupplierPurchasesIntegrationsPage() {
  const router = useRouter();
  const [comingSoon, setComingSoon] = useState(false);

  return (
    <InventorySubPage
      title="אינטגרציות"
      variant="hub"
      sub="חברו קופה או ספק לעדכון מלאי אוטומטי"
      bottomNav="orders"
    >
      <div className="inv-rows">
        <InventoryRow
          thumb={<span style={{ fontSize: 22 }}>🧾</span>}
          title="קופה (POS)"
          meta="מכירות מתעדכנות אוטומטית במלאי"
          trail={<ConnectButton label="חבר" onClick={() => setComingSoon(true)} />}
        />
        <InventoryRow
          thumb={<span style={{ fontSize: 22 }}>📄</span>}
          title="יבוא קבצי CSV"
          meta="קליטת חשבוניות רכש מספקים"
          trail={<ConnectButton label="ייבא" onClick={() => router.push("/inventory/supplier-purchases/import")} />}
        />
        <InventoryRow
          thumb={<span style={{ fontSize: 22 }}>🔌</span>}
          title="חיבור ספק חדש (API)"
          meta="הזמנות ועדכוני מחיר אוטומטיים"
          trail={<InventoryBadge tone="neutral">בקרוב</InventoryBadge>}
          onClick={() => setComingSoon(true)}
        />
      </div>

      {comingSoon ? (
        <ConfirmModal
          title="בשלב הבא"
          body="יהיה אפשר להזין מפתח API מול הספק, לשמור חיבור מאובטח, ולבדוק שהחיבור תקין — לפני משיכת קטלוגים והזמנות אמיתית."
          confirmLabel="הבנתי"
          cancelLabel="סגירה"
          onConfirm={() => setComingSoon(false)}
          onCancel={() => setComingSoon(false)}
        />
      ) : null}
    </InventorySubPage>
  );
}
