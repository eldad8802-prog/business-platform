"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/ui/page-header";
import {
  createInventorySale,
  getInventoryItems,
  InventoryItemDTO,
} from "@/lib/api/inventory";

type SaleLine = {
  localId: string;
  itemId: string;
  quantity: string;
};

function createEmptyLine(): SaleLine {
  return {
    localId: crypto.randomUUID(),
    itemId: "",
    quantity: "1",
  };
}

export default function CreateInventorySalePage() {
  const router = useRouter();

  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [lines, setLines] = useState<SaleLine[]>([createEmptyLine()]);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [successText, setSuccessText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const itemById = useMemo(() => {
    const map = new Map<number, InventoryItemDTO>();

    for (const item of items) {
      map.set(item.id, item);
    }

    return map;
  }, [items]);

  useEffect(() => {
    loadItems();
  }, []);

  async function loadItems() {
    try {
      setLoading(true);
      setError(null);

      const data = await getInventoryItems();
      setItems(Array.isArray(data) ? data : []);
    } catch (err: any) {
      if (err?.message === "UNAUTHORIZED") {
        setError("אין הרשאה לטעון מוצרים. צריך להתחבר מחדש.");
      } else {
        setError(err?.message || "שגיאה בטעינת המוצרים");
      }
    } finally {
      setLoading(false);
    }
  }

  function updateLine(localId: string, field: "itemId" | "quantity", value: string) {
    setError(null);
    setSuccessText(null);

    setLines((current) =>
      current.map((line) =>
        line.localId === localId ? { ...line, [field]: value } : line
      )
    );
  }

  function addLine() {
    setError(null);
    setSuccessText(null);
    setLines((current) => [...current, createEmptyLine()]);
  }

  function removeLine(localId: string) {
    setError(null);
    setSuccessText(null);

    setLines((current) => {
      if (current.length === 1) {
        return current;
      }

      return current.filter((line) => line.localId !== localId);
    });
  }

  function validateSaleLines() {
    const normalized = lines.map((line) => {
      const itemId = Number(line.itemId);
      const quantity = Number(line.quantity);

      if (!itemId || Number.isNaN(itemId)) {
        throw new Error("יש לבחור מוצר בכל שורה");
      }

      if (!quantity || Number.isNaN(quantity) || quantity <= 0) {
        throw new Error("יש להזין כמות תקינה בכל שורה");
      }

      const item = itemById.get(itemId);

      if (!item) {
        throw new Error("אחד המוצרים שנבחרו לא נמצא");
      }

      return {
        itemId,
        quantity,
        item,
      };
    });

    const quantityByItemId = new Map<number, number>();

    for (const line of normalized) {
      quantityByItemId.set(
        line.itemId,
        (quantityByItemId.get(line.itemId) || 0) + line.quantity
      );
    }

    for (const [itemId, totalQuantity] of quantityByItemId.entries()) {
      const item = itemById.get(itemId);

      if (!item) {
        throw new Error("אחד המוצרים שנבחרו לא נמצא");
      }

      if (item.currentQuantity < totalQuantity) {
        throw new Error(`אין מספיק מלאי עבור ${item.name}`);
      }
    }

    return normalized.map((line) => ({
      itemId: line.itemId,
      quantity: line.quantity,
    }));
  }

  async function handleSubmit() {
    if (saving) return;

    try {
      setSaving(true);
      setError(null);
      setSuccessText(null);

      const saleItems = validateSaleLines();

      await createInventorySale({
        items: saleItems,
        note: note.trim() ? note.trim() : undefined,
      });

      setSuccessText("המכירה נשמרה והמלאי עודכן");
      router.push("/inventory");
    } catch (err: any) {
      setError(err?.message || "שגיאה בשמירת המכירה");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <PageHeader title="רישום מכירה" />

      <main
        style={{
          maxWidth: "720px",
          margin: "0 auto",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: "22px",
            background: "#ffffff",
            padding: "18px",
            boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
          }}
        >
          <h1
            style={{
              fontSize: "20px",
              fontWeight: 800,
              color: "#111827",
              margin: 0,
              marginBottom: "6px",
            }}
          >
            רישום מכירה
          </h1>

          <p
            style={{
              fontSize: "14px",
              lineHeight: 1.6,
              color: "#6b7280",
              margin: 0,
            }}
          >
            כאן אפשר לרשום פריטים שנמכרו ולעדכן את המלאי אוטומטית דרך תנועת
            מלאי מסודרת.
          </p>
        </section>

        {loading ? (
          <section
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: "18px",
              background: "#ffffff",
              padding: "28px",
              textAlign: "center",
              color: "#6b7280",
              boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
            }}
          >
            טוען מוצרים...
          </section>
        ) : items.length === 0 ? (
          <section
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: "18px",
              background: "#ffffff",
              padding: "28px",
              textAlign: "center",
              color: "#6b7280",
              boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
            }}
          >
            אין עדיין מוצרים במלאי. צריך ליצור פריט לפני רישום מכירה.
          </section>
        ) : (
          <section
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: "18px",
              background: "#ffffff",
              padding: "18px",
              boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
              display: "flex",
              flexDirection: "column",
              gap: "14px",
            }}
          >
            <div
              style={{
                fontSize: "16px",
                fontWeight: 800,
                color: "#111827",
              }}
            >
              פריטים שנמכרו
            </div>

            {lines.map((line, index) => {
              const selectedItem = line.itemId ? itemById.get(Number(line.itemId)) : null;

              return (
                <div
                  key={line.localId}
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: "14px",
                    padding: "12px",
                    background: "#f8fafc",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "10px",
                      alignItems: "center",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "14px",
                        fontWeight: 800,
                        color: "#111827",
                      }}
                    >
                      שורה {index + 1}
                    </div>

                    {lines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeLine(line.localId)}
                        disabled={saving}
                        style={{
                          border: "1px solid #fecaca",
                          background: "#fef2f2",
                          color: "#991b1b",
                          borderRadius: "10px",
                          padding: "7px 10px",
                          cursor: saving ? "not-allowed" : "pointer",
                          fontSize: "12px",
                          fontWeight: 700,
                        }}
                      >
                        הסרה
                      </button>
                    )}
                  </div>

                  <div>
                    <label
                      style={{
                        display: "block",
                        marginBottom: "6px",
                        fontSize: "13px",
                        fontWeight: 700,
                        color: "#111827",
                      }}
                    >
                      מוצר
                    </label>

                    <select
                      value={line.itemId}
                      disabled={saving}
                      onChange={(e) =>
                        updateLine(line.localId, "itemId", e.target.value)
                      }
                      style={{
                        width: "100%",
                        minHeight: "46px",
                        padding: "10px 12px",
                        borderRadius: "12px",
                        border: "1px solid #d1d5db",
                        fontSize: "14px",
                        background: saving ? "#f9fafb" : "#ffffff",
                        boxSizing: "border-box",
                      }}
                    >
                      <option value="">בחירת מוצר</option>
                      {items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} — במלאי: {item.currentQuantity}
                        </option>
                      ))}
                    </select>

                    {selectedItem && (
                      <div
                        style={{
                          marginTop: "6px",
                          fontSize: "12px",
                          color: "#6b7280",
                        }}
                      >
                        כמות זמינה: {selectedItem.currentQuantity}
                      </div>
                    )}
                  </div>

                  <div>
                    <label
                      style={{
                        display: "block",
                        marginBottom: "6px",
                        fontSize: "13px",
                        fontWeight: 700,
                        color: "#111827",
                      }}
                    >
                      כמות שנמכרה
                    </label>

                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={line.quantity}
                      disabled={saving}
                      onChange={(e) =>
                        updateLine(line.localId, "quantity", e.target.value)
                      }
                      style={{
                        width: "100%",
                        minHeight: "46px",
                        padding: "10px 12px",
                        borderRadius: "12px",
                        border: "1px solid #d1d5db",
                        fontSize: "14px",
                        background: saving ? "#f9fafb" : "#ffffff",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                </div>
              );
            })}

            <button
              type="button"
              onClick={addLine}
              disabled={saving}
              style={{
                width: "100%",
                minHeight: "44px",
                padding: "10px 14px",
                borderRadius: "12px",
                background: "#ffffff",
                color: "#111827",
                border: "1px solid #d1d5db",
                cursor: saving ? "not-allowed" : "pointer",
                fontSize: "14px",
                fontWeight: 800,
              }}
            >
              + הוספת מוצר נוסף למכירה
            </button>

            <div>
              <label
                style={{
                  display: "block",
                  marginBottom: "6px",
                  fontSize: "13px",
                  fontWeight: 700,
                  color: "#111827",
                }}
              >
                הערה
              </label>

              <input
                type="text"
                value={note}
                disabled={saving}
                onChange={(e) => {
                  setNote(e.target.value);
                  setError(null);
                  setSuccessText(null);
                }}
                placeholder="לא חובה"
                style={{
                  width: "100%",
                  minHeight: "46px",
                  padding: "10px 12px",
                  borderRadius: "12px",
                  border: "1px solid #d1d5db",
                  fontSize: "14px",
                  background: saving ? "#f9fafb" : "#ffffff",
                  boxSizing: "border-box",
                }}
              />
            </div>

            {error && (
              <div
                style={{
                  color: "#b91c1c",
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  borderRadius: "12px",
                  padding: "10px 12px",
                  fontSize: "13px",
                  lineHeight: 1.5,
                }}
              >
                {error}
              </div>
            )}

            {successText && (
              <div
                style={{
                  color: "#166534",
                  background: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                  borderRadius: "12px",
                  padding: "10px 12px",
                  fontSize: "13px",
                  lineHeight: 1.5,
                }}
              >
                {successText}
              </div>
            )}

            <button
              type="button"
              onClick={handleSubmit}
              disabled={saving}
              style={{
                width: "100%",
                minHeight: "50px",
                padding: "12px 16px",
                borderRadius: "15px",
                background: "#059669",
                color: "#ffffff",
                border: "none",
                cursor: saving ? "not-allowed" : "pointer",
                opacity: saving ? 0.75 : 1,
                fontSize: "15px",
                fontWeight: 800,
                boxShadow: "0 8px 20px rgba(5, 150, 105, 0.12)",
              }}
            >
              {saving ? "שומר/ת מכירה..." : "שמירת מכירה ועדכון מלאי"}
            </button>
          </section>
        )}
      </main>
    </div>
  );
}