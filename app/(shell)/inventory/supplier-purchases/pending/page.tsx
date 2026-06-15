"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getInventoryItems } from "@/lib/api/inventory";
import { InventorySubPage } from "@/components/inventory/inventory-shell";

type Item = {
  id: number;
  name: string;
  currentQuantity: number;
};

type DraftLine = {
  id: number;
  rawName: string | null;
  quantity: number;
  unitType: string | null;
  matchedItemId: number | null;
};

type Draft = {
  id: number;
  supplierName: string | null;
  externalOrderId?: string | null;
  status: string;
  lines: DraftLine[];
};

type LineDecision =
  | { action: "MERGE"; itemId: number | "" }
  | { action: "CREATE_NEW"; name: string; unitType: string };

function buildHeaders() {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export default function PendingSupplierPurchasesPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [decisions, setDecisions] = useState<Record<number, LineDecision>>({});
  const [openId, setOpenId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const summary = useMemo(() => {
    return {
      totalOrders: drafts.length,
      totalLines: drafts.reduce((sum, draft) => sum + draft.lines.length, 0),
      totalUnits: drafts.reduce(
        (sum, draft) =>
          sum +
          draft.lines.reduce((lineSum, line) => lineSum + line.quantity, 0),
        0
      ),
    };
  }, [drafts]);

  async function load() {
    try {
      setLoading(true);
      setError(null);

      const draftsResponse = await fetch("/api/inventory/supplier-purchases", {
        method: "GET",
        headers: buildHeaders(),
        cache: "no-store",
      });

      const draftsData = await draftsResponse.json().catch(() => null);

      if (!draftsResponse.ok) {
        throw new Error(draftsData?.error || "לא הצלחנו לטעון הזמנות");
      }

      const pendingDrafts = Array.isArray(draftsData?.drafts)
        ? draftsData.drafts.filter(
            (draft: Draft) => draft.status === "PENDING_REVIEW"
          )
        : [];

      setDrafts(pendingDrafts);

      try {
        const itemsData = await getInventoryItems();
        setItems(Array.isArray(itemsData) ? itemsData : []);
      } catch (itemsError) {
        console.warn(
          "Failed loading inventory items for supplier purchases:",
          itemsError
        );
        setItems([]);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "שגיאה בטעינת הזמנות");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, []);

  function openDraft(draft: Draft) {
    setOpenId((current) => (current === draft.id ? null : draft.id));

    const nextDecisions: Record<number, LineDecision> = {};

    draft.lines.forEach((line) => {
      const matchedByStoredId = line.matchedItemId
        ? items.find((item) => item.id === line.matchedItemId)
        : null;

      const matchedByName = items.find(
        (item) =>
          line.rawName &&
          item.name.trim().toLowerCase() === line.rawName.trim().toLowerCase()
      );

      const matchedItem = matchedByStoredId || matchedByName;

      if (matchedItem) {
        nextDecisions[line.id] = {
          action: "MERGE",
          itemId: matchedItem.id,
        };
      } else {
        nextDecisions[line.id] = {
          action: "CREATE_NEW",
          name: line.rawName || "",
          unitType: line.unitType || "UNIT",
        };
      }
    });

    setDecisions((prev) => ({
      ...prev,
      ...nextDecisions,
    }));
  }

  function updateDecision(lineId: number, decision: LineDecision) {
    setDecisions((prev) => ({
      ...prev,
      [lineId]: decision,
    }));
  }

  async function approveDraft(draft: Draft) {
    try {
      setActionLoading(true);
      setError(null);
      setSuccess(null);

      const lines = draft.lines.map((line) => {
        const decision = decisions[line.id];

        if (!decision) {
          throw new Error(`צריך לבחור פעולה עבור ${line.rawName || "שורה"}`);
        }

        if (decision.action === "MERGE") {
          if (!decision.itemId) {
            throw new Error(
              `צריך לבחור מוצר קיים עבור ${line.rawName || "שורה"}`
            );
          }

          return {
            lineId: line.id,
            action: "MERGE",
            itemId: Number(decision.itemId),
          };
        }

        if (!decision.name.trim()) {
          throw new Error(
            `צריך להזין שם מוצר חדש עבור ${line.rawName || "שורה"}`
          );
        }

        return {
          lineId: line.id,
          action: "CREATE_NEW",
          itemData: {
            name: decision.name.trim(),
            unitType: decision.unitType || "UNIT",
            sku: null,
            barcode: null,
          },
        };
      });

      const response = await fetch(
        `/api/inventory/supplier-purchases/${draft.id}/approve`,
        {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify({ lines }),
        }
      );

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || "לא הצלחנו לאשר קליטת סחורה");
      }

      setSuccess("קליטת הסחורה אושרה והמלאי עודכן.");
      setOpenId(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "שגיאה באישור קליטה");
    } finally {
      setActionLoading(false);
    }
  }

  async function rejectDraft(draftId: number) {
    try {
      setActionLoading(true);
      setError(null);
      setSuccess(null);

      const response = await fetch(
        `/api/inventory/supplier-purchases/${draftId}/reject`,
        {
          method: "POST",
          headers: buildHeaders(),
        }
      );

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || "לא הצלחנו לבטל את ההזמנה");
      }

      setSuccess("ההזמנה בוטלה ללא שינוי במלאי.");
      setOpenId(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "שגיאה בביטול ההזמנה");
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <InventorySubPage
      title="קליטת הזמנות"
      backHref="/inventory/supplier-purchases"
      backLabel="מרכז הזמנות ספק"
      bottomNav="orders"
    >
      <div className="inv-screen-stack">
        <section className="inv-hero-card inv-hero-card--green">
          <span className="inv-kicker">קליטה למלאי</span>
          <h1>
            {summary.totalOrders > 0
              ? `${summary.totalOrders} הזמנות ממתינות`
              : "אין הזמנות לקליטה"}
          </h1>
          <p>
            קליטה מאשרת מה הגיע בפועל. רק אישור קליטה מעדכן את המלאי.
          </p>
        </section>

        <section className="inv-surface-card">
          <div className="inv-mini-stepper" aria-label="רצף הזמנה">
            {["יצירה", "שליחה", "קליטה", "היסטוריה"].map((label, index) => (
              <span
                key={label}
                className={`inv-mini-step${
                  index === 2 ? " is-current" : index < 2 ? " is-done" : ""
                }`}
              >
                {label}
              </span>
            ))}
          </div>
        </section>

        {error ? <div className="inv-alert inv-alert--error">{error}</div> : null}
        {success ? (
          <div className="inv-alert inv-alert--success">{success}</div>
        ) : null}

        {loading ? (
          <section className="inv-surface-card inv-center-state" aria-busy="true">
            טוען הזמנות ממתינות...
          </section>
        ) : drafts.length === 0 ? (
          <section className="inv-surface-card inv-center-state">
            <strong>הכול מטופל</strong>
            <p>אין כרגע הזמנות שממתינות לקליטת סחורה.</p>
            <Link
              href="/inventory/supplier-purchases/new"
              className="inv-primary-button"
            >
              יצירת הזמנה חדשה
            </Link>
          </section>
        ) : (
          <section className="inv-screen-stack" aria-label="הזמנות לקליטה">
            {drafts.map((draft) => {
              const isOpen = openId === draft.id;
              const totalUnits = draft.lines.reduce(
                (sum, line) => sum + line.quantity,
                0
              );

              return (
                <article key={draft.id} className="inv-surface-card">
                  <div className="inv-row-card-head">
                    <div>
                      <span className="inv-status-pill">ממתינה לקליטה</span>
                      <h2>{draft.supplierName || "הזמנה ללא ספק"}</h2>
                      <p>
                        #{draft.id} · {draft.lines.length} פריטים ·{" "}
                        {totalUnits} יחידות
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => openDraft(draft)}
                      className="inv-secondary-button"
                    >
                      {isOpen ? "סגור" : "בדיקה"}
                    </button>
                  </div>

                  {isOpen ? (
                    <div className="inv-receive-panel">
                      <div className="inv-section-heading">
                        <h2>מה הגיע?</h2>
                        <span>התאימו כל שורה למלאי</span>
                      </div>
                      <div className="inv-screen-stack">
                        {draft.lines.map((line) => {
                          const decision = decisions[line.id];
                          return (
                            <div key={line.id} className="inv-receive-line">
                              <div>
                                <strong>{line.rawName || "מוצר ללא שם"}</strong>
                                <span>
                                  {line.quantity} {line.unitType || "UNIT"}
                                </span>
                              </div>
                              <div className="inv-receive-line__controls">
                                <select
                                  className="inv-field-select"
                                  value={decision?.action || "CREATE_NEW"}
                                  onChange={(event) => {
                                    if (event.target.value === "MERGE") {
                                      updateDecision(line.id, {
                                        action: "MERGE",
                                        itemId: line.matchedItemId || "",
                                      });
                                    } else {
                                      updateDecision(line.id, {
                                        action: "CREATE_NEW",
                                        name: line.rawName || "",
                                        unitType: line.unitType || "UNIT",
                                      });
                                    }
                                  }}
                                >
                                  <option value="MERGE">שיוך למוצר קיים</option>
                                  <option value="CREATE_NEW">
                                    יצירת מוצר חדש
                                  </option>
                                </select>

                                {decision?.action === "MERGE" ? (
                                  <select
                                    className="inv-field-select"
                                    value={decision.itemId || ""}
                                    onChange={(event) =>
                                      updateDecision(line.id, {
                                        action: "MERGE",
                                        itemId: Number(event.target.value),
                                      })
                                    }
                                  >
                                    <option value="">בחרו מוצר קיים</option>
                                    {items.map((item) => (
                                      <option key={item.id} value={item.id}>
                                        {item.name} · במלאי:{" "}
                                        {item.currentQuantity}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    className="inv-field-input"
                                    value={decision?.name || line.rawName || ""}
                                    onChange={(event) =>
                                      updateDecision(line.id, {
                                        action: "CREATE_NEW",
                                        name: event.target.value,
                                        unitType:
                                          decision?.action === "CREATE_NEW"
                                            ? decision.unitType
                                            : line.unitType || "UNIT",
                                      })
                                    }
                                    placeholder="שם מוצר חדש"
                                  />
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div className="inv-receive-impact">
                        אישור יעדכן את המלאי ב-{totalUnits} יחידות ויעביר את
                        ההזמנה להיסטוריה.
                      </div>

                      <div className="inv-action-grid">
                        <button
                          type="button"
                          onClick={() => approveDraft(draft)}
                          disabled={actionLoading}
                          className="inv-primary-button"
                        >
                          אשר קליטה
                        </button>
                        <Link
                          href={`/inventory/supplier-purchases/${draft.id}/send`}
                          className="inv-secondary-button"
                        >
                          חזרה לשליחה
                        </Link>
                        <button
                          type="button"
                          onClick={() => rejectDraft(draft.id)}
                          disabled={actionLoading}
                          className="inv-secondary-button"
                        >
                          בטל הזמנה
                        </button>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </section>
        )}
      </div>
    </InventorySubPage>
  );
}
