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
      color: "#166534",
      background: "#dcfce7",
      sign: "+",
      label: "הוספה",
    };
  }

  if (type === "OUT") {
    return {
      color: "#991b1b",
      background: "#fee2e2",
      sign: "−",
      label: "הפחתה",
    };
  }

  return {
    color: "#374151",
    background: "#f3f4f6",
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
          border: "1px solid #e5e7eb",
          borderRadius: "14px",
          padding: "16px",
          background: "#f9fafb",
          textAlign: "center",
          color: "#6b7280",
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
              border: "1px solid #e5e7eb",
              borderRadius: "14px",
              padding: "12px",
              fontSize: "13px",
              background: "#ffffff",
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
                  fontWeight: 800,
                  color: "#111827",
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
                  fontWeight: 800,
                  fontSize: "12px",
                }}
              >
                {style.sign}
                {m.quantityDelta}
              </div>
            </div>

            {/* פרטים */}
            <div style={{ color: "#374151" }}>
              סיבה: <strong>{getMovementReasonLabel(m.reason)}</strong>
            </div>

            <div style={{ color: "#374151" }}>
              לפני: {m.quantityBefore} → אחרי:{" "}
              <strong>{m.quantityAfter}</strong>
            </div>

            {m.note && (
              <div
                style={{
                  color: "#374151",
                  background: "#f9fafb",
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
                color: "#6b7280",
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