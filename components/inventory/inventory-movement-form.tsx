"use client";

import { useState } from "react";
import { dangerActionStyle, glassActionStyle, primaryActionStyle } from "@/components/inventory/inventory-tokens";
import { createInventoryMovement } from "@/lib/api/inventory";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";

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
  label: MessageKey;
};

const IN_REASONS: ReasonOption[] = [
  { value: "INITIAL_STOCK", label: "customers.inventoryKit.reasons.initialStock" },
  { value: "MANUAL_ADD", label: "customers.inventoryKit.reasons.manualAdd" },
  { value: "RETURN", label: "customers.inventoryKit.reasons.return" },
  { value: "INVENTORY_COUNT_CORRECTION", label: "customers.inventoryKit.reasons.countFix" },
];

const OUT_REASONS: ReasonOption[] = [
  { value: "MANUAL_REMOVE", label: "customers.inventoryKit.reasons.manualRemove" },
  { value: "SALE", label: "customers.inventoryKit.reasons.sale" },
  { value: "DAMAGE", label: "customers.inventoryKit.reasons.damageShort" },
  { value: "INVENTORY_COUNT_CORRECTION", label: "customers.inventoryKit.reasons.countFix" },
];

export default function InventoryMovementForm({ itemId, onSuccess }: Props) {
  const { t } = useI18n();
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
      setError(t("customers.inventoryKit.movement.quantityRequired"));
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
      setSuccessText(t("customers.inventoryKit.movement.savedAndUpdated"));

      await onSuccess();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("customers.inventoryKit.movement.updateError"));
      setSuccessText(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section
      style={{
        border: "1px solid var(--inv-border)",
        borderRadius: "16px",
        background: "var(--inv-card-bg)",
        padding: "18px",
        boxShadow: "var(--inv-shadow)",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "6px", fontSize: "16px", color: "var(--inv-text)" }}>
        {t("customers.inventoryKit.movement.updateTitle")}
      </div>

      <div style={{ fontSize: "13px", color: "var(--inv-text-muted)", lineHeight: 1.5, marginBottom: "14px" }}>
        {t("customers.inventoryKit.movement.formIntro")}
      </div>

      <div style={{ display: "flex", gap: "8px", marginBottom: "14px" }}>
        <button
          type="button"
          disabled={loading}
          onClick={() => handleMovementTypeChange("IN")}
          style={{
            ...(movementType === "IN"
              ? primaryActionStyle({ disabled: loading, height: 44 })
              : glassActionStyle({ disabled: loading, height: 44 })),
            flex: 1,
            minHeight: "44px",
            padding: "9px 12px",
            fontWeight: 600,
          }}
        >
          {t("customers.inventoryKit.movement.addTitle")}
        </button>

        <button
          type="button"
          disabled={loading}
          onClick={() => handleMovementTypeChange("OUT")}
          style={{
            ...(movementType === "OUT"
              ? dangerActionStyle({ disabled: loading, height: 44 })
              : glassActionStyle({ disabled: loading, height: 44 })),
            flex: 1,
            minHeight: "44px",
            padding: "9px 12px",
            fontWeight: 600,
          }}
        >
          {t("customers.inventoryKit.movement.removeTitle")}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div>
          <label htmlFor="inventory-movement-quantity" style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600, color: "var(--inv-text)" }}>
            {t("customers.inventoryKit.movement.quantity")}
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
            placeholder={t("customers.inventoryKit.movement.quantity")}
            style={{
              width: "100%",
              minHeight: "46px",
              padding: "10px 12px",
              borderRadius: "12px",
              border: "1px solid var(--inv-border)",
              fontSize: "14px",
              background: loading ? "var(--inv-surface-2)" : "var(--inv-card-bg)",
              boxSizing: "border-box",
            }}
          />
        </div>

        <div>
          <label htmlFor="inventory-movement-reason" style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600, color: "var(--inv-text)" }}>
            {t("customers.inventoryKit.movement.reason")}
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
              border: "1px solid var(--inv-border)",
              fontSize: "14px",
              background: loading ? "var(--inv-surface-2)" : "var(--inv-card-bg)",
              boxSizing: "border-box",
            }}
          >
            {availableReasons.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="inventory-movement-note" style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600, color: "var(--inv-text)" }}>
            {t("customers.inventoryKit.movement.note")}
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
            placeholder={t("customers.inventoryKit.movement.optionalNote")}
            style={{
              width: "100%",
              minHeight: "46px",
              padding: "10px 12px",
              borderRadius: "12px",
              border: "1px solid var(--inv-border)",
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

        {successText && (
          <div style={{ color: "var(--inv-success)", background: "var(--inv-success-bg)", border: "1px solid var(--inv-success-border)", borderRadius: "12px", padding: "10px 12px", fontSize: "13px", lineHeight: 1.5 }}>
            {successText}
          </div>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={loading}
          style={{
            ...primaryActionStyle({ disabled: loading, fullWidth: true, height: 46 }),
            width: "100%",
            minHeight: "46px",
            padding: "10px 14px",
            fontSize: "14px",
            fontWeight: 600,
          }}
        >
          {loading ? t("customers.inventoryKit.movement.savingSlash") : t("customers.inventoryKit.movement.updateCta")}
        </button>
      </div>
    </section>
  );
}
