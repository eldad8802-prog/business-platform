"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getInventoryItems } from "@/lib/api/inventory";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import {
  DecisionCard,
  DecisionChips,
  InventoryBadge,
  InventoryStatePanel,
  InventorySkeletonBlock,
} from "@/components/inventory/inventory-design";

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
  const [confirmRejectId, setConfirmRejectId] = useState<number | null>(null);
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
    setConfirmRejectId(null);

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
      setConfirmRejectId(null);
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
      setConfirmRejectId(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "שגיאה בביטול ההזמנה");
    } finally {
      setActionLoading(false);
    }
  }

  function requestRejectDraft(draftId: number) {
    if (confirmRejectId !== draftId) {
      setConfirmRejectId(draftId);
      setError(null);
      setSuccess(null);
      return;
    }

    void rejectDraft(draftId);
  }

  return (
    <InventorySubPage intent="data"
      title="קליטת הזמנות"
      backHref="/inventory/supplier-purchases"
      backLabel="מרכז הזמנות ספק"
      sub={
        !loading && !error
          ? summary.totalOrders > 0
            ? `${summary.totalOrders} הזמנות ממתינות · קליטה מעדכנת מלאי`
            : "אין הזמנות לקליטה · קליטה מעדכנת מלאי בפועל"
          : undefined
      }
      bottomNav="orders"
    >
      {error ? (
        <div className="inv-fwrap">
          <div className="inv-alert inv-alert--error">{error}</div>
        </div>
      ) : null}
      {success ? (
        <div className="inv-fwrap">
          <div className="inv-alert inv-alert--success">{success}</div>
        </div>
      ) : null}

      {loading ? (
        <div className="inv-rows">
          <InventorySkeletonBlock height={92} rows={3} />
        </div>
      ) : drafts.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            title="הכול מטופל"
            action={
              <Link href="/inventory/supplier-purchases/new" className="inv-btn-primary inv-btn-primary--full">
                יצירת הזמנה חדשה
              </Link>
            }
          >
            אין כרגע הזמנות שממתינות לקליטת סחורה.
          </InventoryStatePanel>
        </div>
      ) : (
        <div className="inv-rows">
          {drafts.map((draft) => {
            const isOpen = openId === draft.id;
            const totalUnits = draft.lines.reduce(
              (sum, line) => sum + line.quantity,
              0
            );

            return (
              <DecisionCard key={draft.id}>
                <div className="inv-dcard__top">
                  <span
                    className="inv-row__thumb"
                    style={{ background: "var(--inv-surface)", width: 46, height: 46, fontSize: 22 }}
                    aria-hidden
                  >
                    🚚
                  </span>
                  <div className="inv-row__mid">
                    <div className="inv-row__nm" dir="auto">{draft.supplierName || "הזמנה ללא ספק"}</div>
                    <div className="inv-row__meta">
                      <bdi>#{draft.id}</bdi> · <bdi>{draft.lines.length}</bdi> פריטים · <bdi>{totalUnits}</bdi> יחידות
                    </div>
                  </div>
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 7 }}>
                    <InventoryBadge tone="low">ממתינה לקליטה</InventoryBadge>
                    <button type="button" className="inv-row__action" onClick={() => openDraft(draft)}>
                      {isOpen ? "סגור" : "בדיקה ›"}
                    </button>
                  </span>
                </div>

                {isOpen ? (
                  <div style={{ marginTop: 14 }}>
                    <div className="inv-seclabel">מה הגיע? · התאימו כל שורה למלאי</div>

                    <div className="inv-olines">
                      {draft.lines.map((line) => {
                        const decision = decisions[line.id];
                        return (
                          <div key={line.id} className="inv-oline" style={{ flexWrap: "wrap" }}>
                            <div className="inv-oline__mid">
                              <div className="inv-oline__nm" dir="auto">{line.rawName || "מוצר ללא שם"}</div>
                              <div className="inv-oline__sub">
                                <bdi>{line.quantity}</bdi> {line.unitType || "UNIT"}
                              </div>
                            </div>
                            <div style={{ width: "100%", display: "grid", gap: 8, marginTop: 8 }}>
                              <select
                                className="inv-input"
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
                                <option value="CREATE_NEW">יצירת מוצר חדש</option>
                              </select>

                              {decision?.action === "MERGE" ? (
                                <select
                                  className="inv-input"
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
                                      {item.name} · במלאי: {item.currentQuantity}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  className="inv-input"
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
                                  dir="auto"
                                />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <p className="inv-field__help" style={{ marginTop: 10 }}>
                      אישור יעדכן את המלאי ב-<bdi>{totalUnits}</bdi> יחידות ויעביר את ההזמנה להיסטוריה.
                    </p>

                    {confirmRejectId === draft.id ? (
                      <div className="inv-alert inv-alert--error" style={{ marginTop: 10 }}>
                        ביטול הזמנה הוא פעולה בלתי הפיכה. לחץ שוב כדי לאשר.
                      </div>
                    ) : null}

                    <DecisionChips
                      choices={[
                        { label: actionLoading ? "מאשר…" : "אשר קליטה", primary: true, disabled: actionLoading, onClick: () => void approveDraft(draft) },
                        { label: confirmRejectId === draft.id ? "אשר ביטול" : "בטל הזמנה", disabled: actionLoading, onClick: () => requestRejectDraft(draft.id) },
                      ]}
                    />
                    <Link
                      href={`/inventory/supplier-purchases/${draft.id}/send`}
                      className="inv-btn-link"
                      style={{ display: "inline-block", marginTop: 10 }}
                    >
                      חזרה לשליחה
                    </Link>
                  </div>
                ) : null}
              </DecisionCard>
            );
          })}
        </div>
      )}
    </InventorySubPage>
  );
}
