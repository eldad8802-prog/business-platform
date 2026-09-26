"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { WarmButton, WarmCard, WarmPill } from "@/components/ui/warm/warm-primitives";
import { AdaptiveOverlay } from "@/components/ui/adaptive-overlay";
import type {
  CollectionInbox,
  InboxAttentionItem,
  InboxDebtCustomer,
  InboxPaidItem,
  InboxRequestItem,
} from "@/lib/services/billing/collection/collection-inbox.service";
import { buildPaymentRequestMessage } from "@/lib/services/billing/collection/collection-message";
import { currencySymbol } from "@/lib/services/billing/collection/collection-display";
import {
  attentionText,
  collectionFetch,
  copyText,
  money,
  recordCollectionAction,
  shareOrCopy,
  shortDate,
} from "../collection-client";
import { CustomerPicker } from "../customer-picker";

const W = TOKEN.warm;

type Segment = "toCollect" | "waiting" | "attention" | "paid";

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: "toCollect", label: "צריך לגבות" },
  { key: "waiting", label: "ממתין" },
  { key: "attention", label: "דורש טיפול" },
  { key: "paid", label: "שולם" },
];

/**
 * /collection — the owner's collection action inbox.
 *
 * Stage-aware: it opens on "דורש טיפול" when something needs a decision,
 * otherwise on "צריך לגבות". The primary action is always "גבה"; every row
 * carries its own next step. Provider names never appear here.
 */
export function CollectionInboxScreen() {
  const router = useRouter();
  const [inbox, setInbox] = useState<CollectionInbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [segment, setSegment] = useState<Segment | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [olderPaid, setOlderPaid] = useState<InboxPaidItem[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<InboxRequestItem | null>(null);
  const [nameCustomerFor, setNameCustomerFor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);
  const load = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let cancelled = false;
    collectionFetch<CollectionInbox>("/api/collection/inbox")
      .then((data) => {
        if (cancelled) return;
        setError(null);
        setInbox(data);
        setOlderPaid([]);
        setOlderCursor(data.paidNextBefore);
        setSegment((s) => s ?? (data.attention.length > 0 ? "attention" : "toCollect"));
      })
      .catch(() => {
        if (!cancelled) setError("לא הצלחנו לטעון את הגבייה. נסו שוב.");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const counts = useMemo(
    () => ({
      toCollect: inbox?.toCollect.length ?? 0,
      waiting: inbox?.waiting.length ?? 0,
      attention: inbox?.attention.length ?? 0,
      paid: (inbox?.paid.length ?? 0) + olderPaid.length,
    }),
    [inbox, olderPaid]
  );

  async function loadOlder() {
    if (!olderCursor) return;
    const data = await collectionFetch<CollectionInbox>(
      `/api/collection/inbox?paidBefore=${encodeURIComponent(olderCursor)}`
    );
    setOlderPaid((xs) => [...xs, ...data.paid]);
    setOlderCursor(data.paidNextBefore);
  }

  async function cancelRequest(item: InboxRequestItem) {
    setBusy(true);
    try {
      await collectionFetch(`/api/payments/requests/${item.requestId}/cancel`, { method: "POST" });
      setNotice("הבקשה בוטלה. אם הלקוח ישלם בכל זאת בקישור — התשלום יירשם.");
      setConfirmCancel(null);
      load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "הביטול לא הצליח");
    } finally {
      setBusy(false);
    }
  }

  async function retrySettlement(paymentTransactionId: number, customerId: number | null) {
    setBusy(true);
    try {
      const r = await collectionFetch<{ outcome: string }>(
        `/api/collection/settlements/${paymentTransactionId}/retry`,
        { method: "POST", body: JSON.stringify(customerId ? { customerId } : {}) }
      );
      setNotice(
        r.outcome === "SETTLED" || r.outcome === "ALREADY_SETTLED"
          ? "הקבלה הופקה והתשלום שויך."
          : r.outcome === "RETRY_SCHEDULED"
            ? "ננסה שוב בעוד כמה דקות."
            : "עדיין חסר משהו כדי להפיק קבלה."
      );
      setNameCustomerFor(null);
      load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "לא הצלחנו לנסות שוב");
    } finally {
      setBusy(false);
    }
  }

  async function shareRequest(item: InboxRequestItem) {
    if (!item.paymentUrl || !inbox) return;
    const text = buildPaymentRequestMessage({
      customerName: item.customerName,
      amount: Number(item.amount).toLocaleString("he-IL"),
      currencySymbol: currencySymbol(item.currency),
      invoiceNumber: item.invoiceNumber,
      paymentUrl: item.paymentUrl,
      businessName: inbox.businessName,
    });
    const r = await shareOrCopy(text, item.paymentUrl);
    // Record only what actually happened. The share sheet and the clipboard fallback are different
    // acts, and a failure is not an act at all — writing one anyway would put reminders into the
    // history that the owner never managed to send.
    if (r !== "failed") {
      recordCollectionAction(
        r === "shared" ? "SHARE_INITIATED" : "LINK_COPIED",
        r === "shared" ? "SYSTEM_SHARE" : "CLIPBOARD",
        { customerId: item.customerId, paymentRequestId: item.requestId },
      );
    }
    setNotice(r === "copied" ? "הקישור הועתק." : r === "shared" ? "נפתח חלון השיתוף." : "לא הצלחנו להעתיק.");
  }

  const paidAll = [...(inbox?.paid ?? []), ...olderPaid];

  return (
    <div dir="rtl" style={{ minHeight: "100%", background: W.canvas, padding: "20px 16px 96px" }}>
      <style>{`
        .col-desk { max-width: 760px; margin: 0 auto; display: grid; gap: 16px; }
        @media (min-width: 1200px) {
          .col-desk {
            max-width: 1120px;
            grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
            align-items: start;
            gap: 20px 28px;
          }
          .col-desk__side { position: sticky; top: 16px; display: grid !important; gap: 12px; align-content: start; justify-items: stretch; }
          .col-desk__queue { display: grid; gap: 12px; min-width: 0; }
          .col-desk__span { grid-column: 1 / -1; }
        }
      `}</style>
      <div className="col-desk">
        <header className="col-desk__side" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, color: W.ink }}>גבייה</h1>
            {inbox ? (
              <p style={{ margin: "4px 0 0", color: W.muted, fontSize: 14 }}>
                {inbox.summary.toCollect.count > 0
                  ? `${money(inbox.summary.toCollect.amount, inbox.summary.toCollect.currency ?? "ILS")} פתוחים אצל ${inbox.summary.toCollect.count === 1 ? "לקוח אחד" : `${inbox.summary.toCollect.count} לקוחות`}`
                  : "אין כרגע חובות פתוחים."}
              </p>
            ) : null}
          </div>
          <WarmButton onClick={() => router.push("/collection/new")}>גבה</WarmButton>
        </header>

        {notice ? (
          <div className="col-desk__span" role="status" style={{ background: W.surface2, border: `1px solid ${W.line}`, borderRadius: 12, padding: "10px 12px", color: W.ink, fontSize: 14, display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} aria-label="סגור הודעה" style={{ background: "none", border: 0, color: W.muted, cursor: "pointer" }}>✕</button>
          </div>
        ) : null}

        {error ? (
          <WarmCard>
            <p style={{ margin: 0, color: W.ink }}>{error}</p>
            <div style={{ marginTop: 12 }}>
              <WarmButton variant="secondary" onClick={() => load()}>נסו שוב</WarmButton>
            </div>
          </WarmCard>
        ) : null}

        {inbox && segment ? (
          <div className="col-desk__queue">
            <nav role="tablist" aria-label="מצבי גבייה" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, background: W.surface2, padding: 4, borderRadius: 14 }}>
              {SEGMENTS.map((s) => {
                const active = segment === s.key;
                return (
                  <button
                    key={s.key}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSegment(s.key)}
                    style={{
                      minHeight: 44, border: 0, borderRadius: 10, cursor: "pointer", fontSize: 14,
                      background: active ? W.surface : "transparent", color: active ? W.ink : W.muted,
                      fontWeight: active ? 700 : 500, boxShadow: active ? W.shadow : "none",
                    }}
                  >
                    {s.label}
                    {counts[s.key] > 0 ? <span style={{ marginInlineStart: 6, color: s.key === "attention" ? W.clay : W.muted2 }}>{counts[s.key]}</span> : null}
                  </button>
                );
              })}
            </nav>

            <section role="tabpanel" style={{ display: "grid", gap: 10 }}>
              {segment === "toCollect" &&
                (inbox.toCollect.length === 0 ? (
                  <Empty text="אף אחד לא חייב לך כסף כרגע." />
                ) : (
                  inbox.toCollect.map((c, i) => <DebtRow key={c.customerId ?? `u${i}`} c={c} />)
                ))}

              {segment === "waiting" &&
                (inbox.waiting.length === 0 ? (
                  <Empty text="אין בקשות תשלום פתוחות." />
                ) : (
                  inbox.waiting.map((w) => (
                    <WarmCard key={w.requestId}>
                      <RowHead title={w.customerName ?? "לקוח"} amount={money(w.amount, w.currency)} href={w.customerId ? `/collection/c/${w.customerId}?request=${w.requestId}` : undefined} />
                      <Meta>
                        נוצרה בקשה ב-{shortDate(w.createdAt)}
                        {w.invoiceNumber ? ` · חשבונית ${w.invoiceNumber}` : ""} · <WarmPill tone="waiting">ממתין</WarmPill>
                      </Meta>
                      <Actions>
                        {w.paymentUrl ? <WarmButton variant="secondary" height={40} onClick={() => void shareRequest(w)}>שתף שוב</WarmButton> : null}
                        {w.paymentUrl ? (
                          <WarmButton variant="text" height={40} onClick={async () => {
                            const copied = await copyText(w.paymentUrl!);
                            if (copied) recordCollectionAction("LINK_COPIED", "CLIPBOARD", { customerId: w.customerId, paymentRequestId: w.requestId });
                            setNotice(copied ? "הקישור הועתק." : "לא הצלחנו להעתיק.");
                          }}>העתק קישור</WarmButton>
                        ) : null}
                        <WarmButton variant="text" height={40} onClick={() => setConfirmCancel(w)}>בטל בקשה</WarmButton>
                      </Actions>
                    </WarmCard>
                  ))
                ))}

              {segment === "attention" &&
                (inbox.attention.length === 0 ? (
                  <Empty text="אין כרגע דבר שדורש טיפול." />
                ) : (
                  inbox.attention.map((a, i) => (
                    <AttentionRow
                      key={`${a.kind}-${a.request.requestId}-${i}`}
                      a={a}
                      busy={busy}
                      onRetry={(ptx) => void retrySettlement(ptx, null)}
                      onNameCustomer={(ptx) => setNameCustomerFor(ptx)}
                    />
                  ))
                ))}

              {segment === "paid" && (
                <>
                  {paidAll.length === 0 ? (
                    <Empty text="לא התקבלו תשלומים ב-30 הימים האחרונים." />
                  ) : (
                    paidAll.map((p) => <PaidRow key={p.paymentTransactionId ?? p.requestId} p={p} />)
                  )}
                  {olderCursor ? (
                    <WarmButton variant="secondary" onClick={() => void loadOlder()}>הצג תשלומים קודמים</WarmButton>
                  ) : null}
                </>
              )}
            </section>
          </div>
        ) : !error ? (
          <p className="col-desk__queue" style={{ color: W.muted, textAlign: "center" }}>טוען…</p>
        ) : null}
      </div>

      <AdaptiveOverlay open={confirmCancel !== null} onClose={() => setConfirmCancel(null)} variant="confirm" labelledBy="cancel-title">
        <div style={{ padding: 20, display: "grid", gap: 12 }}>
          <h2 id="cancel-title" style={{ margin: 0, fontSize: 18, color: W.ink }}>לבטל את בקשת התשלום?</h2>
          <p style={{ margin: 0, color: W.muted, fontSize: 14 }}>
            Dubiz יפסיק להציג אותה כממתינה. אם הלקוח ישלם בכל זאת בקישור — התשלום יירשם וקבלה תופק.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <WarmButton disabled={busy} onClick={() => confirmCancel && void cancelRequest(confirmCancel)}>בטל בקשה</WarmButton>
            <WarmButton variant="text" onClick={() => setConfirmCancel(null)}>חזרה</WarmButton>
          </div>
        </div>
      </AdaptiveOverlay>

      <AdaptiveOverlay open={nameCustomerFor !== null} onClose={() => setNameCustomerFor(null)} variant="form" labelledBy="name-customer-title">
        <div style={{ padding: 20, display: "grid", gap: 12 }}>
          <h2 id="name-customer-title" style={{ margin: 0, fontSize: 18, color: W.ink }}>מי שילם?</h2>
          <p style={{ margin: 0, color: W.muted, fontSize: 14 }}>בחרו את הלקוח, ו-Dubiz יפיק לו את הקבלה על התשלום שהתקבל.</p>
          <CustomerPicker onPick={(c) => nameCustomerFor !== null && void retrySettlement(nameCustomerFor, c.id)} />
        </div>
      </AdaptiveOverlay>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <WarmCard><p style={{ margin: 0, color: W.muted, textAlign: "center" }}>{text}</p></WarmCard>;
}

function RowHead({ title, amount, href }: { title: string; amount: string; href?: string }) {
  const name = <span style={{ fontWeight: 700, color: W.ink, fontSize: 16 }}>{title}</span>;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
      {href ? <Link href={href} style={{ textDecoration: "none" }}>{name}</Link> : name}
      <span style={{ fontWeight: 700, color: W.ink, fontSize: 16, whiteSpace: "nowrap" }}>{amount}</span>
    </div>
  );
}

function Meta({ children }: { children: React.ReactNode }) {
  return <div style={{ marginTop: 6, color: W.muted, fontSize: 13, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>{children}</div>;
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 }}>{children}</div>;
}

function DebtRow({ c }: { c: InboxDebtCustomer }) {
  const router = useRouter();
  const invoiceCount = c.invoices.length;
  return (
    <WarmCard>
      <RowHead
        title={c.customerName ?? "לקוח ללא שם"}
        amount={money(c.totalOutstanding, c.currency)}
        href={c.customerId ? `/collection/c/${c.customerId}` : undefined}
      />
      <Meta>
        {invoiceCount === 1 ? "חשבונית אחת פתוחה" : `${invoiceCount} חשבוניות פתוחות`}
        {c.awaitingSince ? ` · ממתין מאז ${shortDate(c.awaitingSince)}` : ""}
        {c.openRequestCount > 0 ? " · יש כבר בקשת תשלום פתוחה" : ""}
      </Meta>
      <Actions>
        {c.customerId ? (
          <WarmButton height={40} onClick={() => router.push(`/collection/new?customerId=${c.customerId}`)}>
            גבה {money(c.totalOutstanding, c.currency)}
          </WarmButton>
        ) : (
          <span style={{ color: W.muted, fontSize: 13 }}>שייכו את החשבוניות ללקוח כדי לגבות.</span>
        )}
      </Actions>
    </WarmCard>
  );
}

function AttentionRow({
  a,
  busy,
  onRetry,
  onNameCustomer,
}: {
  a: InboxAttentionItem;
  busy: boolean;
  onRetry: (ptx: number) => void;
  onNameCustomer: (ptx: number) => void;
}) {
  const router = useRouter();
  const r = a.request;
  const thread = r.customerId ? `/collection/c/${r.customerId}?request=${r.requestId}` : undefined;
  if (a.kind === "PAYMENT_FAILED" || a.kind === "LINK_EXPIRED") {
    return (
      <WarmCard>
        <RowHead title={r.customerName ?? "לקוח"} amount={money(r.amount, r.currency)} href={thread} />
        <Meta>
          <WarmPill tone="late">{a.kind === "PAYMENT_FAILED" ? "נכשל" : "הקישור פג תוקף"}</WarmPill>
          {a.kind === "PAYMENT_FAILED" ? " התשלום לא אושר אצל חברת הסליקה." : " הלקוח כבר לא יכול לשלם בקישור הזה."}
        </Meta>
        <Actions>
          {r.customerId ? (
            <WarmButton height={40} onClick={() => router.push(`/collection/new?customerId=${r.customerId}${r.invoiceId ? `&invoiceId=${r.invoiceId}` : ""}`)}>
              שלח בקשה חדשה
            </WarmButton>
          ) : null}
        </Actions>
      </WarmCard>
    );
  }
  if (a.kind === "RECEIPT_ATTENTION") {
    const t = attentionText(a.reason);
    return (
      <WarmCard>
        <RowHead title={r.customerName ?? "תשלום שהתקבל"} amount={money(r.amount, r.currency)} href={thread} />
        <Meta><WarmPill tone="partial">דורש טיפול</WarmPill> {t.title}. הכסף התקבל ונרשם.</Meta>
        <Actions>
          {t.action === "NAME_CUSTOMER" ? (
            <WarmButton height={40} disabled={busy} onClick={() => onNameCustomer(a.paymentTransactionId)}>בחר לקוח</WarmButton>
          ) : null}
          {t.action === "FIX_BUSINESS" ? (
            <WarmButton height={40} onClick={() => router.push("/business")}>להשלמת פרטי העסק</WarmButton>
          ) : null}
          <WarmButton variant={t.action === "RETRY" ? "primary" : "secondary"} height={40} disabled={busy} onClick={() => onRetry(a.paymentTransactionId)}>
            נסה שוב להפיק קבלה
          </WarmButton>
        </Actions>
      </WarmCard>
    );
  }
  if (a.kind !== "UNAPPLIED_EXCESS") return null;
  return (
    <WarmCard>
      <RowHead title={r.customerName ?? "לקוח"} amount={money(a.unappliedAmount, r.currency)} href={thread} />
      <Meta>
        <WarmPill tone="partial">עודף</WarmPill>
        התקבל תשלום מעבר ליתרת החשבונית. {money(a.unappliedAmount, r.currency)} לא שויכו לחוב
        {Number(a.refundedAmount) > 0 ? ` (הוחזרו כבר ${money(a.refundedAmount, r.currency)})` : ""}.
      </Meta>
      <Actions>
        {thread ? <WarmButton height={40} onClick={() => router.push(thread)}>לטיפול בעודף</WarmButton> : null}
      </Actions>
    </WarmCard>
  );
}

function PaidRow({ p }: { p: InboxPaidItem }) {
  const line =
    p.accounting === "RECEIPTED"
      ? `קבלה ${p.receiptNumber ?? ""} הופקה${Number(p.unappliedAmount ?? 0) > 0 ? ` · עודף ${money(p.unappliedAmount!, p.currency)}` : ""}`
      : p.accounting === "RECEIPT_PENDING"
        ? "מפיקים קבלה…"
        : p.accounting === "RECEIPT_ATTENTION"
          ? "הקבלה ממתינה לטיפול"
          : "תשלום מלפני הפקת קבלות אוטומטית";
  return (
    <WarmCard>
      <RowHead title={p.customerName ?? "לקוח"} amount={money(p.amount, p.currency)} href={p.customerId ? `/collection/c/${p.customerId}?request=${p.requestId}` : undefined} />
      <Meta>
        <WarmPill tone="verified">שולם</WarmPill> {shortDate(p.paidAt)}{p.invoiceNumber ? ` · חשבונית ${p.invoiceNumber}` : ""} · {line}
      </Meta>
    </WarmCard>
  );
}
