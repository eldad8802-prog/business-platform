"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  getInventoryItems,
  getPurchaseOrder,
  createReceivingSession,
  postReceivingSession,
  setLineRemainingDecision,
  type InventoryItemDTO,
  type PurchaseOrderDTO,
} from "@/lib/api/inventory";
import { redirectToLogin } from "@/lib/client-session";
import {
  clampReceived,
  lineOpenQty,
  receiveLineQuantities,
  remainderDecisionPayload,
} from "@/lib/inventory/receive-remainder";
import { formatQtyNumber, qtyWithUnit, unitWord } from "@/lib/inventory/unit-words";
import { inventoryToast } from "@/components/inventory/inventory-toast";
import {
  InvButton,
  InvConfirm,
  InvError,
  InvField,
  InvLoading,
  InvNote,
  InvPage,
  InvQty,
  InvState,
  ProductThumb,
} from "@/components/inventory/v2/kit";

type Decision = "KEEP_OPEN" | "BACKORDER" | "CLOSED_SHORT";

const DECISIONS: Array<{ value: Decision; label: string }> = [
  { value: "KEEP_OPEN", label: "השאר פתוח" },
  { value: "BACKORDER", label: "המשך מתעכב" },
  { value: "CLOSED_SHORT", label: "סגור כחוסר" },
];

/**
 * Receive goods against a purchase order (redesign, mockup "קבלת סחורה").
 * Partial receipt lives ONLY here. The posting sequence is unchanged:
 * remainder decisions (remainderDecisionPayload → setLineRemainingDecision) →
 * createReceivingSession → postReceivingSession.
 */
export default function ReceivingPage() {
  const router = useRouter();
  const params = useParams();
  const poId = Number(params?.id);

  const [po, setPo] = useState<PurchaseOrderDTO | null>(null);
  const [items, setItems] = useState<Map<number, InventoryItemDTO>>(new Map());
  const [received, setReceived] = useState<Record<number, number>>({});
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    if (!poId || Number.isNaN(poId)) {
      setLoadError("מספר ההזמנה אינו תקין.");
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setLoadError(null);
      const data = await getPurchaseOrder(poId);
      setPo(data);
      const defaults: Record<number, number> = {};
      for (const line of data.lines) {
        defaults[line.id] = line.openQty ?? line.orderedQty;
      }
      setReceived(defaults);
    } catch (err) {
      if (err instanceof Error && err.message === "UNAUTHORIZED") return redirectToLogin();
      setLoadError(err instanceof Error && /not found/i.test(err.message) ? "ההזמנה לא נמצאה." : "בדקו את החיבור ונסו שוב.");
    } finally {
      setLoading(false);
    }
    // Names and images only — optional, never blocks receiving.
    void getInventoryItems()
      .then((list) => setItems(new Map(list.map((i) => [i.id, i]))))
      .catch(() => setItems(new Map()));
  }, [poId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const lines = useMemo(() => po?.lines ?? [], [po]);

  const unitOf = useCallback(
    (line: PurchaseOrderDTO["lines"][number]) => line.unitType ?? (line.itemId != null ? items.get(line.itemId)?.unitType : null) ?? null,
    [items]
  );

  const totalLine = useMemo(() => {
    let total = 0;
    const units = new Set<string>();
    for (const line of lines) {
      total += received[line.id] ?? 0;
      if (lineOpenQty(line) > 0) units.add(unitOf(line) ?? "UNIT");
    }
    if (units.size === 1) {
      const [u] = Array.from(units);
      return { total, text: `${formatQtyNumber(total)} ${unitWord(u, total)}` };
    }
    return { total, text: `${formatQtyNumber(total)} פריטים` };
  }, [lines, received, unitOf]);

  async function handlePost() {
    if (posting || !po) return;
    const sessionLines = lines
      .map((line) => ({ purchaseOrderLineId: line.id, receivedQty: received[line.id] ?? 0 }))
      .filter((l) => l.receivedQty > 0);
    if (sessionLines.length === 0) {
      setError("יש להזין כמות שהתקבלה לפחות בשורה אחת.");
      setConfirming(false);
      return;
    }
    try {
      setPosting(true);
      setError(null);
      // Apply remaining decisions on short lines first. Short = against the open
      // balance (earlier receipts and closed-short already deducted); BACKORDER and
      // CLOSED_SHORT carry the undelivered quantity the server requires.
      for (const line of lines) {
        const payload = remainderDecisionPayload(line, received[line.id] ?? 0, decisions[line.id]);
        if (payload) {
          await setLineRemainingDecision(po.id, line.id, payload);
        }
      }
      const session = await createReceivingSession(po.id, { lines: sessionLines, note: note.trim() || null });
      await postReceivingSession(session.id);
      inventoryToast.success("הסחורה נקלטה במלאי");
      // replace: browser-back must not return into the posted form.
      router.replace("/inventory/supplier-purchases");
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "לא הצלחנו לאשר את הקבלה. נסו שוב.");
    } finally {
      setPosting(false);
      setConfirming(false);
    }
  }

  const supplier = po?.supplierName?.trim() || "ללא ספק";
  const hasOpen = lines.some((l) => lineOpenQty(l) > 0);

  return (
    <InvPage
      title="קבלת סחורה"
      backFallback="/inventory/supplier-purchases"
      footer={
        po && hasOpen ? (
          <>
            {error ? <InvNote tone="danger">{error}</InvNote> : null}
            <div className="i2-footer__row">
              <InvButton onClick={() => setConfirming(true)} disabled={posting || totalLine.total <= 0}>
                {posting ? "מאשרים…" : "אישור קבלה"}
              </InvButton>
            </div>
          </>
        ) : undefined
      }
    >
      {loading ? (
        <InvLoading rows={3} />
      ) : !po ? (
        <InvError message={loadError ?? undefined} onRetry={() => void load()} />
      ) : lines.length === 0 ? (
        <InvState
          title="אין שורות בהזמנה"
          body="אין מה לקלוט בהזמנה הזו."
          action={
            <InvButton kind="secondary" href="/inventory/supplier-purchases">
              חזרה להזמנות
            </InvButton>
          }
        />
      ) : (
        <>
          <p style={{ textAlign: "center", fontWeight: 600, fontSize: 17, margin: "6px 0 4px", overflowWrap: "anywhere" }}>
            <bdi>הזמנה {po.externalOrderId ? `#${po.externalOrderId}` : po.id}</bdi> · <bdi>{supplier}</bdi>
          </p>

          <ul className="i2-list">
            {lines.map((line) => {
              const item = line.itemId != null ? items.get(line.itemId) : undefined;
              const name = line.rawName?.trim() || item?.name || "מוצר ללא שם";
              const unit = unitOf(line);
              const rec = received[line.id] ?? 0;
              const q = receiveLineQuantities(line, rec);
              const amount = (n: number) => qtyWithUnit(n, unit);
              const parts = [
                `הוזמנו ${amount(q.ordered)}`,
                `התקבלו בעבר ${amount(q.receivedBefore)}`,
                ...(q.closedShortBefore > 0 ? [`נסגרו כחוסר ${amount(q.closedShortBefore)}`] : []),
                `נותרו ${amount(q.open)}`,
              ];
              return (
                <li key={line.id} style={{ padding: "14px 0", borderBottom: "1px solid var(--i2-line)" }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <ProductThumb src={item?.imageUrl} name={name} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="i2-row__title">
                        <span>{name}</span>
                      </div>
                      <div className="i2-row__sub">{unitWord(unit, 2)}</div>
                    </div>
                  </div>
                  {q.open <= 0 ? (
                    <p className="i2-muted" style={{ margin: "8px 0 0" }}>
                      אין יתרה פתוחה לקליטה
                    </p>
                  ) : (
                    <>
                      <div className="i2-box i2-num" style={{ marginTop: 10, fontSize: 14.5 }}>
                        {parts.join(" · ")}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 500 }}>מתקבלים עכשיו</span>
                        <InvQty
                          value={rec}
                          min={0}
                          max={q.open}
                          label={`מתקבלים עכשיו · ${name}`}
                          onChange={(v) => setReceived((r) => ({ ...r, [line.id]: clampReceived(line, v) }))}
                        />
                      </div>
                      <div className="i2-note i2-note--ok" style={{ margin: "10px 0 0" }}>
                        <div>יתרה לאחר הקבלה: {amount(q.after)}</div>
                      </div>
                      {q.after > 0 ? (
                        <fieldset style={{ border: 0, padding: 0, margin: "10px 0 0" }}>
                          <legend style={{ fontWeight: 600, padding: 0 }}>מה לעשות עם היתרה ({amount(q.after)})?</legend>
                          {DECISIONS.map((d) => (
                            <label key={d.value} className="i2-radio i2-radio--plain">
                              <input
                                type="radio"
                                name={`remainder-${line.id}`}
                                value={d.value}
                                checked={decisions[line.id] === d.value}
                                onChange={() => setDecisions((cur) => ({ ...cur, [line.id]: d.value }))}
                              />
                              <span>{d.label}</span>
                            </label>
                          ))}
                        </fieldset>
                      ) : null}
                    </>
                  )}
                </li>
              );
            })}
          </ul>

          <InvField label="הערה" optional stack htmlFor="receive-note">
            <textarea
              id="receive-note"
              className="i2-textarea"
              placeholder="למשל: חלק מהסחורה תגיע בהמשך"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </InvField>

          {hasOpen ? (
            <InvNote>האישור יוסיף {totalLine.text} למלאי. לא ניתן לבטל קבלה זו.</InvNote>
          ) : (
            <InvNote>אין יתרה פתוחה לקליטה בהזמנה זו.</InvNote>
          )}
        </>
      )}

      {confirming ? (
        <InvConfirm
          title="לאשר את קבלת הסחורה?"
          body={`האישור יוסיף ${totalLine.text} למלאי. לא ניתן לבטל קבלה זו.`}
          confirmLabel={posting ? "מאשרים…" : "אישור קבלה"}
          busy={posting}
          onConfirm={() => void handlePost()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </InvPage>
  );
}
