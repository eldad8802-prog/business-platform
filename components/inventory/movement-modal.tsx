"use client";

import { useEffect, useMemo, useState } from "react";
import { createInventoryMovement } from "@/lib/api/inventory";
import { useAccessibleDialog } from "@/components/ui/accessibility";

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

// WP1 accessibility ids (A-11 dialog labelling, A-15 error linkage).
const TITLE_ID = "movement-modal-title";
const ERROR_ID = "movement-modal-error";
const QUANTITY_ID = "movement-quantity";

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

  // WP1 A-11 via the shared A-18 primitive: role/aria-modal, focus trap +
  // focus-in (to the quantity field) + focus-restore, Escape, background inert,
  // scroll-lock. `loading` gates dismissal (no Escape/backdrop close while saving).
  const { dialogRef, dialogProps, backdropProps } =
    useAccessibleDialog<HTMLDivElement>({
      open,
      onClose,
      labelledById: TITLE_ID,
      disableClose: loading,
      initialFocusId: QUANTITY_ID,
    });

  const reasons = useMemo(
    () => (mode === "ADD" ? ADD_REASONS : REMOVE_REASONS),
    [mode]
  );

  useEffect(() => {
    if (!open) return;

    // Intentional reset-on-(re)open: this modal stays mounted (renders null when
    // closed), so form state must be cleared each time it reopens. Pre-existing
    // behavior — preserved unchanged. (A codebase-wide react-hooks refactor to a
    // key-based remount is a separate code-quality task, not an a11y change.)
    /* eslint-disable react-hooks/set-state-in-effect */
    setQuantity("1");
    setNote("");
    setError(null);
    setLoading(false);
    setReason(mode === "ADD" ? "MANUAL_ADD" : "MANUAL_REMOVE");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, mode]);

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
      // WP1 A-15: move focus to the invalid field on validation failure.
      dialogRef.current?.querySelector<HTMLElement>(`#${QUANTITY_ID}`)?.focus();
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
    } catch (err) {
      // Preserve prior behavior (use a thrown value's `message` if present) without `any`.
      const message =
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message?: unknown }).message ?? "")
          : "";
      setError(message || "שגיאה בשמירת התנועה");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      dir="rtl"
      {...backdropProps}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.45)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      <div
        {...dialogProps}
        style={{
          width: "100%",
          maxWidth: "440px",
          borderRadius: "22px",
          background: "#ffffff",
          boxShadow: "0 20px 50px rgba(15, 23, 42, 0.2)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "18px 18px 12px 18px",
            borderBottom: "1px solid #f1f5f9",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div>
            <div id={TITLE_ID} style={{ fontSize: "17px", fontWeight: 800, color: "#111827" }}>
              {mode === "ADD" ? "הוספת מלאי" : "הפחתת מלאי"}
            </div>

            <div style={{ marginTop: "4px", fontSize: "13px", color: "#6b7280" }}>
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
              border: "1px solid #e5e7eb",
              background: "#f9fafb",
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
            <label htmlFor={QUANTITY_ID} style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 700, color: "#111827" }}>
              כמות
            </label>

            <input
              id={QUANTITY_ID}
              type="number"
              min="1"
              step="1"
              value={quantity}
              disabled={loading}
              aria-required={true}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? ERROR_ID : undefined}
              onChange={(e) => {
                setQuantity(e.target.value);
                setError(null);
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
            />
          </div>

          <div>
            <label htmlFor="movement-reason" style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 700, color: "#111827" }}>
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
                border: "1px solid #d1d5db",
                fontSize: "14px",
                background: loading ? "#f9fafb" : "#ffffff",
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
            <label htmlFor="movement-note" style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 700, color: "#111827" }}>
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
                border: "1px solid #d1d5db",
                fontSize: "14px",
                background: loading ? "#f9fafb" : "#ffffff",
                boxSizing: "border-box",
              }}
            />
          </div>

          {error && (
            // WP1 A-13: announce the error to assistive tech.
            <div id={ERROR_ID} role="alert" style={{ color: "#b91c1c", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "12px", padding: "10px 12px", fontSize: "13px", lineHeight: 1.5 }}>
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
                background: "#ffffff",
                color: "#111827",
                border: "1px solid #d1d5db",
                cursor: loading ? "not-allowed" : "pointer",
                fontSize: "14px",
                fontWeight: 700,
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
                background: mode === "ADD" ? "#059669" : "#dc2626",
                color: "#ffffff",
                border: "none",
                cursor: loading ? "not-allowed" : "pointer",
                fontSize: "14px",
                fontWeight: 800,
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
