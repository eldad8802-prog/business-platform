"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
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

function getStockLabel(item: InventoryItemDTO | null) {
  if (!item) return "בחרו מוצר כדי לראות זמינות";
  if (item.currentQuantity <= 0) return "אין מלאי זמין";
  if (item.reorderPoint != null && item.currentQuantity <= item.reorderPoint) {
    return `מלאי נמוך: ${item.currentQuantity}`;
  }
  return `זמין במלאי: ${item.currentQuantity}`;
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

  const selectedCount = lines.filter((line) => line.itemId).length;

  const loadItems = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const data = await getInventoryItems();
      setItems(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "UNAUTHORIZED") {
        setError("אין הרשאה לטעון מוצרים. צריך להתחבר מחדש.");
      } else {
        setError(err instanceof Error ? err.message : "שגיאה בטעינת מוצרים");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadItems();
    });
  }, [loadItems]);

  function updateLine(
    localId: string,
    field: "itemId" | "quantity",
    value: string
  ) {
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "שגיאה בשמירת המכירה");
    } finally {
      setSaving(false);
    }
  }

  return (
    <InventorySubPage
      title="רישום מכירה"
      backHref="/inventory"
      backLabel="טיפול עכשיו"
      bottomNav="sales"
    >
      <div className="inv-screen-stack">
        <section className="inv-hero-card inv-hero-card--purple">
          <span className="inv-kicker">מכירות</span>
          <h1>מה נמכר עכשיו?</h1>
          <p>
            בחרו פריטים וכמויות. השמירה תעדכן את המלאי לפי המכירה שנרשמה.
          </p>
        </section>

        {loading ? (
          <section className="inv-surface-card inv-center-state" aria-busy="true">
            טוען מוצרים...
          </section>
        ) : items.length === 0 ? (
          <section className="inv-surface-card inv-center-state">
            <strong>אין עדיין מוצרים במלאי</strong>
            <p>צריך ליצור פריט לפני רישום מכירה.</p>
            <Link href="/inventory/items/create" className="inv-primary-button">
              הוספת פריט
            </Link>
          </section>
        ) : (
          <>
            <section className="inv-surface-card">
              <div className="inv-section-heading">
                <h2>פריטים שנמכרו</h2>
                <span>
                  {selectedCount > 0
                    ? `${selectedCount} פריטים נבחרו`
                    : "בחרו מוצר ראשון"}
                </span>
              </div>

              <div className="inv-screen-stack">
                {lines.map((line, index) => {
                  const selectedItem = line.itemId
                    ? itemById.get(Number(line.itemId)) ?? null
                    : null;

                  return (
                    <div key={line.localId} className="inv-sale-line">
                      <div className="inv-sale-line__head">
                        <strong>פריט {index + 1}</strong>
                        {lines.length > 1 ? (
                          <button
                            type="button"
                            onClick={() => removeLine(line.localId)}
                            disabled={saving}
                          >
                            הסרה
                          </button>
                        ) : null}
                      </div>

                      <label>
                        <span className="inv-field-label">מוצר</span>
                        <select
                          value={line.itemId}
                          disabled={saving}
                          onChange={(e) =>
                            updateLine(line.localId, "itemId", e.target.value)
                          }
                          className="inv-field-select"
                        >
                          <option value="">בחירת מוצר</option>
                          {items.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name} · במלאי {item.currentQuantity}
                            </option>
                          ))}
                        </select>
                      </label>

                      <div className="inv-sale-line__stock">
                        {getStockLabel(selectedItem)}
                      </div>

                      <label>
                        <span className="inv-field-label">כמות שנמכרה</span>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={line.quantity}
                          disabled={saving}
                          onChange={(e) =>
                            updateLine(line.localId, "quantity", e.target.value)
                          }
                          className="inv-field-input"
                        />
                      </label>
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={addLine}
                disabled={saving}
                className="inv-secondary-button"
              >
                הוספת מוצר נוסף
              </button>
            </section>

            <section className="inv-surface-card">
              <label>
                <span className="inv-field-label">הערה</span>
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
                  className="inv-field-input"
                />
              </label>
            </section>

            {error ? <div className="inv-alert inv-alert--error">{error}</div> : null}
            {successText ? (
              <div className="inv-alert inv-alert--success">{successText}</div>
            ) : null}

            <button
              type="button"
              onClick={handleSubmit}
              disabled={saving}
              className="inv-primary-button"
            >
              {saving ? "שומר מכירה..." : "שמירת מכירה ועדכון מלאי"}
            </button>
          </>
        )}
      </div>
    </InventorySubPage>
  );
}
