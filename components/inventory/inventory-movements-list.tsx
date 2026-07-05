import {
  getMovementReasonLabel,
  getMovementTypeLabel,
} from "@/lib/inventory/inventory-labels";

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

function getMovementStyle(type: string) {
  if (type === "IN") {
    return {
      color: "var(--inv-success)",
      background: "var(--inv-success-bg)",
      sign: "+",
      label: "הוספה",
    };
  }

  if (type === "OUT") {
    return {
      color: "var(--inv-danger)",
      background: "var(--inv-danger-bg)",
      sign: "−",
      label: "הפחתה",
    };
  }

  return {
    color: "var(--inv-text-muted)",
    background: "var(--inv-surface-2)",
    sign: "",
    label: getMovementTypeLabel(type),
  };
}

function formatDate(date: string) {
  try {
    return new Date(date).toLocaleString("he-IL");
  } catch {
    return date;
  }
}

export default function InventoryMovementsList({ movements }: Props) {
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
        אין תנועות עדיין
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
        const style = getMovementStyle(m.movementType);

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
              סיבה: <strong>{getMovementReasonLabel(m.reason)}</strong>
            </div>

            <div style={{ color: "var(--inv-text-muted)" }}>
              לפני: {m.quantityBefore} → אחרי:{" "}
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
                הערה: {m.note}
              </div>
            )}

            <div
              style={{
                fontSize: "11px",
                color: "var(--inv-text-muted)",
                marginTop: "4px",
              }}
            >
              {formatDate(m.createdAt)}
            </div>
          </div>
        );
      })}
    </div>
  );
}