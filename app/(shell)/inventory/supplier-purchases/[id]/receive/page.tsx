"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useParams, useRouter } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import {
  InventoryOrderLine,
  MiniStepper,
  DecisionChips,
  BottomActionBar,
  ConfirmModal,
  InventoryStatePanel,
  InventorySkeletonBlock,
} from "@/components/inventory/inventory-design";
import {
  getPurchaseOrder,
  createReceivingSession,
  postReceivingSession,
  setLineRemainingDecision,
  type PurchaseOrderDTO,
} from "@/lib/api/inventory";
import { getProductEmoji } from "@/lib/inventory/product-emoji";

type Decision = "KEEP_OPEN" | "BACKORDER" | "CLOSED_SHORT";

const UNIT_SHORT: Record<string, string> = {
  UNIT: "יח׳",
  BOX: "מארז",
  KG: "ק״ג",
  GRAM: "גרם",
  LITER: "ליטר",
  ML: "מ״ל",
};

const PO_STATUS_LABEL: Record<string, string> = {
  DRAFT: "טיוטה",
  CONFIRMED: "מאושרת",
  SENT: "נשלחה",
  AWAITING_DELIVERY: "ממתינה לאספקה",
  CLOSED: "סגורה",
  CANCELLED: "בוטלה",
};

function fmtTraceDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" });
}

export default function ReceivingPage() {
  const router = useRouter();
  const params = useParams();
  const poId = Number(params?.id);

  const [po, setPo] = useState<PurchaseOrderDTO | null>(null);
  const [received, setReceived] = useState<Record<number, number>>({});
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [openDetails, setOpenDetails] = useState<Record<number, boolean>>({});
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    if (!poId || Number.isNaN(poId)) {
      setError("מזהה הזמנה שגוי");
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const data = await getPurchaseOrder(poId);
      setPo(data);
      const defaults: Record<number, number> = {};
      for (const line of data.lines) {
        defaults[line.id] = line.openQty ?? line.orderedQty;
      }
      setReceived(defaults);
    } catch (err) {
      setError(err instanceof Error && err.message === "UNAUTHORIZED" ? "אין הרשאה. צריך להתחבר מחדש." : err instanceof Error ? err.message : "שגיאה בטעינת ההזמנה");
    } finally {
      setLoading(false);
    }
  }, [poId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const lines = po?.lines ?? [];

  const stats = useMemo(() => {
    let full = 0;
    let partial = 0;
    let totalReceived = 0;
    for (const line of lines) {
      const rec = received[line.id] ?? 0;
      totalReceived += rec;
      if (rec >= line.orderedQty) full += 1;
      else if (rec > 0) partial += 1;
    }
    return { full, partial, totalReceived };
  }, [lines, received]);

  async function handlePost() {
    if (posting || !po) return;
    const sessionLines = lines
      .map((line) => ({ purchaseOrderLineId: line.id, receivedQty: received[line.id] ?? 0 }))
      .filter((l) => l.receivedQty > 0);
    if (sessionLines.length === 0) {
      setError("צריך לרשום כמות שהתקבלה לפחות בפריט אחד");
      setConfirming(false);
      return;
    }
    try {
      setPosting(true);
      setError(null);
      // Apply remaining decisions on short lines first.
      for (const line of lines) {
        const rec = received[line.id] ?? 0;
        const decision = decisions[line.id];
        if (rec < line.orderedQty && decision) {
          await setLineRemainingDecision(po.id, line.id, { remainingDecision: decision });
        }
      }
      const session = await createReceivingSession(po.id, { lines: sessionLines, note: note.trim() || null });
      await postReceivingSession(session.id);
      router.push("/inventory/supplier-purchases");
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה בקליטת הסחורה");
    } finally {
      setPosting(false);
      setConfirming(false);
    }
  }

  return (
    <InventorySubPage
      title="קבלת סחורה"
      backHref="/inventory/supplier-purchases"
      sub={
        po
          ? (
            <>
              הזמנה <b style={{ color: "var(--inv-text)" }}>#{po.externalOrderId || po.id}</b> · {po.supplierName || "ללא ספק"} · רשום כמה התקבל בפועל
            </>
          )
          : undefined
      }
      bottomNav="orders"
    >
      {error && !po ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            tone="error"
            title="לא ניתן לטעון את ההזמנה"
            action={<button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => void load()}>נסה שוב</button>}
          >
            {error}
          </InventoryStatePanel>
        </div>
      ) : loading ? (
        <div className="inv-olines">
          <InventorySkeletonBlock height={74} rows={3} />
        </div>
      ) : lines.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel title="אין שורות בהזמנה">לא נמצאו פריטים לקליטה בהזמנה זו.</InventoryStatePanel>
        </div>
      ) : (
        <>
          <div className="inv-olines">
            {lines.map((line) => {
              const rec = received[line.id] ?? 0;
              const unit = line.unitType ? UNIT_SHORT[line.unitType] ?? "" : "";
              const short = rec < line.orderedQty;
              const shortBy = line.orderedQty - rec;
              return (
                <InventoryOrderLine
                  key={line.id}
                  thumb={<span style={{ fontSize: 22 }}>{getProductEmoji(line.rawName || "")}</span>}
                  name={line.rawName || `פריט #${line.id}`}
                  sub={
                    short && rec > 0 ? (
                      <span style={{ color: "var(--inv-warning-ink)" }}>
                        הוזמן <bdi>{line.orderedQty}</bdi> · התקבל <bdi>{rec}</bdi> — חוסר של <bdi>{shortBy}</bdi>
                      </span>
                    ) : (
                      <>הוזמן <bdi>{line.orderedQty}{unit ? ` ${unit}` : ""}</bdi></>
                    )
                  }
                  trailing={
                    <MiniStepper
                      value={rec}
                      min={0}
                      onDecrement={() => setReceived((r) => ({ ...r, [line.id]: Math.max(0, rec - 1) }))}
                      onIncrement={() => setReceived((r) => ({ ...r, [line.id]: rec + 1 }))}
                    />
                  }
                  extra={
                    <div style={{ width: "100%", display: "grid", gap: 10 }}>
                      <button
                        type="button"
                        className="inv-dchip"
                        style={{ justifySelf: "start" }}
                        aria-expanded={openDetails[line.id] ? true : false}
                        onClick={() => setOpenDetails((o) => ({ ...o, [line.id]: !o[line.id] }))}
                      >
                        {openDetails[line.id] ? "הסתר פרטי הזמנה" : "פרטי הזמנה ומעקב"}
                      </button>

                      {openDetails[line.id] && po ? (
                        <div style={traceStyle}>
                          <TraceRow label="הזמנה" value={`#${po.externalOrderId || po.id}`} />
                          <TraceRow label="ספק" value={po.supplierName || "—"} />
                          <TraceRow label="סטטוס" value={PO_STATUS_LABEL[po.status] || po.status} />
                          <TraceRow label="כמות שהוזמנה" value={`${line.orderedQty}${unit ? ` ${unit}` : ""}`} />
                          {line.unitCost != null ? <TraceRow label="עלות ליחידה" value={`₪${line.unitCost.toLocaleString("he-IL")}`} /> : null}
                          {line.sku ? <TraceRow label="מק״ט" value={line.sku} /> : null}
                          {line.barcode ? <TraceRow label="ברקוד" value={line.barcode} /> : null}
                          <div style={traceDividerStyle} />
                          <TraceRow label="תאריך יצירת ההזמנה" value={fmtTraceDate(po.createdAt)} />
                          <TraceRow label="תאריך שליחת ההזמנה" value={fmtTraceDate(po.orderDate)} />
                          <TraceRow label="תאריך צפוי לקבלה" value={fmtTraceDate(line.expectedAt)} />
                          <TraceRow
                            label="תאריך קליטה בפועל"
                            value={line.lastReceivedAt ? fmtTraceDate(line.lastReceivedAt) : "טרם נקלט"}
                          />
                        </div>
                      ) : null}

                      {short ? (
                        <DecisionChips
                          choices={[
                            { label: "להשאיר פתוח", primary: decisions[line.id] === "KEEP_OPEN", onClick: () => setDecisions((d) => ({ ...d, [line.id]: "KEEP_OPEN" })) },
                            { label: "הזמנה חוזרת", primary: decisions[line.id] === "BACKORDER", onClick: () => setDecisions((d) => ({ ...d, [line.id]: "BACKORDER" })) },
                            { label: "לסגור בחוסר", primary: decisions[line.id] === "CLOSED_SHORT", onClick: () => setDecisions((d) => ({ ...d, [line.id]: "CLOSED_SHORT" })) },
                          ]}
                        />
                      ) : null}
                    </div>
                  }
                />
              );
            })}
          </div>

          <div className="inv-fwrap">
            <input className="inv-input" placeholder="הערת קבלה (אופציונלי)" value={note} onChange={(e) => setNote(e.target.value)} />
            {error ? <div className="inv-alert inv-alert--error" style={{ marginTop: 12 }}>{error}</div> : null}
          </div>

          <BottomActionBar
            label={`${stats.full} פריטים מלאים · ${stats.partial} חלקי`}
            value={<><bdi>{stats.totalReceived}</bdi> ייכנסו למלאי</>}
            cta={posting ? "קולט…" : "אישור קליטה"}
            ctaDisabled={posting}
            onCta={() => setConfirming(true)}
          />
        </>
      )}

      {confirming ? (
        <ConfirmModal
          title="אישור קליטת סחורה"
          body="הקליטה תעדכן את המלאי בפועל לפי הכמויות שנרשמו. לא ניתן לבטל פעולה זו."
          confirmLabel={posting ? "קולט…" : "אשר קליטה"}
          onConfirm={() => void handlePost()}
          onCancel={() => setConfirming(false)}
          confirmDisabled={posting}
        />
      ) : null}
    </InventorySubPage>
  );
}

function TraceRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={traceRowStyle}>
      <span style={traceLabelStyle}>{label}</span>
      <span style={traceValueStyle} dir="auto">{value}</span>
    </div>
  );
}

const traceStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  padding: "12px 14px",
  borderRadius: 12,
  border: "1px solid var(--inv-border)",
  background: "var(--inv-surface)",
};

const traceRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
};

const traceLabelStyle: CSSProperties = {
  color: "var(--inv-text-muted)",
  fontSize: 13,
  fontWeight: 600,
  flexShrink: 0,
};

const traceValueStyle: CSSProperties = {
  color: "var(--inv-text)",
  fontSize: 14,
  fontWeight: 700,
  textAlign: "left",
  minWidth: 0,
};

const traceDividerStyle: CSSProperties = {
  height: 1,
  background: "var(--inv-border)",
  margin: "2px 0",
};
