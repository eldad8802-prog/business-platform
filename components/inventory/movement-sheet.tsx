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
import { useI18n } from "@/components/i18n/I18nProvider";
import { MOVEMENT_REASON_LABEL_KEYS } from "@/lib/inventory/inventory-labels";

type MovementKind = "IN" | "OUT" | "ADJUSTMENT";

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
  const { t } = useI18n();
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
      setError(err instanceof Error ? err.message : t("customers.inventoryKit.movement.saveError"));
    } finally {
      setLoading(false);
    }
  }

  const reasons = kind === "OUT" ? OUT_REASONS : IN_REASONS;

  return (
    <BottomSheet
      title={t("customers.inventoryKit.movement.updateTitle")}
      who={
        <>
          {itemName} · {t("customers.inventoryKit.movement.currentStock")} <bdi>{currentQuantity}{unit}</bdi>
        </>
      }
      onClose={onClose}
      footer={
        <SheetActions
          confirmLabel={loading ? t("customers.inventoryKit.movement.saving") : t("customers.inventoryKit.movement.confirmUpdate")}
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
          { value: "IN", label: t("customers.inventoryKit.labels.movementType.in") },
          { value: "OUT", label: t("customers.inventoryKit.labels.movementType.out") },
          { value: "ADJUSTMENT", label: t("customers.inventoryKit.reasons.countFix") },
        ]}
        style={{ marginBottom: 16 }}
      />

      {kind !== "ADJUSTMENT" ? (
        <>
          <div className="inv-field__lab">{t("customers.inventoryKit.movement.reason")}</div>
          <select
            className="inv-input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{ marginBottom: 6 }}
          >
            {reasons.map((r) => (
              <option key={r.value} value={r.value}>
                {t(MOVEMENT_REASON_LABEL_KEYS[r.value])}
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
        {t("customers.inventoryKit.movement.afterUpdate")}{" "}
        <b>
          <bdi>{currentQuantity}</bdi> {t("customers.inventoryKit.movement.arrow")} <bdi>{after}{unit}</bdi>
        </b>
      </div>

      <input
        className="inv-input"
        placeholder={t("customers.inventoryKit.movement.noteOptional")}
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
