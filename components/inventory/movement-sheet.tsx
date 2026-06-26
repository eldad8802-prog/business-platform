"use client";

/**
 * Movement Bottom Sheet — mockup `s3` (docs/docsdesign/inventory_screens.html.txt).
 * Segmented type (IN/OUT/ADJUSTMENT), reason, stepper, live before→after preview,
 * note, confirm. Delta-based: the inventory service computes
 * quantityAfter = quantityBefore + quantityDelta, so all three types submit a
 * non-zero quantityDelta — no logic/endpoint change.
 */

import { useMemo, useState } from "react";
import { createInventoryMovement } from "@/lib/api/inventory";
import {
  BottomSheet,
  SegmentedControl,
  Stepper,
  SheetActions,
} from "@/components/inventory/inventory-primitives";
import { inventoryToast } from "@/components/inventory/inventory-toast";

type MovementKind = "IN" | "OUT" | "ADJUSTMENT";

const IN_REASONS = [
  { value: "MANUAL_ADD", label: "הוספה ידנית" },
  { value: "RETURN", label: "החזרה" },
  { value: "INITIAL_STOCK", label: "מלאי התחלתי" },
] as const;

const OUT_REASONS = [
  { value: "MANUAL_REMOVE", label: "הפחתה ידנית" },
  { value: "SALE", label: "מכירה" },
  { value: "DAMAGE", label: "נזק" },
] as const;

export default function MovementSheet({
  itemId,
  itemName,
  currentQuantity,
  unitLabel,
  initialType = "IN",
  onClose,
  onSuccess,
}: {
  itemId: number;
  itemName: string;
  currentQuantity: number;
  unitLabel?: string;
  initialType?: MovementKind;
  onClose: () => void;
  onSuccess: () => Promise<void> | void;
}) {
  const unit = unitLabel ? ` ${unitLabel}` : "";
  const [kind, setKind] = useState<MovementKind>(initialType);
  // For IN/OUT this is the magnitude to add/remove; for ADJUSTMENT it is the new counted quantity.
  const [value, setValue] = useState<number>(initialType === "ADJUSTMENT" ? currentQuantity : 1);
  const [reason, setReason] = useState<string>(initialType === "OUT" ? "MANUAL_REMOVE" : "MANUAL_ADD");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function changeKind(next: MovementKind) {
    setKind(next);
    setError(null);
    if (next === "ADJUSTMENT") {
      setValue(currentQuantity);
    } else {
      setValue(1);
      setReason(next === "OUT" ? "MANUAL_REMOVE" : "MANUAL_ADD");
    }
  }

  const { delta, after, min } = useMemo(() => {
    if (kind === "IN") return { delta: value, after: currentQuantity + value, min: 1 };
    if (kind === "OUT") return { delta: -value, after: currentQuantity - value, min: 1 };
    return { delta: value - currentQuantity, after: value, min: 0 };
  }, [kind, value, currentQuantity]);

  const display = kind === "IN" ? `+${value}` : kind === "OUT" ? `−${value}` : `${value}`;
  // Why the confirm button is disabled, made explicit to the user instead of a
  // silently greyed-out button (audit P0 #2).
  const wouldGoNegative = after < 0;
  const noChange = delta === 0;
  const invalid = noChange || wouldGoNegative;
  const blockReason = wouldGoNegative
    ? kind === "OUT"
      ? `אי אפשר להפחית ${value}${unit} — במלאי יש רק ${currentQuantity}${unit}. הכמות לא יכולה לרדת מתחת ל־0.`
      : `הכמות החדשה (${after}${unit}) שלילית. המלאי לא יכול לרדת מתחת ל־0.`
    : noChange
      ? "אין שינוי בכמות. עדכנו את הכמות כדי לשמור."
      : null;

  async function handleConfirm() {
    if (loading || invalid) return;
    try {
      setLoading(true);
      setError(null);
      await createInventoryMovement({
        itemId,
        quantityDelta: delta,
        movementType: kind,
        reason: kind === "ADJUSTMENT" ? "INVENTORY_COUNT_CORRECTION" : reason,
        note: note.trim() ? note.trim() : undefined,
      });
      await onSuccess();
      inventoryToast.success("המלאי עודכן");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה בשמירת התנועה");
    } finally {
      setLoading(false);
    }
  }

  const reasons = kind === "OUT" ? OUT_REASONS : IN_REASONS;

  return (
    <BottomSheet
      title="עדכון מלאי"
      who={
        <>
          {itemName} · מלאי נוכחי <bdi>{currentQuantity}{unit}</bdi>
        </>
      }
      onClose={onClose}
      footer={
        <SheetActions
          confirmLabel={loading ? "שומר…" : "אישור עדכון"}
          onCancel={onClose}
          onConfirm={handleConfirm}
          confirmDisabled={loading || invalid}
        />
      }
    >
      <SegmentedControl<MovementKind>
        value={kind}
        onChange={changeKind}
        options={[
          { value: "IN", label: "הוספה" },
          { value: "OUT", label: "הפחתה" },
          { value: "ADJUSTMENT", label: "תיקון ספירה" },
        ]}
        style={{ marginBottom: 16 }}
      />

      {kind !== "ADJUSTMENT" ? (
        <>
          <div className="inv-field__lab">סיבה</div>
          <select
            className="inv-input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{ marginBottom: 6 }}
          >
            {reasons.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </>
      ) : null}

      <Stepper
        value={value}
        display={display}
        min={min}
        onDecrement={() => setValue((v) => Math.max(min, v - 1))}
        onIncrement={() => setValue((v) => v + 1)}
      />

      <div className="inv-preview">
        לאחר העדכון:{" "}
        <b>
          <bdi>{currentQuantity}</bdi> ← <bdi>{after}{unit}</bdi>
        </b>
      </div>

      {blockReason ? (
        <div className="inv-inline-warn" role="alert">
          {blockReason}
        </div>
      ) : null}

      <input
        className="inv-input"
        placeholder="הערה (אופציונלי)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        style={{ marginBottom: 18 }}
      />

      {error ? (
        <div className="inv-alert inv-alert--error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      ) : null}
    </BottomSheet>
  );
}
