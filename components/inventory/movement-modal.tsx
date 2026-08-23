"use client";

import { useEffect, useMemo, useState } from "react";
import { createInventoryMovement } from "@/lib/api/inventory";
import { useAccessibleDialog } from "@/components/ui/use-accessible-dialog";

type Mode = "ADD" | "REMOVE";

type Props = {
  open: boolean;
  itemId: number | null;
  itemName: string;
  mode: Mode;
  onClose: () => void;
  onSuccess: () => Promise<void> | void;
};

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

const ADD_REASONS: ReasonOption[] = [
  { value: "INITIAL_STOCK", label: "מלאי התחלתי" },
  { value: "MANUAL_ADD", label: "הוספה ידנית" },
  { value: "RETURN", label: "החזרה" },
  { value: "INVENTORY_COUNT_CORRECTION", label: "תיקון ספירה" },
];

const REMOVE_REASONS: ReasonOption[] = [
  { value: "MANUAL_REMOVE", label: "הפחתה ידנית" },
  { value: "SALE", label: "מכירה" },
  { value: "DAMAGE", label: "נזק" },
  { value: "INVENTORY_COUNT_CORRECTION", label: "תיקון ספירה" },
];

export default function MovementModal({
  open,
  itemId,
  itemName,
  mode,
  onClose,
  onSuccess,
}: Props) {
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState<ReasonValue>("MANUAL_ADD");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reasons = useMemo(
    () => (mode === "ADD" ? ADD_REASONS : REMOVE_REASONS),
    [mode]
  );

  useEffect(() => {
    if (!open) return;

    setQuantity("1");
    setNote("");
    setError(null);
    setLoading(false);
    setReason(mode === "ADD" ? "MANUAL_ADD" : "MANUAL_REMOVE");
  }, [open, mode]);

  useEffect(() => {
    if (!open) return;

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !loading) {
        onClose();
      }
    }

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [open, loading, onClose]);

  // Called unconditionally (before the early return) per rules-of-hooks; only
  // activates the trap/scroll-lock while the modal is actually open.
  const dialogRef = useAccessibleDialog<HTMLDivElement>({
    isOpen: open && itemId !== null,
    onClose,
  });

  if (!open || itemId === null) {
    return null;
  }

  async function handleSubmit() {
    if (loading) return;

    const parsedQuantity = Number(quantity);

    if (
      !quantity ||
      Number.isNaN(parsedQuantity) ||
      parsedQuantity <= 0 ||
      !Number.isFinite(parsedQuantity)
    ) {
      setError("צריך להזין כמות גדולה מ־0");
      return;
    }

    try {
      setLoading(true);
      setError(null);

      await createInventoryMovement({
        itemId: itemId as number,
        quantityDelta: mode === "ADD" ? parsedQuantity : -parsedQuantity,
        movementType: mode === "ADD" ? "IN" : "OUT",
        reason,
        note: note.trim() ? note.trim() : undefined,
      });

      await onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || "שגיאה בשמירת התנועה");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      dir="rtl"
      onClick={() => {
        if (!loading) {
          onClose();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--inv-backdrop)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="movement-modal-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "440px",
          borderRadius: "22px",
          background: "var(--inv-card-bg)",
          boxShadow: "var(--inv-shadow-overlay)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "18px 18px 12px 18px",
            borderBottom: "1px solid var(--inv-surface-2)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div>
            <div id="movement-modal-title" style={{ fontSize: "17px", fontWeight: 600, color: "var(--inv-text)" }}>
              {mode === "ADD" ? "הוספת מלאי" : "הפחתת מלאי"}
            </div>

            <div style={{ marginTop: "4px", fontSize: "13px", color: "var(--inv-text-muted)" }}>
              {itemName}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            style={{
              width: "36px",
              height: "36px",
              borderRadius: "10px",
              border: "1px solid var(--inv-border)",
              background: "var(--inv-surface-2)",
              cursor: loading ? "not-allowed" : "pointer",
              fontSize: "18px",
              lineHeight: 1,
              opacity: loading ? 0.6 : 1,
            }}
            aria-label="סגירת חלון"
          >
            ×
          </button>
        </div>

        <div style={{ padding: "18px", display: "flex", flexDirection: "column", gap: "14px" }}>
          <div>
            <label htmlFor="movement-quantity" style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600, color: "var(--inv-text)" }}>
              כמות
            </label>

            <input
              id="movement-quantity"
              type="number"
              min="1"
              step="1"
              value={quantity}
              disabled={loading}
              onChange={(e) => {
                setQuantity(e.target.value);
                setError(null);
              }}
              style={{
                width: "100%",
                minHeight: "46px",
                padding: "10px 12px",
                borderRadius: "12px",
                border: "1px solid var(--inv-border-hover)",
                fontSize: "14px",
                background: loading ? "var(--inv-surface-2)" : "var(--inv-card-bg)",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div>
            <label htmlFor="movement-reason" style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600, color: "var(--inv-text)" }}>
              סיבה
            </label>

            <select
              id="movement-reason"
              value={reason}
              disabled={loading}
              onChange={(e) => {
                setReason(e.target.value as ReasonValue);
                setError(null);
              }}
              style={{
                width: "100%",
                minHeight: "46px",
                padding: "10px 12px",
                borderRadius: "12px",
                border: "1px solid var(--inv-border-hover)",
                fontSize: "14px",
                background: loading ? "var(--inv-surface-2)" : "var(--inv-card-bg)",
                boxSizing: "border-box",
              }}
            >
              {reasons.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="movement-note" style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600, color: "var(--inv-text)" }}>
              הערה
            </label>

            <input
              id="movement-note"
              type="text"
              value={note}
              disabled={loading}
              onChange={(e) => setNote(e.target.value)}
              placeholder="אופציונלי"
              style={{
                width: "100%",
                minHeight: "46px",
                padding: "10px 12px",
                borderRadius: "12px",
                border: "1px solid var(--inv-border-hover)",
                fontSize: "14px",
                background: loading ? "var(--inv-surface-2)" : "var(--inv-card-bg)",
                boxSizing: "border-box",
              }}
            />
          </div>

          {error && (
            <div style={{ color: "var(--inv-danger)", background: "var(--inv-danger-bg)", border: "1px solid var(--inv-danger-border)", borderRadius: "12px", padding: "10px 12px", fontSize: "13px", lineHeight: 1.5 }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              style={{
                flex: 1,
                minHeight: "46px",
                padding: "10px 14px",
                borderRadius: "12px",
                background: "var(--inv-card-bg)",
                color: "var(--inv-text)",
                border: "1px solid var(--inv-border-hover)",
                cursor: loading ? "not-allowed" : "pointer",
                fontSize: "14px",
                fontWeight: 600,
                opacity: loading ? 0.6 : 1,
              }}
            >
              ביטול
            </button>

            <button
              type="button"
              onClick={handleSubmit}
              disabled={loading}
              style={{
                flex: 1,
                minHeight: "46px",
                padding: "10px 14px",
                borderRadius: "12px",
                background: mode === "ADD" ? "var(--inv-success)" : "var(--inv-danger)",
                color: "var(--inv-on-accent)",
                border: "none",
                cursor: loading ? "not-allowed" : "pointer",
                fontSize: "14px",
                fontWeight: 600,
                opacity: loading ? 0.75 : 1,
              }}
            >
              {loading
                ? "שומר/ת..."
                : mode === "ADD"
                ? "אישור הוספה"
                : "אישור הפחתה"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}