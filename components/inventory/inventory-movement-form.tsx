"use client";

import { useState } from "react";
import { createInventoryMovement } from "@/lib/api/inventory";

type Props = {
  itemId: number;
  onSuccess: () => Promise<void> | void;
};

type MovementType = "IN" | "OUT";

type ReasonValue =
  | "INITIAL_STOCK"
  | "MANUAL_ADD"
  | "MANUAL_REMOVE"
  | "SALE"
  | "RETURN"
  | "DAMAGE"
  | "INVENTORY_COUNT_CORRECTION";

type ReasonOption = {
  value: ReasonValue;
  label: string;
};

const IN_REASONS: ReasonOption[] = [
  { value: "INITIAL_STOCK", label: "מלאי התחלתי" },
  { value: "MANUAL_ADD", label: "הוספה ידנית" },
  { value: "RETURN", label: "החזרה" },
  { value: "INVENTORY_COUNT_CORRECTION", label: "תיקון ספירה" },
];

const OUT_REASONS: ReasonOption[] = [
  { value: "MANUAL_REMOVE", label: "הפחתה ידנית" },
  { value: "SALE", label: "מכירה" },
  { value: "DAMAGE", label: "נזק" },
  { value: "INVENTORY_COUNT_CORRECTION", label: "תיקון ספירה" },
];

export default function InventoryMovementForm({ itemId, onSuccess }: Props) {
  const [movementType, setMovementType] = useState<MovementType>("IN");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState<ReasonValue>("MANUAL_ADD");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [successText, setSuccessText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const availableReasons = movementType === "IN" ? IN_REASONS : OUT_REASONS;

  function handleMovementTypeChange(nextType: MovementType) {
    if (loading) return;

    setMovementType(nextType);
    setError(null);
    setSuccessText(null);
    setReason(nextType === "IN" ? "MANUAL_ADD" : "MANUAL_REMOVE");
  }

  async function handleSubmit() {
    if (loading) return;

    const parsedQuantity = Number(quantity);

    if (
      !quantity ||
      Number.isNaN(parsedQuantity) ||
      !Number.isFinite(parsedQuantity) ||
      parsedQuantity <= 0
    ) {
      setError("צריך להזין כמות גדולה מ־0");
      setSuccessText(null);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setSuccessText(null);

      await createInventoryMovement({
        itemId,
        quantityDelta: movementType === "IN" ? parsedQuantity : -parsedQuantity,
        movementType,
        reason,
        note: note.trim() ? note.trim() : undefined,
      });

      setQuantity("1");
      setNote("");
      setReason(movementType === "IN" ? "MANUAL_ADD" : "MANUAL_REMOVE");
      setSuccessText("התנועה נשמרה והמלאי עודכן");

      await onSuccess();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "שגיאה בעדכון מלאי");
      setSuccessText(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: "18px",
        background: "#ffffff",
        padding: "18px",
        boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
      }}
    >
      <div style={{ fontWeight: 800, marginBottom: "6px", fontSize: "16px", color: "#111827" }}>
        עדכון מלאי
      </div>

      <div style={{ fontSize: "13px", color: "#6b7280", lineHeight: 1.5, marginBottom: "14px" }}>
        כל שינוי כאן נשמר כתנועת מלאי מסודרת ומתועד בהיסטוריה.
      </div>

      <div style={{ display: "flex", gap: "8px", marginBottom: "14px" }}>
        <button
          type="button"
          disabled={loading}
          onClick={() => handleMovementTypeChange("IN")}
          style={{
            flex: 1,
            minHeight: "44px",
            padding: "9px 12px",
            borderRadius: "12px",
            border: "1px solid #e5e7eb",
            background:
              movementType === "IN"
                ? "linear-gradient(90deg, #243B57 0%, #9DB4D4 100%)"
                : "#f9fafb",
            color: movementType === "IN" ? "#ffffff" : "#111827",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.7 : 1,
            fontWeight: 800,
          }}
        >
          הוספת מלאי
        </button>

        <button
          type="button"
          disabled={loading}
          onClick={() => handleMovementTypeChange("OUT")}
          style={{
            flex: 1,
            minHeight: "44px",
            padding: "9px 12px",
            borderRadius: "12px",
            border: "1px solid #e5e7eb",
            background: movementType === "OUT" ? "#dc2626" : "#f9fafb",
            color: movementType === "OUT" ? "#ffffff" : "#111827",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.7 : 1,
            fontWeight: 800,
          }}
        >
          הפחתת מלאי
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div>
          <label htmlFor="inventory-movement-quantity" style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 700, color: "#111827" }}>
            כמות
          </label>

          <input
            id="inventory-movement-quantity"
            type="number"
            min="1"
            step="1"
            value={quantity}
            disabled={loading}
            onChange={(e) => {
              setQuantity(e.target.value);
              setError(null);
              setSuccessText(null);
            }}
            placeholder="כמות"
            style={{
              width: "100%",
              minHeight: "46px",
              padding: "10px 12px",
              borderRadius: "12px",
              border: "1px solid #d1d5db",
              fontSize: "14px",
              background: loading ? "#f9fafb" : "#ffffff",
              boxSizing: "border-box",
            }}
          />
        </div>

        <div>
          <label htmlFor="inventory-movement-reason" style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 700, color: "#111827" }}>
            סיבה
          </label>

          <select
            id="inventory-movement-reason"
            value={reason}
            disabled={loading}
            onChange={(e) => {
              setReason(e.target.value as ReasonValue);
              setError(null);
              setSuccessText(null);
            }}
            style={{
              width: "100%",
              minHeight: "46px",
              padding: "10px 12px",
              borderRadius: "12px",
              border: "1px solid #d1d5db",
              fontSize: "14px",
              background: loading ? "#f9fafb" : "#ffffff",
              boxSizing: "border-box",
            }}
          >
            {availableReasons.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="inventory-movement-note" style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 700, color: "#111827" }}>
            הערה
          </label>

          <input
            id="inventory-movement-note"
            type="text"
            value={note}
            disabled={loading}
            onChange={(e) => {
              setNote(e.target.value);
              setSuccessText(null);
            }}
            placeholder="הערה אופציונלית"
            style={{
              width: "100%",
              minHeight: "46px",
              padding: "10px 12px",
              borderRadius: "12px",
              border: "1px solid #d1d5db",
              fontSize: "14px",
              background: loading ? "#f9fafb" : "#ffffff",
              boxSizing: "border-box",
            }}
          />
        </div>

        {error && (
          <div style={{ color: "#b91c1c", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "12px", padding: "10px 12px", fontSize: "13px", lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        {successText && (
          <div style={{ color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "12px", padding: "10px 12px", fontSize: "13px", lineHeight: 1.5 }}>
            {successText}
          </div>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={loading}
          style={{
            width: "100%",
            minHeight: "46px",
            padding: "10px 14px",
            borderRadius: "12px",
            background: "linear-gradient(90deg, #243B57 0%, #9DB4D4 100%)",
            color: "#ffffff",
            border: "none",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.75 : 1,
            fontSize: "14px",
            fontWeight: 800,
          }}
        >
          {loading ? "שומר/ת..." : "עדכן מלאי"}
        </button>
      </div>
    </section>
  );
}
