"use client";

import { useEffect, useMemo, useState } from "react";
import {
  InventorySubheader,
  NoticeBanner,
  PageIntro,
  inventoryCardStyle,
  inventoryMainStyle,
  inventoryPageStyle,
} from "@/components/inventory/inventory-design";
import { getInventoryItems } from "@/lib/api/inventory";
import {
  buildSupplierOrderText,
  downloadSupplierPurchaseOrderPdf,
  openWhatsAppWithSupplierOrderText,
} from "@/lib/services/inventory/supplier-purchase-document.service";

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
  orderDate?: string | null;
  status: string;
  createdAt?: string;
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
  const [dispatchDraft, setDispatchDraft] = useState<Draft | null>(null);

  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const supplierOrderText = dispatchDraft
    ? buildSupplierOrderText(dispatchDraft)
    : "";

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
        console.warn("Failed loading inventory items for supplier purchases:", itemsError);
        setItems([]);
      }
    } catch (err: any) {
      setError(err?.message || "שגיאה בטעינת הזמנות ממתינות");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
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

  async function copySupplierOrderText() {
    if (!supplierOrderText) return;

    try {
      await navigator.clipboard.writeText(supplierOrderText);
      setSuccess("טקסט ההזמנה הועתק ואפשר לשלוח אותו לספק.");
      setError(null);
    } catch {
      setError("לא הצלחנו להעתיק את טקסט ההזמנה");
    }
  }

  function openWhatsAppWithOrderText() {
    if (!supplierOrderText) return;
    openWhatsAppWithSupplierOrderText(supplierOrderText);
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
        throw new Error(data?.error || "לא הצלחנו לאשר קבלת סחורה");
      }

      setSuccess("קבלת הסחורה אושרה והמלאי עודכן.");
      setOpenId(null);
      setDispatchDraft(null);
      await load();
    } catch (err: any) {
      setError(err?.message || "שגיאה באישור קבלת סחורה");
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
      setDispatchDraft(null);
      await load();
    } catch (err: any) {
      setError(err?.message || "שגיאה בביטול ההזמנה");
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div style={inventoryPageStyle()}>
        <InventorySubheader
          title="הזמנות ממתינות לקליטה"
          backHref="/inventory/supplier-purchases"
        />
        <main style={inventoryMainStyle(980)}>טוען הזמנות ממתינות...</main>
      </div>
    );
  }

  return (
    <div style={inventoryPageStyle()}>
      <InventorySubheader
        title="הזמנות ממתינות לקליטה"
        backHref="/inventory/supplier-purchases"
      />

      <main style={inventoryMainStyle(980)}>
        {error ? <NoticeBanner tone="error">{error}</NoticeBanner> : null}

        {success ? <NoticeBanner tone="success">{success}</NoticeBanner> : null}

        <PageIntro
          stage="קליטת סחורה · Receive"
          title={
            summary.totalOrders > 0
              ? `${summary.totalOrders} הזמנות ממתינות לקליטה`
              : "אין הזמנות שממתינות לקליטה"
          }
          description="כאן אפשר להכין הודעה מסודרת לספק, ולאחר שהסחורה מגיעה בפועל — לאשר קליטה ולעדכן מלאי."
          tone="warning"
          stats={[
            { label: "הזמנות", value: summary.totalOrders },
            { label: "שורות מוצר", value: summary.totalLines },
            { label: "יחידות לקליטה", value: summary.totalUnits },
          ]}
        />
        {drafts.length === 0 ? (
          <section
            style={{
              border: "1px dashed #d1d5db",
              borderRadius: 26,
              background: "#ffffff",
              padding: 26,
              textAlign: "center",
              boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
            }}
          >
            <div style={{ fontSize: 38, marginBottom: 10 }}>✅</div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 950,
                color: "#111827",
                marginBottom: 6,
              }}
            >
              אין כרגע הזמנות שממתינות לקליטה
            </div>
            <div
              style={{
                color: "#6b7280",
                fontSize: 14,
                lineHeight: 1.6,
              }}
            >
              כשנוצרת הזמנה חדשה, היא תופיע כאן עד לאישור קבלת הסחורה.
            </div>
          </section>
        ) : (
          <section
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 26,
              background: "#ffffff",
              padding: 18,
              boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div>
              <h2
                style={{
                  margin: 0,
                  fontSize: 18,
                  fontWeight: 950,
                  color: "#111827",
                }}
              >
                הזמנות שממתינות לקליטת סחורה
              </h2>
              <p
                style={{
                  margin: "6px 0 0",
                  color: "#6b7280",
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              >
                אפשר להכין הודעה לספק, ואז לאחר שהסחורה מגיעה לאשר קליטה
                למלאי.
              </p>
            </div>

            {drafts.map((draft) => {
              const isOpen = openId === draft.id;
              const totalUnits = draft.lines.reduce(
                (sum, line) => sum + line.quantity,
                0
              );

              return (
                <article
                  key={draft.id}
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: 20,
                    padding: 14,
                    background: "#ffffff",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      gap: 12,
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 16,
                            fontWeight: 950,
                            color: "#111827",
                          }}
                        >
                          {draft.supplierName || "הזמנה ללא שם ספק"}
                        </div>

                        <span
                          style={{
                            borderRadius: 999,
                            padding: "5px 9px",
                            background: "#fef3c7",
                            color: "#92400e",
                            fontSize: 11,
                            fontWeight: 950,
                          }}
                        >
                          ממתינה לקליטה
                        </span>
                      </div>

                      <div
                        style={{
                          marginTop: 6,
                          color: "#6b7280",
                          fontSize: 13,
                          lineHeight: 1.5,
                        }}
                      >
                        הזמנה #{draft.id} · {draft.lines.length} פריטים ·{" "}
                        {totalUnits} יחידות
                      </div>

                      {typeof draft.externalOrderId === "string" &&
                      draft.externalOrderId.trim() ? (
                        <div
                          style={{
                            marginTop: 4,
                            color: "#6b7280",
                            fontSize: 13,
                            lineHeight: 1.5,
                          }}
                        >
                          מספר הזמנה חיצוני:{" "}
                          {draft.externalOrderId.trim()}
                        </div>
                      ) : null}
                    </div>

                    <button
                      type="button"
                      onClick={() => openDraft(draft)}
                      style={{
                        minHeight: 42,
                        borderRadius: 14,
                        border: "1px solid #d1d5db",
                        background: isOpen ? "#111827" : "#ffffff",
                        color: "#111827",
                        cursor: "pointer",
                        padding: "0 14px",
                        fontSize: 14,
                        fontWeight: 950,
                        transition: "background 160ms ease, color 160ms ease",
                        ...(isOpen
                          ? { color: "#ffffff", border: "1px solid #111827" }
                          : null),
                      }}
                    >
                      {isOpen ? "סגור" : "בדיקת קבלה"}
                    </button>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateRows: isOpen ? "1fr" : "0fr",
                      transition: "grid-template-rows 180ms ease",
                    }}
                  >
                    <div
                      style={{
                        overflow: "hidden",
                      }}
                    >
                      <section
                        style={{
                          marginTop: 10,
                          border: "1px solid #e5e7eb",
                          borderRadius: 18,
                          background: "#f9fafb",
                          padding: 14,
                          display: "flex",
                          flexDirection: "column",
                          gap: 12,
                          opacity: isOpen ? 1 : 0,
                          transform: isOpen ? "translateY(0)" : "translateY(-2px)",
                          transition:
                            "opacity 160ms ease, transform 160ms ease",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 10,
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 14,
                              fontWeight: 950,
                              color: "#111827",
                            }}
                          >
                            בדיקת קבלה
                          </div>

                          <button
                            type="button"
                            onClick={() => setDispatchDraft(draft)}
                            style={{
                              minHeight: 40,
                              borderRadius: 14,
                              border: "1px solid #d1d5db",
                              background: "#ffffff",
                              color: "#111827",
                              cursor: "pointer",
                              padding: "0 12px",
                              fontSize: 13,
                              fontWeight: 900,
                            }}
                          >
                            הכנת הזמנה לספק
                          </button>
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {draft.lines.map((line) => {
                            const decision = decisions[line.id];

                            return (
                              <div
                                key={line.id}
                                style={{
                                  border: "1px solid #e5e7eb",
                                  borderRadius: 16,
                                  padding: 12,
                                  background: "#ffffff",
                                  display: "grid",
                                  gridTemplateColumns:
                                    "minmax(0, 1fr) minmax(160px, 220px)",
                                  gap: 12,
                                  alignItems: "center",
                                }}
                              >
                                <div>
                                  <div
                                    style={{
                                      color: "#111827",
                                      fontSize: 14,
                                      fontWeight: 950,
                                    }}
                                  >
                                    {line.rawName || "מוצר ללא שם"}
                                  </div>
                                  <div
                                    style={{
                                      marginTop: 5,
                                      color: "#6b7280",
                                      fontSize: 12,
                                      lineHeight: 1.5,
                                    }}
                                  >
                                    כמות לקליטה: {line.quantity} · יחידה:{" "}
                                    {line.unitType || "UNIT"}
                                  </div>
                                </div>

                                <div
                                  style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 8,
                                  }}
                                >
                                  <select
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
                                    style={{
                                      minHeight: 40,
                                      borderRadius: 14,
                                      border: "1px solid #d1d5db",
                                      background: "#ffffff",
                                      padding: "0 10px",
                                      fontSize: 13,
                                      fontWeight: 800,
                                      outline: "none",
                                    }}
                                  >
                                    <option value="MERGE">שיוך למוצר קיים</option>
                                    <option value="CREATE_NEW">
                                      יצירת מוצר חדש
                                    </option>
                                  </select>

                                  {decision?.action === "MERGE" && (
                                    <select
                                      value={decision.itemId || ""}
                                      onChange={(event) =>
                                        updateDecision(line.id, {
                                          action: "MERGE",
                                          itemId: Number(event.target.value),
                                        })
                                      }
                                      style={{
                                        minHeight: 40,
                                        borderRadius: 14,
                                        border: "1px solid #d1d5db",
                                        background: "#ffffff",
                                        padding: "0 10px",
                                        fontSize: 13,
                                        fontWeight: 800,
                                        outline: "none",
                                      }}
                                    >
                                      <option value="">בחרו מוצר קיים</option>
                                      {items.map((item) => (
                                        <option key={item.id} value={item.id}>
                                          {item.name} · במלאי:{" "}
                                          {item.currentQuantity}
                                        </option>
                                      ))}
                                    </select>
                                  )}

                                  {decision?.action === "CREATE_NEW" && (
                                    <input
                                      value={decision.name}
                                      onChange={(event) =>
                                        updateDecision(line.id, {
                                          action: "CREATE_NEW",
                                          name: event.target.value,
                                          unitType: decision.unitType,
                                        })
                                      }
                                      placeholder="שם מוצר חדש"
                                      style={{
                                        minHeight: 40,
                                        borderRadius: 14,
                                        border: "1px solid #d1d5db",
                                        background: "#ffffff",
                                        padding: "0 10px",
                                        fontSize: 13,
                                        fontWeight: 800,
                                        outline: "none",
                                      }}
                                    />
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        <footer
                          style={{
                            borderTop: "1px solid #e5e7eb",
                            paddingTop: 12,
                            display: "grid",
                            gridTemplateColumns:
                              "repeat(auto-fit, minmax(180px, 1fr))",
                            gap: 10,
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => approveDraft(draft)}
                            disabled={actionLoading}
                            style={{
                              minHeight: 50,
                              borderRadius: 16,
                              border: "none",
                              background: "#059669",
                              color: "#ffffff",
                              fontSize: 15,
                              fontWeight: 950,
                              cursor: actionLoading ? "not-allowed" : "pointer",
                              opacity: actionLoading ? 0.65 : 1,
                              boxShadow: "0 10px 22px rgba(5, 150, 105, 0.16)",
                            }}
                          >
                            אישור קבלת סחורה
                          </button>

                          <button
                            type="button"
                            onClick={() => rejectDraft(draft.id)}
                            disabled={actionLoading}
                            style={{
                              minHeight: 50,
                              borderRadius: 16,
                              border: "1px solid #fecaca",
                              background: "#fef2f2",
                              color: "#991b1b",
                              fontSize: 15,
                              fontWeight: 950,
                              cursor: actionLoading ? "not-allowed" : "pointer",
                              opacity: actionLoading ? 0.65 : 1,
                            }}
                          >
                            ביטול הזמנה
                          </button>
                        </footer>
                      </section>
                    </div>
                  </div>
                </article>
              );
            })}
          </section>
        )}

        {dispatchDraft && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(15, 23, 42, 0.45)",
              zIndex: 50,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
            }}
          >
            <section
              style={{
                width: "100%",
                maxWidth: 680,
                maxHeight: "88vh",
                overflow: "auto",
                borderRadius: 28,
                background: "#ffffff",
                boxShadow: "0 24px 70px rgba(15, 23, 42, 0.28)",
                padding: 20,
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "flex-start",
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 20,
                      fontWeight: 950,
                      color: "#111827",
                    }}
                  >
                    הזמנה מוכנה לספק
                  </div>
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 13,
                      color: "#6b7280",
                      lineHeight: 1.5,
                    }}
                  >
                    אפשר להעתיק את ההודעה, לפתוח אותה ב־WhatsApp או להוריד PDF.
                    פעולה זו לא מעדכנת מלאי.
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setDispatchDraft(null)}
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 14,
                    border: "1px solid #e5e7eb",
                    background: "#ffffff",
                    cursor: "pointer",
                    fontSize: 18,
                    fontWeight: 950,
                  }}
                >
                  ×
                </button>
              </div>

              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  direction: "rtl",
                  textAlign: "right",
                  margin: 0,
                  border: "1px solid #e5e7eb",
                  borderRadius: 18,
                  background: "#f9fafb",
                  padding: 16,
                  color: "#111827",
                  fontFamily: "inherit",
                  fontSize: 14,
                  lineHeight: 1.7,
                }}
              >
                {supplierOrderText}
              </pre>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                  gap: 10,
                }}
              >
                <button
                  type="button"
                  onClick={copySupplierOrderText}
                  style={{
                    minHeight: 48,
                    borderRadius: 16,
                    border: "none",
                    background: "#111827",
                    color: "#ffffff",
                    cursor: "pointer",
                    fontWeight: 950,
                  }}
                >
                  העתק הודעה
                </button>

                <button
                  type="button"
                  onClick={openWhatsAppWithOrderText}
                  style={{
                    minHeight: 48,
                    borderRadius: 16,
                    border: "1px solid #bbf7d0",
                    background: "#f0fdf4",
                    color: "#166534",
                    cursor: "pointer",
                    fontWeight: 950,
                  }}
                >
                  פתיחה ב־WhatsApp
                </button>

               <button
  type="button"
onClick={() =>
                  dispatchDraft &&
                  downloadSupplierPurchaseOrderPdf(dispatchDraft)
                }
  style={{
    minHeight: 48,
    borderRadius: 16,
    border: "1px solid #e5e7eb",
    background: "#ffffff",
    color: "#111827",
    cursor: "pointer",
    fontWeight: 950,
  }}
>
  הורדת PDF
</button>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}