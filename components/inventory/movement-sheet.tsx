"use client";

/**
 * Movement sheet — owner-approved redesign mockup "עדכון מלאי" (2026-11-03).
 * Segmented type (IN/OUT/ADJUSTMENT), product card, quantity, reason, note and a
 * before → after preview. Delta-based: the inventory service computes
 * quantityAfter = quantityBefore + quantityDelta, so all three types submit a
 * non-zero quantityDelta — the payload is unchanged.
 *
 * Rendered through the kit's InvSheet, which portals to <body> (above the app's
 * bottom bar and the accessibility button) and lifts itself above an on-screen
 * keyboard (keyboardSheetInset).
 */

import { useId, useMemo, useState } from "react";
import { createInventoryMovement } from "@/lib/api/inventory";
import { useI18n } from "@/components/i18n/I18nProvider";
import { MOVEMENT_REASON_LABEL_KEYS } from "@/lib/inventory/inventory-labels";
import { qtyWithUnit } from "@/lib/inventory/unit-words";
import { I2, InvButton, InvNote, InvQty, InvSegmented, InvSheet, ProductThumb } from "@/components/inventory/v2/kit";

export type MovementKind = "IN" | "OUT" | "ADJUSTMENT";

const IN_REASONS = [
  { value: "MANUAL_ADD" },
  { value: "RETURN" },
  { value: "INITIAL_STOCK" },
] as const;

const OUT_REASONS = [
  { value: "MANUAL_REMOVE" },
  { value: "SALE" },
  { value: "DAMAGE" },
] as const;

const QTY_LABEL: Record<MovementKind, string> = {
  IN: "כמות להוספה",
  OUT: "כמות להפחתה",
  ADJUSTMENT: "הכמות שנספרה",
};

const NOT_ENOUGH = "אין מספיק מלאי להפחתה הזו";

/** The server's English message that an owner can actually hit here, in Hebrew. */
function movementErrorText(message: string): string {
  if (/negative inventory is not allowed/i.test(message)) return NOT_ENOUGH;
  return message;
}

export default function MovementSheet({
  itemId,
  itemName,
  imageUrl,
  currentQuantity,
  unitType,
  initialType = "IN",
  onClose,
  onSuccess,
}: {
  itemId: number;
  itemName: string;
  imageUrl?: string | null;
  currentQuantity: number;
  unitType: string;
  initialType?: MovementKind;
  onClose: () => void;
  onSuccess: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const ids = useId();
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

  const invalid = delta === 0 || after < 0;

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
      onClose();
    } catch (err) {
      setError(err instanceof Error ? movementErrorText(err.message) : t("customers.inventoryKit.movement.saveError"));
    } finally {
      setLoading(false);
    }
  }

  const reasons = kind === "OUT" ? OUT_REASONS : IN_REASONS;
  const reasonId = `${ids}-reason`;
  const noteId = `${ids}-note`;

  return (
    <InvSheet
      title="עדכון מלאי"
      onClose={onClose}
      footer={
        <>
          {error ? <InvNote tone="danger">{error}</InvNote> : null}
          <div className="i2-actions">
            <InvButton onClick={() => void handleConfirm()} disabled={loading || invalid}>
              {loading ? t("customers.inventoryKit.movement.saving") : "אישור עדכון"}
            </InvButton>
            <InvButton kind="secondary" onClick={onClose} disabled={loading}>
              ביטול
            </InvButton>
          </div>
        </>
      }
    >
      <InvSegmented<MovementKind>
        value={kind}
        onChange={changeKind}
        label="סוג העדכון"
        options={[
          { value: "IN", label: "הוספה" },
          { value: "OUT", label: "הפחתה" },
          { value: "ADJUSTMENT", label: "תיקון ספירה" },
        ]}
      />

      <div className="i2-card" style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 14 }}>
        <ProductThumb src={imageUrl} name={itemName} size={64} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="i2-row__title">
            <span>{itemName}</span>
          </div>
          <div className="i2-muted" style={{ fontSize: 14.5, marginTop: 2 }}>
            כמות נוכחית: <bdi>{qtyWithUnit(currentQuantity, unitType)}</bdi>
          </div>
        </div>
      </div>

      <div className="i2-field i2-field--stack" style={{ marginTop: 14 }}>
        <span className="i2-field__lab">{QTY_LABEL[kind]}</span>
        <InvQty value={value} onChange={setValue} min={min} size="lg" label={QTY_LABEL[kind]} disabled={loading} />
      </div>

      {kind !== "ADJUSTMENT" ? (
        <div className="i2-field i2-field--stack">
          <label className="i2-field__lab" htmlFor={reasonId}>
            סיבה
          </label>
          <select id={reasonId} className="i2-select" value={reason} onChange={(e) => setReason(e.target.value)} disabled={loading}>
            {reasons.map((r) => (
              <option key={r.value} value={r.value}>
                {t(MOVEMENT_REASON_LABEL_KEYS[r.value])}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="i2-field i2-field--stack">
        <label className="i2-field__lab" htmlFor={noteId}>
          הערה <span className="i2-field__opt">(אופציונלי)</span>
        </label>
        <textarea id={noteId} className="i2-textarea" placeholder="הוספת הערה..." value={note} onChange={(e) => setNote(e.target.value)} rows={2} disabled={loading} />
      </div>

      <div className="i2-box i2-split i2-split--arrow" style={{ marginTop: 6 }} aria-live="polite">
        <div>
          <small>כמות נוכחית</small>
          <b className="i2-num">
            <bdi>{qtyWithUnit(currentQuantity, unitType)}</bdi>
          </b>
        </div>
        <span className="i2-split__arrow" aria-hidden>
          {I2.arrowLeft(22)}
        </span>
        <div>
          <small>כמות לאחר העדכון</small>
          <b className="i2-num">
            <bdi>{qtyWithUnit(after, unitType)}</bdi>
          </b>
        </div>
      </div>

      {after < 0 ? <InvNote tone="warn">{NOT_ENOUGH}</InvNote> : null}
      {kind === "ADJUSTMENT" ? <InvNote>תיקון ספירה מעדכן לפי הכמות שנספרה</InvNote> : null}
    </InvSheet>
  );
}
