"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInventoryItems, type InventoryItemDTO } from "@/lib/api/inventory";
import { buildClientAuthHeaders, redirectToLogin } from "@/lib/client-session";
import { qtyWithUnit } from "@/lib/inventory/unit-words";
import { inventoryToast } from "@/components/inventory/inventory-toast";
import {
  InvButton,
  InvConfirm,
  InvError,
  InvLoading,
  InvNote,
  InvPage,
  InvPill,
  InvRow,
  InvState,
  ProductThumb,
} from "@/components/inventory/v2/kit";

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

/** Same default matching as before: the stored match, then an exact name match, else create new. */
function defaultDecisions(draft: Draft, items: InventoryItemDTO[]): Record<number, LineDecision> {
  const next: Record<number, LineDecision> = {};
  draft.lines.forEach((line) => {
    const matchedByStoredId = line.matchedItemId ? items.find((item) => item.id === line.matchedItemId) : null;
    const matchedByName = items.find(
      (item) => line.rawName && item.name.trim().toLowerCase() === line.rawName.trim().toLowerCase()
    );
    const matchedItem = matchedByStoredId || matchedByName;
    next[line.id] = matchedItem
      ? { action: "MERGE", itemId: matchedItem.id }
      : { action: "CREATE_NEW", name: line.rawName || "", unitType: line.unitType || "UNIT" };
  });
  return next;
}

function readDraftParam(): number | null {
  if (typeof window === "undefined") return null;
  const v = Number(new URLSearchParams(window.location.search).get("draft"));
  return Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * Full receipt of a supplier-purchase draft (redesign, mockup "קליטת הזמנה").
 * Approval receives the FULL quantity of every line (unchanged); partial receipt
 * exists only for purchase orders (/[id]/receive). Approve and reject requests and
 * payloads are unchanged.
 */
export default function PendingSupplierPurchasesPage() {
  const router = useRouter();
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [itemsFailed, setItemsFailed] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [decisions, setDecisions] = useState<Record<number, LineDecision>>({});
  const [initialized, setInitialized] = useState<Record<number, boolean>>({});
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [openedFromList, setOpenedFromList] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);

  const loadItems = useCallback(async () => {
    try {
      const itemsData = await getInventoryItems();
      setItems(Array.isArray(itemsData) ? itemsData : []);
      setItemsFailed(false);
    } catch (itemsError) {
      console.warn("Failed loading inventory items for supplier purchases:", itemsError);
      setItems([]);
      // UI safeguard: without the items list every line would silently default to
      // "create new". Approval is blocked until the list loads.
      setItemsFailed(true);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLoadFailed(false);
      const draftsResponse = await fetch("/api/inventory/supplier-purchases", {
        method: "GET",
        headers: buildClientAuthHeaders(),
        cache: "no-store",
      });
      if (draftsResponse.status === 401) return redirectToLogin();
      const draftsData = await draftsResponse.json().catch(() => null);
      if (!draftsResponse.ok) throw new Error(draftsData?.error || "load failed");
      const pendingDrafts = Array.isArray(draftsData?.drafts)
        ? draftsData.drafts.filter((draft: Draft) => draft.status === "PENDING_REVIEW")
        : [];
      setDrafts(pendingDrafts);
      await loadItems();
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [loadItems]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSelectedId(readDraftParam());
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const draft = selectedId != null ? drafts.find((d) => d.id === selectedId) ?? null : null;

  // Default decisions once per draft, after the items list is in.
  useEffect(() => {
    if (!draft || loading || itemsFailed || initialized[draft.id]) return;
    const next = defaultDecisions(draft, items);
    queueMicrotask(() => {
      setDecisions((prev) => ({ ...prev, ...next }));
      setInitialized((prev) => ({ ...prev, [draft.id]: true }));
    });
  }, [draft, items, loading, itemsFailed, initialized]);

  function updateDecision(lineId: number, decision: LineDecision) {
    setDecisions((prev) => ({ ...prev, [lineId]: decision }));
  }

  async function approveDraft(target: Draft) {
    try {
      setActionLoading(true);
      setError(null);
      const lines = target.lines.map((line) => {
        const decision = decisions[line.id];
        const label = line.rawName || "שורה";
        if (!decision) throw new Error(`יש לבחור פעולה עבור ״${label}״.`);
        if (decision.action === "MERGE") {
          if (!decision.itemId) throw new Error(`יש לבחור מוצר במלאי עבור ״${label}״.`);
          return { lineId: line.id, action: "MERGE", itemId: Number(decision.itemId) };
        }
        if (!decision.name.trim()) throw new Error(`יש להזין שם למוצר החדש עבור ״${label}״.`);
        return {
          lineId: line.id,
          action: "CREATE_NEW",
          itemData: { name: decision.name.trim(), unitType: decision.unitType || "UNIT", sku: null, barcode: null },
        };
      });

      const response = await fetch(`/api/inventory/supplier-purchases/${target.id}/approve`, {
        method: "POST",
        headers: buildClientAuthHeaders(),
        body: JSON.stringify({ lines }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "לא הצלחנו לאשר את הקליטה.");

      inventoryToast.success("ההזמנה נקלטה במלאי");
      router.replace("/inventory/supplier-purchases?tab=history");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "לא הצלחנו לאשר את הקליטה.");
    } finally {
      setActionLoading(false);
      setConfirmApprove(false);
    }
  }

  async function rejectDraft(draftId: number) {
    try {
      setActionLoading(true);
      setError(null);
      const response = await fetch(`/api/inventory/supplier-purchases/${draftId}/reject`, {
        method: "POST",
        headers: buildClientAuthHeaders(),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "לא הצלחנו לבטל את ההזמנה.");
      inventoryToast.success("ההזמנה בוטלה. המלאי לא השתנה.");
      router.replace("/inventory/supplier-purchases?tab=history");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "לא הצלחנו לבטל את ההזמנה.");
    } finally {
      setActionLoading(false);
      setConfirmReject(false);
    }
  }

  const ready = !!draft && !itemsFailed && !!initialized[draft.id];

  return (
    <InvPage
      title="קליטת הזמנה"
      backFallback="/inventory/supplier-purchases"
      onBack={draft && openedFromList ? () => { setSelectedId(null); setError(null); } : undefined}
      footer={
        draft ? (
          <>
            {error ? <InvNote tone="danger">{error}</InvNote> : null}
            <div className="i2-footer__row">
              <InvButton disabled={!ready || actionLoading} onClick={() => setConfirmApprove(true)}>
                {actionLoading ? "מאשרים…" : "אישור קליטה מלאה"}
              </InvButton>
              <InvButton kind="secondary" href={`/inventory/supplier-purchases/${draft.id}/send`}>
                חזרה להזמנה
              </InvButton>
            </div>
          </>
        ) : undefined
      }
    >
      {loading ? (
        <InvLoading rows={3} />
      ) : loadFailed ? (
        <InvError onRetry={() => void load()} />
      ) : selectedId != null && !draft ? (
        <InvState
          title="ההזמנה אינה ממתינה לקליטה"
          body="ייתכן שכבר נקלטה או בוטלה."
          action={
            <InvButton kind="secondary" href="/inventory/supplier-purchases?tab=history">
              להיסטוריית ההזמנות
            </InvButton>
          }
        />
      ) : !draft ? (
        drafts.length === 0 ? (
          <InvState
            title="אין הזמנות שממתינות לקליטה"
            body="הזמנה שתיצרו או תייבאו תופיע כאן עד לקליטה במלאי."
            action={<InvButton href="/inventory/supplier-purchases/new">+ הזמנה חדשה</InvButton>}
          />
        ) : (
          <ul className="i2-list">
            {drafts.map((d) => (
              <InvRow
                key={d.id}
                onClick={() => {
                  setSelectedId(d.id);
                  setOpenedFromList(true);
                  setError(null);
                }}
                kicker={`טיוטת הזמנה #${d.id}`}
                title={d.supplierName?.trim() || "ללא ספק"}
                sub={d.lines.length === 1 ? "מוצר אחד" : `${d.lines.length.toLocaleString("he-IL")} מוצרים`}
                trail={
                  <InvPill
                    outline
                    onClick={() => {
                      setSelectedId(d.id);
                      setOpenedFromList(true);
                      setError(null);
                    }}
                    ariaLabel={`לקליטה · טיוטת הזמנה ${d.id}`}
                  >
                    לקליטה
                  </InvPill>
                }
              />
            ))}
          </ul>
        )
      ) : (
        <>
          <div className="i2-box i2-split" style={{ marginTop: 8 }}>
            <div>
              <small>ספק</small>
              <b style={{ overflowWrap: "anywhere" }}>
                <bdi>{draft.supplierName?.trim() || "ללא ספק"}</bdi>
              </b>
            </div>
            <div>
              <small>טיוטת הזמנה</small>
              <b className="i2-num">#{draft.id}</b>
            </div>
          </div>
          <InvNote>קליטה מלאה של הכמויות בהזמנה</InvNote>

          {itemsFailed ? (
            <div className="i2-note i2-note--danger" role="alert">
              <div style={{ flex: 1 }}>
                <div>לא הצלחנו לטעון את רשימת המוצרים במלאי, ולכן אי אפשר לשייך את השורות. הקליטה חסומה עד שהרשימה תיטען.</div>
                <div style={{ marginTop: 8 }}>
                  <InvButton small kind="secondary" onClick={() => void loadItems()}>
                    נסו שוב
                  </InvButton>
                </div>
              </div>
            </div>
          ) : null}

          <h3 className="i2-h3">שיוך פריטי ההזמנה למוצרים במלאי</h3>
          <ul className="i2-list">
            {draft.lines.map((line) => {
              const decision = decisions[line.id];
              const linked = decision?.action === "MERGE" && !!decision.itemId;
              const linkedItem = linked ? items.find((i) => i.id === Number((decision as { itemId: number }).itemId)) : undefined;
              const name = line.rawName?.trim() || "מוצר ללא שם";
              const selectId = `pend-line-${line.id}`;
              const value = decision?.action === "MERGE" ? (decision.itemId ? String(decision.itemId) : "") : "new";
              return (
                <li key={line.id} style={{ padding: "14px 0", borderBottom: "1px solid var(--i2-line)" }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <ProductThumb src={linkedItem?.imageUrl} name={name} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span className="i2-row__kicker">{linked ? "מוצר במלאי" : value === "new" ? "מוצר חדש" : "בחירה נדרשת"}</span>
                      <div className="i2-row__title">
                        <span>{name}</span>
                      </div>
                    </div>
                    <div className="i2-box" style={{ textAlign: "center", padding: "6px 10px", minWidth: 76 }}>
                      <small className="i2-muted" style={{ display: "block", fontSize: 12.5 }}>כמות</small>
                      <b className="i2-num" style={{ fontWeight: 600 }}>{qtyWithUnit(line.quantity, line.unitType)}</b>
                    </div>
                  </div>
                  <label htmlFor={selectId} className="i2-sr">
                    שיוך ״{name}״ למוצר במלאי
                  </label>
                  <select
                    id={selectId}
                    className="i2-select"
                    style={{ marginTop: 10 }}
                    disabled={!ready}
                    value={value}
                    onChange={(e) => {
                      if (e.target.value === "new") {
                        updateDecision(line.id, { action: "CREATE_NEW", name: line.rawName || "", unitType: line.unitType || "UNIT" });
                      } else {
                        updateDecision(line.id, { action: "MERGE", itemId: Number(e.target.value) });
                      }
                    }}
                  >
                    <option value="new">יצירת מוצר חדש</option>
                    {items.map((item) => (
                      <option key={item.id} value={String(item.id)}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  {decision?.action === "CREATE_NEW" ? (
                    <div style={{ marginTop: 8 }}>
                      <label htmlFor={`${selectId}-name`} className="i2-field__lab" style={{ display: "block", fontSize: 14 }}>
                        שם המוצר החדש
                      </label>
                      <input
                        id={`${selectId}-name`}
                        className="i2-input"
                        dir="auto"
                        value={decision.name}
                        aria-invalid={!decision.name.trim() ? true : undefined}
                        onChange={(e) =>
                          updateDecision(line.id, { action: "CREATE_NEW", name: e.target.value, unitType: decision.unitType })
                        }
                      />
                      {!decision.name.trim() ? <p className="i2-field__err" style={{ marginTop: 4 }}>יש להזין שם למוצר החדש</p> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          <InvNote tone="warn">האישור יוסיף את כל הכמויות למלאי. לא ניתן לבטל.</InvNote>
          <div style={{ textAlign: "center" }}>
            <button
              type="button"
              className="i2-underline"
              style={{ color: "var(--i2-danger)" }}
              disabled={actionLoading}
              onClick={() => setConfirmReject(true)}
            >
              ביטול ההזמנה
            </button>
          </div>
        </>
      )}

      {confirmApprove && draft ? (
        <InvConfirm
          title="לאשר קליטה מלאה?"
          body="האישור יוסיף את כל הכמויות למלאי. לא ניתן לבטל."
          confirmLabel={actionLoading ? "מאשרים…" : "אישור קליטה מלאה"}
          busy={actionLoading}
          onConfirm={() => void approveDraft(draft)}
          onCancel={() => setConfirmApprove(false)}
        />
      ) : null}
      {confirmReject && draft ? (
        <InvConfirm
          title="לבטל את ההזמנה? המלאי לא ישתנה."
          confirmLabel={actionLoading ? "מבטלים…" : "ביטול ההזמנה"}
          cancelLabel="חזרה"
          danger
          busy={actionLoading}
          onConfirm={() => void rejectDraft(draft.id)}
          onCancel={() => setConfirmReject(false)}
        />
      ) : null}
    </InvPage>
  );
}
