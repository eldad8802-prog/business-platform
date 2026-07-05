"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createInventoryMovement } from "@/lib/api/inventory";

type Props = {
  id: number;
  name: string;
  imageUrl?: string | null;
};

export default function InventoryItemCard({ id, name, imageUrl }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleAdd(e: React.MouseEvent) {
    e.stopPropagation();

    if (loading) return;
    setLoading(true);

    try {
      await createInventoryMovement({
        itemId: id,
        quantityDelta: 1,
        movementType: "IN",
        reason: "MANUAL_ADD",
      });
    } catch (err) {
      console.error(err);
      alert("שגיאה בהוספת מלאי");
    } finally {
      setLoading(false);
    }
  }

  async function handleRemove(e: React.MouseEvent) {
    e.stopPropagation();

    if (loading) return;
    setLoading(true);

    try {
      await createInventoryMovement({
        itemId: id,
        quantityDelta: -1,
        movementType: "OUT",
        reason: "MANUAL_REMOVE",
      });
    } catch (err) {
      console.error(err);
      alert("שגיאה בהפחתת מלאי");
    } finally {
      setLoading(false);
    }
  }

  function handleClick() {
    router.push(`/inventory/items/${id}`);
  }

  return (
    <div
      onClick={handleClick}
      style={{
        border: "1px solid var(--inv-border)",
        borderRadius: "16px",
        overflow: "hidden",
        background: "var(--inv-card-bg)",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        boxShadow: "var(--inv-shadow)",
      }}
    >
      {/* תמונה */}
      <div
        style={{
          width: "100%",
          height: "140px",
          background: "var(--inv-surface-2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={name}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : (
          <span style={{ color: "var(--inv-text-tertiary)", fontSize: "12px" }}>
            אין תמונה
          </span>
        )}
      </div>

      {/* שם */}
      <div
        style={{
          padding: "10px 12px",
          textAlign: "center",
          fontWeight: 600,
          fontSize: "14px",
        }}
      >
        {name}
      </div>

      {/* פעולות */}
      <div
        style={{
          display: "flex",
          borderTop: "1px solid var(--inv-surface-2)",
        }}
      >
        <button
          onClick={handleRemove}
          disabled={loading}
          style={{
            flex: 1,
            padding: "10px",
            border: "none",
            background: "var(--inv-danger-bg)",
            color: "var(--inv-danger)",
            fontSize: "18px",
            cursor: "pointer",
          }}
        >
          -
        </button>

        <button
          onClick={handleAdd}
          disabled={loading}
          style={{
            flex: 1,
            padding: "10px",
            border: "none",
            background: "var(--inv-success-bg)",
            color: "var(--inv-success)",
            fontSize: "18px",
            cursor: "pointer",
          }}
        >
          +
        </button>
      </div>
    </div>
  );
}