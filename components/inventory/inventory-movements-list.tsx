import {
  getMovementReasonLabel,
  getMovementTypeLabel,
} from "@/lib/inventory/inventory-labels";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag, type Locale } from "@/lib/i18n/config";
import type { Translator } from "@/lib/i18n/translate";

type Movement = {
  id: number;
  movementType: "IN" | "OUT" | string;
  reason: string;
  quantityDelta: number;
  quantityBefore: number;
  quantityAfter: number;
  note: string | null;
  createdAt: string;
};

type Props = {
  movements: Movement[];
};

function getMovementStyle(type: string, t: Translator) {
  if (type === "IN") {
    return {
      color: "var(--inv-success)",
      background: "var(--inv-success-bg)",
      sign: "+",
      label: t("customers.inventoryKit.labels.movementType.in"),
    };
  }

  if (type === "OUT") {
    return {
      color: "var(--inv-danger)",
      background: "var(--inv-danger-bg)",
      sign: "−",
      label: t("customers.inventoryKit.labels.movementType.out"),
    };
  }

  return {
    color: "var(--inv-text-muted)",
    background: "var(--inv-surface-2)",
    sign: "",
    label: getMovementTypeLabel(type, t),
  };
}

function formatDate(date: string, locale: Locale) {
  try {
    return new Date(date).toLocaleString(intlTag(locale));
  } catch {
    return date;
  }
}

export default function InventoryMovementsList({ movements }: Props) {
  const { t, locale } = useI18n();
  if (!movements.length) {
    return (
      <div
        style={{
          marginTop: "16px",
          border: "1px solid var(--inv-border)",
          borderRadius: "14px",
          padding: "16px",
          background: "var(--inv-surface-2)",
          textAlign: "center",
          color: "var(--inv-text-muted)",
          fontSize: "14px",
        }}
      >
        {t("customers.inventoryKit.movements.empty")}
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: "12px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
    >
      {movements.map((m) => {
        const style = getMovementStyle(m.movementType, t);

        return (
          <div
            key={m.id}
            style={{
              border: "1px solid var(--inv-border)",
              borderRadius: "14px",
              padding: "12px",
              fontSize: "13px",
              background: "var(--inv-card-bg)",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
            }}
          >
            {/* כותרת */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "8px",
                flexWrap: "wrap",
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  color: "var(--inv-text)",
                }}
              >
                {style.label}
              </div>

              <div
                style={{
                  padding: "4px 10px",
                  borderRadius: "999px",
                  background: style.background,
                  color: style.color,
                  fontWeight: 600,
                  fontSize: "12px",
                }}
              >
                {style.sign}
                {m.quantityDelta}
              </div>
            </div>

            {/* פרטים */}
            <div style={{ color: "var(--inv-text-muted)" }}>
              {t("customers.inventoryKit.movements.reason")} <strong>{getMovementReasonLabel(m.reason, t)}</strong>
            </div>

            <div style={{ color: "var(--inv-text-muted)" }}>
              {t("customers.inventoryKit.movements.beforeAfter", { before: m.quantityBefore })}{" "}
              <strong>{m.quantityAfter}</strong>
            </div>

            {m.note && (
              <div
                style={{
                  color: "var(--inv-text-muted)",
                  background: "var(--inv-surface-2)",
                  borderRadius: "8px",
                  padding: "6px 8px",
                }}
              >
                {t("customers.inventoryKit.movements.note", { note: m.note })}
              </div>
            )}

            <div
              style={{
                fontSize: "11px",
                color: "var(--inv-text-muted)",
                marginTop: "4px",
              }}
            >
              {formatDate(m.createdAt, locale)}
            </div>
          </div>
        );
      })}
    </div>
  );
}