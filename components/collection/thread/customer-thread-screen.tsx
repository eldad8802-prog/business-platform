"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { WarmButton, WarmCard, WarmPill, warmInputStyle } from "@/components/ui/warm/warm-primitives";
import { AdaptiveOverlay } from "@/components/ui/adaptive-overlay";
import type { CustomerFinancialThread, ThreadEvent } from "@/lib/services/billing/collection/customer-financial-thread.service";
import { buildPaymentRequestMessage } from "@/lib/services/billing/collection/collection-message";
import { currencySymbol } from "@/lib/services/billing/collection/collection-display";
import { attentionText, collectionFetch, dateTime, money, shareOrCopy } from "../collection-client";

const W = TOKEN.warm;

type RefundTarget = { requestId: number; suggested: string | null; currency: string };

/**
 * What the screen is allowed to offer, and what the owner is owed as facts.
 *
 * The capability flags come from the provider descriptor behind this payment,
 * not from a guess: the previous screen offered "החזר כסף" for every settled
 * payment and discovered on submit that CardCom could not do it.
 */
type RefundState = {
  settledAmount: string;
  refundedTotal: string;
  refundableRemaining: string;
  currency: string;
  hasUnresolvedRefund: boolean;
  provider: string | null;
  canRefund: boolean;
  canRefundPartially: boolean;
  canVoid: boolean;
  canVerifyRefund: boolean;
};

/**
 * /collection/c/[customerId] — one customer's financial story, newest first.
 *
 * Invoice → request → the provider's verified outcome → the receipt Dubiz
 * issued and what it settled → refunds. Plain words on top; the accounting
 * underneath stays exact (a refund returns money — it never reopens an invoice
 * or cancels a receipt).
 */
export function CustomerThreadScreen({ customerId }: { customerId: number }) {
  const router = useRouter();
  const params = useSearchParams();
  const anchor = Number(params.get("request")) || null;
  const [thread, setThread] = useState<CustomerFinancialThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refund, setRefund] = useState<RefundTarget | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundMax, setRefundMax] = useState<string | null>(null);
  const [refundState, setRefundState] = useState<RefundState | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const load = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let cancelled = false;
    collectionFetch<CustomerFinancialThread>(`/api/collection/customers/${customerId}`)
      .then((t) => {
        if (!cancelled) setThread(t);
      })
      .catch(() => {
        if (!cancelled) setError("לא הצלחנו לטעון את תיק הלקוח.");
      });
    return () => {
      cancelled = true;
    };
  }, [customerId, reloadKey]);

  useEffect(() => {
    if (!thread || !anchor) return;
    document.getElementById(`req-${anchor}`)?.scrollIntoView({ block: "center" });
  }, [thread, anchor]);

  async function act(fn: () => Promise<string>) {
    setBusy(true);
    try {
      setNotice(await fn());
      load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "הפעולה לא הצליחה");
    } finally {
      setBusy(false);
    }
  }

  async function openRefund(t: RefundTarget) {
    setRefund(t);
    setRefundMax(null);
    setRefundState(null);
    try {
      const b = await collectionFetch<RefundState>(
        `/api/payments/requests/${t.requestId}/refund`
      );
      setRefundState(b);

      // The provider behind THIS payment decides what may be offered. A
      // payment taken through a provider that cannot reverse must not present
      // a refund form that is going to fail on submit.
      if (!b.canRefund) {
        setNotice("ספק הסליקה של התשלום הזה לא תומך בהחזרים.");
        setRefund(null);
        return;
      }

      setRefundMax(b.refundableRemaining);
      const suggested =
        t.suggested && Number(t.suggested) <= Number(b.refundableRemaining)
          ? t.suggested
          : b.refundableRemaining;
      // Without partial support the only honest amount is the whole balance.
      setRefundAmount(
        Number(b.canRefundPartially ? suggested : b.refundableRemaining).toString()
      );

      if (b.hasUnresolvedRefund) {
        setNotice(
          "יש החזר קודם שממתין לאימות מול ספק הסליקה. הסכום שלו שמור, " +
            "ואפשר להחזיר שוב רק אחרי שיוכרע."
        );
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "לא ניתן להחזיר את התשלום הזה");
      setRefund(null);
    }
  }

  return (
    <div dir="rtl" style={{ minHeight: "100%", background: W.canvas, padding: "20px 16px 96px" }}>
      <div style={{ maxWidth: 680, margin: "0 auto", display: "grid", gap: 14 }}>
        <Link href="/collection" style={{ color: W.muted, textDecoration: "none", fontSize: 14 }}>→ גבייה</Link>
        {error ? <WarmCard><p style={{ margin: 0 }}>{error}</p></WarmCard> : null}
        {!thread && !error ? <p style={{ color: W.muted }}>טוען…</p> : null}
        {thread ? (
          <>
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div>
                <h1 style={{ margin: 0, fontSize: 24, color: W.ink }}>{thread.customer.name}</h1>
                <p style={{ margin: "4px 0 0", color: W.muted, fontSize: 14 }}>
                  {Number(thread.totals.outstanding) > 0
                    ? `נותר לגבות ${money(thread.totals.outstanding, thread.totals.currency ?? "ILS")}`
                    : "אין יתרה פתוחה."}
                </p>
              </div>
              {Number(thread.totals.outstanding) > 0 ? (
                <WarmButton onClick={() => router.push(`/collection/new?customerId=${thread.customer.id}`)}>גבה</WarmButton>
              ) : (
                <WarmButton variant="secondary" onClick={() => router.push(`/collection/new?customerId=${thread.customer.id}`)}>בקשת תשלום</WarmButton>
              )}
            </header>

            {notice ? (
              <div role="status" style={{ background: W.surface2, border: `1px solid ${W.line}`, borderRadius: 12, padding: "10px 12px", fontSize: 14, color: W.ink }}>
                {notice}
              </div>
            ) : null}

            {thread.events.length === 0 ? (
              <WarmCard><p style={{ margin: 0, color: W.muted }}>עדיין אין תנועות כספיות ללקוח הזה.</p></WarmCard>
            ) : (
              <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
                {thread.events.map((e, i) => (
                  <li key={`${e.kind}-${i}`} id={"requestId" in e ? `req-${e.requestId}` : undefined}>
                    <EventCard
                      e={e}
                      highlighted={"requestId" in e && e.requestId === anchor}
                      busy={busy}
                      onShare={async (url, amount, currency, invoiceNumber) => {
                        const text = buildPaymentRequestMessage({
                          customerName: thread.customer.name, amount: Number(amount).toLocaleString("he-IL"),
                          currencySymbol: currencySymbol(currency), invoiceNumber, paymentUrl: url, businessName: thread.businessName,
                        });
                        const r = await shareOrCopy(text, url);
                        setNotice(r === "shared" ? "נפתח חלון השיתוף." : r === "copied" ? "הקישור הועתק." : "לא הצלחנו לשתף.");
                      }}
                      onCancel={(requestId) =>
                        act(async () => {
                          await collectionFetch(`/api/payments/requests/${requestId}/cancel`, { method: "POST" });
                          return "הבקשה בוטלה.";
                        })
                      }
                      onRetry={(ptx) =>
                        act(async () => {
                          const r = await collectionFetch<{ outcome: string }>(`/api/collection/settlements/${ptx}/retry`, { method: "POST", body: "{}" });
                          return r.outcome === "SETTLED" || r.outcome === "ALREADY_SETTLED" ? "הקבלה הופקה." : "עדיין חסר משהו כדי להפיק קבלה.";
                        })
                      }
                      onRefund={(t) => void openRefund(t)}
                    />
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : null}
      </div>

      <AdaptiveOverlay open={refund !== null} onClose={() => setRefund(null)} variant="confirm" labelledBy="refund-title">
        <div style={{ padding: 20, display: "grid", gap: 10 }}>
          <h2 id="refund-title" style={{ margin: 0, fontSize: 18, color: W.ink }}>החזר כסף ללקוח</h2>
          <p style={{ margin: 0, color: W.muted, fontSize: 14 }}>
            ההחזר מחזיר כסף דרך חברת הסליקה. הוא לא מבטל את הקבלה ולא פותח מחדש את החשבונית — אם צריך להפחית את החשבונית, הפיקו הודעת זיכוי בנפרד.
          </p>
          {refundMax === null ? (
            <span style={{ color: W.muted }}>בודק כמה אפשר להחזיר…</span>
          ) : (
            <>
              {/* The whole picture, because a refund decision made against one
                  number is a decision made blind: what arrived, what has
                  already gone back, what is still waiting on the provider, and
                  only then what may be returned now. */}
              {refundState ? (
                <dl
                  style={{
                    margin: 0,
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: "4px 12px",
                    fontSize: 14,
                    color: W.muted,
                  }}
                >
                  <dt style={{ margin: 0 }}>שולם במקור</dt>
                  <dd style={{ margin: 0, color: W.ink, fontWeight: 700 }}>
                    {money(refundState.settledAmount, refundState.currency)}
                  </dd>
                  <dt style={{ margin: 0 }}>הוחזר עד כה</dt>
                  <dd style={{ margin: 0, color: W.ink }}>
                    {money(refundState.refundedTotal, refundState.currency)}
                  </dd>
                  {refundState.hasUnresolvedRefund ? (
                    <>
                      <dt style={{ margin: 0 }}>ממתין לאימות</dt>
                      <dd style={{ margin: 0, color: W.ink }}>
                        סכום שמור עד שחברת הסליקה תאשר
                      </dd>
                    </>
                  ) : null}
                  <dt style={{ margin: 0 }}>ניתן להחזיר עכשיו</dt>
                  <dd style={{ margin: 0, color: W.ink, fontWeight: 700 }}>
                    {money(refundState.refundableRemaining, refundState.currency)}
                  </dd>
                </dl>
              ) : null}
              <label htmlFor="refund-amount" style={{ fontWeight: 700 }}>
                {refundState && !refundState.canRefundPartially
                  ? `סכום (ספק הסליקה מחזיר רק את המלוא: ${money(refundMax, refund?.currency)})`
                  : `סכום (עד ${money(refundMax, refund?.currency)})`}
              </label>
              <input id="refund-amount" inputMode="decimal" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value.replace(/[^\d.]/g, ""))} style={warmInputStyle()} />
              <div style={{ display: "flex", gap: 8 }}>
                <WarmButton
                  disabled={busy || !(Number(refundAmount) > 0) || Number(refundAmount) > Number(refundMax)}
                  onClick={() =>
                    refund &&
                    act(async () => {
                      const r = await collectionFetch<{ outcome: string }>(`/api/payments/requests/${refund.requestId}/refund`, {
                        method: "POST",
                        body: JSON.stringify({ amount: refundAmount }),
                      });
                      setRefund(null);
                      return r.outcome === "SETTLED"
                        ? "ההחזר בוצע."
                        : r.outcome === "UNKNOWN"
                          ? "ההחזר נשלח לחברת הסליקה, והתוצאה עוד לא ידועה. נעדכן כשתתקבל."
                          : "חברת הסליקה לא ביצעה את ההחזר.";
                    })
                  }
                >
                  החזר {refundAmount ? money(refundAmount, refund?.currency) : ""}
                </WarmButton>
                <WarmButton variant="text" onClick={() => setRefund(null)}>ביטול</WarmButton>
              </div>
            </>
          )}
        </div>
      </AdaptiveOverlay>
    </div>
  );
}

function EventCard({
  e,
  highlighted,
  busy,
  onShare,
  onCancel,
  onRetry,
  onRefund,
}: {
  e: ThreadEvent;
  highlighted: boolean;
  busy: boolean;
  onShare: (url: string, amount: string, currency: string, invoiceNumber: string | null) => void;
  onCancel: (requestId: number) => void;
  onRetry: (paymentTransactionId: number) => void;
  onRefund: (t: RefundTarget) => void;
}) {
  const frame: React.CSSProperties = highlighted ? { outline: `2px solid ${W.tealDeep}`, borderRadius: 16 } : {};
  const when = <span style={{ color: W.muted2, fontSize: 12 }}>{dateTime(e.at)}</span>;
  const row = (title: React.ReactNode, amount?: string, body?: React.ReactNode, actions?: React.ReactNode) => (
    <div style={frame}>
      <WarmCard>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
          <span style={{ fontWeight: 700, color: W.ink }}>{title}</span>
          {amount ? <span style={{ fontWeight: 700, color: W.ink, whiteSpace: "nowrap" }}>{amount}</span> : null}
        </div>
        <div style={{ marginTop: 4, color: W.muted, fontSize: 13, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {when}
          {body}
        </div>
        {actions ? <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 }}>{actions}</div> : null}
      </WarmCard>
    </div>
  );

  switch (e.kind) {
    case "INVOICE_ISSUED":
      return row(
        <Link href={`/billing/${e.invoiceId}`} style={{ color: W.ink }}>חשבונית {e.number ?? ""}</Link>,
        money(e.amount, e.currency),
        Number(e.outstanding) > 0 ? <span>נותר לגבות {money(e.outstanding, e.currency)}</span> : <WarmPill tone="verified">סגורה</WarmPill>
      );
    case "CREDIT_NOTE_ISSUED":
      return row(<Link href={`/billing/${e.documentId}`} style={{ color: W.ink }}>הודעת זיכוי {e.number ?? ""}</Link>, `−${money(e.amount, e.currency)}`, <span>הפחתה מהחשבונית</span>);
    case "REQUEST_CREATED":
      return row(
        "בקשת תשלום",
        money(e.amount, e.currency),
        <>
          {e.invoiceNumber ? <span>חשבונית {e.invoiceNumber}</span> : <span>ללא חשבונית</span>}
          {e.status === "PENDING" ? <WarmPill tone="waiting">ממתין</WarmPill> : null}
          {e.status === "CANCELLED" ? <WarmPill tone="waiting">בוטל</WarmPill> : null}
          {e.status === "FAILED" ? <WarmPill tone="late">נכשל</WarmPill> : null}
          {e.status === "EXPIRED" ? <WarmPill tone="late">פג תוקף</WarmPill> : null}
          {e.status === "PAID" ? <WarmPill tone="verified">שולם</WarmPill> : null}
        </>,
        e.status === "PENDING" && e.paymentUrl ? (
          <>
            <WarmButton height={40} variant="secondary" onClick={() => onShare(e.paymentUrl!, e.amount, e.currency, e.invoiceNumber)}>שתף שוב</WarmButton>
            <WarmButton height={40} variant="text" disabled={busy} onClick={() => onCancel(e.requestId)}>בטל בקשה</WarmButton>
          </>
        ) : null
      );
    case "REQUEST_CANCELLED":
      return row("בקשת התשלום בוטלה", undefined, <span>Dubiz הפסיק לבקש את התשלום הזה.</span>);
    case "PAYMENT_FAILED":
      return row("התשלום נכשל", money(e.amount, e.currency), <span>חברת הסליקה לא אישרה את התשלום.</span>);
    case "PAYMENT_VERIFIED": {
      const attention = e.accounting === "RECEIPT_ATTENTION" ? attentionText(e.attentionReason) : null;
      return row(
        "התשלום התקבל ואומת",
        money(e.amount, e.currency),
        <>
          <WarmPill tone="verified">שולם</WarmPill>
          {e.accounting === "RECEIPT_PENDING" ? <span>מפיקים קבלה…</span> : null}
          {e.accounting === "NO_AUTOMATIC_RECEIPT" ? <span>תשלום מלפני הפקת קבלות אוטומטית</span> : null}
          {attention ? <span>{attention.title}</span> : null}
        </>,
        <>
          {attention ? <WarmButton height={40} disabled={busy} onClick={() => onRetry(e.paymentTransactionId)}>נסה שוב להפיק קבלה</WarmButton> : null}
          <WarmButton height={40} variant="text" onClick={() => onRefund({ requestId: e.requestId, suggested: null, currency: e.currency })}>החזר כסף</WarmButton>
        </>
      );
    }
    case "RECEIPT_ISSUED":
      return row(
        <Link href={`/billing/${e.receiptId}`} style={{ color: W.ink }}>קבלה {e.number ?? ""}{e.automatic ? " (אוטומטית)" : ""}</Link>,
        money(e.amount, e.currency),
        <>
          {e.allocations.map((a) => (
            <span key={a.invoiceId}>שויכו {money(a.amount, e.currency)} לחשבונית {a.invoiceNumber ?? ""}</span>
          ))}
          {Number(e.unappliedAmount) > 0 ? <WarmPill tone="partial">עודף {money(e.unappliedAmount, e.currency)} לא שויך לחוב</WarmPill> : null}
        </>
      );
    case "REFUND":
      return row(
        "החזר כסף",
        `−${money(e.amount, e.currency)}`,
        e.outcome === "SETTLED" ? <span>הוחזר ללקוח</span> : e.outcome === "PENDING" ? <span>ממתין לאישור חברת הסליקה</span> : <span>ההחזר לא בוצע</span>
      );
  }
}
