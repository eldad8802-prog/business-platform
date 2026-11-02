"use client";

import Link from "next/link";
import BackButton from "@/components/ui/back-button";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { WarmButton, WarmCard, WarmPill, warmInputStyle } from "@/components/ui/warm/warm-primitives";
import { AdaptiveOverlay } from "@/components/ui/adaptive-overlay";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";
import type { CustomerFinancialThread, ThreadEvent } from "@/lib/services/billing/collection/customer-financial-thread.service";
import { buildPaymentRequestMessage } from "@/lib/services/billing/collection/collection-message";
import { currencySymbol } from "@/lib/services/billing/collection/collection-display";
import { attentionText, collectionFetch, recordCollectionAction, shareOrCopy, useCollectionFormat } from "../collection-client";
import { refundOutcomeNotice, type RefundApiOutcome } from "./refund-outcome";
import { ProviderDocumentNote } from "../provider-document";

const W = TOKEN.warm;

function eventDeskRow(
  e: ThreadEvent,
  tr: Translator,
  money: (amount: string | number, currency?: string) => string,
): { what: string; amount: string } {
  switch (e.kind) {
    case "INVOICE_ISSUED":
      return { what: e.number ? tr("money.collection.shared.invoiceN", { number: e.number }) : tr("money.collection.thread.rowInvoice"), amount: money(e.amount, e.currency) };
    case "CREDIT_NOTE_ISSUED":
      return { what: e.number ? tr("money.collection.thread.rowCreditN", { number: e.number }) : tr("money.collection.thread.rowCredit"), amount: money(e.amount, e.currency) };
    case "REQUEST_CREATED":
      return {
        what: e.invoiceNumber ? tr("money.collection.thread.rowRequestWithInvoice", { number: e.invoiceNumber }) : tr("money.collection.thread.paymentRequest"),
        amount: money(e.amount, e.currency),
      };
    case "REQUEST_CANCELLED":
      return { what: tr("money.collection.thread.rowRequestCancelled"), amount: "—" };
    case "PAYMENT_FAILED":
      return { what: tr("money.collection.thread.rowPaymentNotApproved"), amount: money(e.amount, e.currency) };
    case "PAYMENT_VERIFIED":
      return { what: tr("money.collection.thread.rowPaymentVerified"), amount: money(e.amount, e.currency) };
    case "RECEIPT_ISSUED":
      return { what: e.number ? tr("money.collection.thread.rowReceiptN", { number: e.number }) : tr("money.collection.thread.rowReceipt"), amount: money(e.amount, e.currency) };
    case "REFUND":
      return { what: tr("money.collection.thread.rowRefund"), amount: money(e.amount, e.currency) };
  }
}

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
  const { t: tr } = useI18n();
  const { money, dateTime } = useCollectionFormat();
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
  // One key per refund the owner means to make, minted when the dialog opens.
  // A retry of the same submission (double click, flaky network) carries the
  // same key, and the server answers it from the ledger instead of refunding
  // twice. A new dialog is a new intent and gets a new key.
  const [refundKey, setRefundKey] = useState("");
  const [selectedEvent, setSelectedEvent] = useState<number | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const load = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let cancelled = false;
    collectionFetch<CustomerFinancialThread>(`/api/collection/customers/${customerId}`)
      .then((t) => {
        if (!cancelled) setThread(t);
      })
      .catch(() => {
        if (!cancelled) setError(tr("money.collection.thread.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [customerId, reloadKey, tr]);

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
      setNotice(e instanceof Error ? e.message : tr("money.collection.shared.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function openRefund(t: RefundTarget) {
    setRefund(t);
    setRefundKey(newRefundKey());
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
        setNotice(tr("money.collection.thread.noRefundSupport"));
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
        setNotice(tr("money.collection.thread.unresolvedRefund"));
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : tr("money.collection.thread.cannotRefund"));
      setRefund(null);
    }
  }

  return (
    <div style={{ minHeight: "100%", background: W.canvas, padding: "20px 16px 96px" }}>
      <style>{`
        .col-thread { max-width: 680px; margin: 0 auto; display: grid; gap: 14px; }
        .col-thread__table, .col-thread__invoices, .col-thread__pick { display: none; }
        @media (min-width: 1200px) {
          .col-thread { max-width: none; grid-template-columns: minmax(260px, 320px) minmax(0, 1fr); align-items: start; column-gap: 28px; }
          .col-thread__span { grid-column: 1 / -1; }
          .col-thread__side { position: sticky; top: 16px; display: grid !important; gap: 12px; align-content: start; }
          .col-thread__queue { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 340px); gap: 16px; align-items: start; }
          .col-thread__cards { display: none !important; }
          .col-thread__pick { display: block; position: sticky; top: 16px; }
          .col-thread__table tr { cursor: pointer; }
          .col-thread__table tr.is-selected td { background: #f6f3ee; }
          .col-thread__table { display: block; width: 100%; background: #fff; border: 1px solid rgba(52,60,50,0.08); border-radius: 16px; overflow: auto; }
          .col-thread__table th, .col-thread__table td { text-align: start; padding: 12px 14px; border-bottom: 1px solid rgba(52,60,50,0.08); font-size: 14px; }
          .col-thread__table th { font-size: 12px; color: #6d675f; font-weight: 600; }
          .col-thread__invoices { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
          .col-thread__invoices li { display: flex; justify-content: space-between; gap: 12px; background: #fff; border: 1px solid rgba(52,60,50,0.08); border-radius: 12px; padding: 10px 12px; font-size: 13px; }
        }
      `}</style>
      <div className="col-thread">
        <div className="col-thread__span"><BackButton /></div>
        {error ? <WarmCard><p style={{ margin: 0 }}>{error}</p></WarmCard> : null}
        {!thread && !error ? <p style={{ color: W.muted }}>{tr("money.common.loading")}</p> : null}
        {thread ? (
          <>
            <header className="col-thread__side" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
              <div>
                <h1 style={{ margin: 0, fontSize: 24, color: W.ink }}>{thread.customer.name}</h1>
                <p style={{ margin: "4px 0 0", color: W.muted, fontSize: 14 }}>
                  {Number(thread.totals.outstanding) > 0
                    ? tr("money.collection.thread.remainingToCollect", { amount: money(thread.totals.outstanding, thread.totals.currency ?? "ILS") })
                    : tr("money.collection.thread.noBalance")}
                </p>
              </div>
              {Number(thread.totals.outstanding) > 0 ? (
                <WarmButton onClick={() => router.push(`/collection/new?customerId=${thread.customer.id}`)}>{tr("money.collection.shared.collect")}</WarmButton>
              ) : (
                <WarmButton variant="secondary" onClick={() => router.push(`/collection/new?customerId=${thread.customer.id}`)}>{tr("money.collection.thread.paymentRequest")}</WarmButton>
              )}
              {thread.openInvoices.length > 0 ? (
                <ul className="col-thread__invoices">
                  {thread.openInvoices.map((invoice) => (
                    <li key={invoice.id}>
                      <span>{invoice.number ? tr("money.collection.shared.invoiceN", { number: invoice.number }) : tr("money.collection.thread.openInvoice")}</span>
                      <strong>{money(invoice.outstanding, invoice.currency)}</strong>
                    </li>
                  ))}
                </ul>
              ) : null}
            </header>

            {notice ? (
              <div className="col-thread__span" role="status" style={{ background: W.surface2, border: `1px solid ${W.line}`, borderRadius: 12, padding: "10px 12px", fontSize: 14, color: W.ink }}>
                {notice}
              </div>
            ) : null}

            {thread.events.length === 0 ? (
              <div className="col-thread__queue">
                <WarmCard><p style={{ margin: 0, color: W.muted }}>{tr("money.collection.thread.noEvents")}</p></WarmCard>
              </div>
            ) : (
              <div className="col-thread__queue">
              <ol className="col-thread__cards" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
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
                        if (r !== "failed") {
                          recordCollectionAction(
                            r === "shared" ? "SHARE_INITIATED" : "LINK_COPIED",
                            r === "shared" ? "SYSTEM_SHARE" : "CLIPBOARD",
                            { customerId: thread.customer.id },
                          );
                        }
                        setNotice(r === "shared" ? tr("money.collection.shared.shareOpened") : r === "copied" ? tr("money.collection.shared.linkCopied") : tr("money.collection.shared.shareFailed"));
                      }}
                      onCancel={(requestId) =>
                        act(async () => {
                          await collectionFetch(`/api/payments/requests/${requestId}/cancel`, { method: "POST" });
                          return tr("money.collection.thread.requestCancelled");
                        })
                      }
                      onRetry={(ptx) =>
                        act(async () => {
                          const r = await collectionFetch<{ outcome: string }>(`/api/collection/settlements/${ptx}/retry`, { method: "POST", body: "{}" });
                          return r.outcome === "SETTLED" || r.outcome === "ALREADY_SETTLED" ? tr("money.collection.thread.receiptIssued") : tr("money.collection.shared.stillMissing");
                        })
                      }
                      onRefund={(t) => void openRefund(t)}
                    />
                  </li>
                ))}
              </ol>
              <table className="col-thread__table">
                <thead>
                  <tr>
                    <th>{tr("money.collection.thread.thWhen")}</th>
                    <th>{tr("money.collection.thread.thWhat")}</th>
                    <th>{tr("money.collection.thread.thAmount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {thread.events.map((e, i) => {
                    const row = eventDeskRow(e, tr, money);
                    return (
                      <tr
                        key={`${e.kind}-${i}`}
                        className={selectedEvent === i ? "is-selected" : undefined}
                        onClick={() => setSelectedEvent(i)}
                      >
                        <td>{dateTime(e.at)}</td>
                        <td>{row.what}</td>
                        <td>{row.amount}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <aside className="col-thread__pick">
                {selectedEvent == null || !thread.events[selectedEvent] ? (
                  <WarmCard><p style={{ margin: 0, color: W.muted }}>{tr("money.collection.thread.pickEvent")}</p></WarmCard>
                ) : (
                  <EventCard
                    e={thread.events[selectedEvent]}
                    highlighted={(() => {
                      const selected = thread.events[selectedEvent];
                      return selected != null && "requestId" in selected && selected.requestId === anchor;
                    })()}
                    busy={busy}
                    onShare={async (url, amount, currency, invoiceNumber) => {
                      const text = buildPaymentRequestMessage({
                        customerName: thread.customer.name, amount: Number(amount).toLocaleString("he-IL"),
                        currencySymbol: currencySymbol(currency), invoiceNumber, paymentUrl: url, businessName: thread.businessName,
                      });
                      const r = await shareOrCopy(text, url);
                      if (r !== "failed") {
                        recordCollectionAction(
                          r === "shared" ? "SHARE_INITIATED" : "LINK_COPIED",
                          r === "shared" ? "SYSTEM_SHARE" : "CLIPBOARD",
                          { customerId: thread.customer.id },
                        );
                      }
                      setNotice(r === "shared" ? tr("money.collection.shared.shareOpened") : r === "copied" ? tr("money.collection.shared.linkCopied") : tr("money.collection.shared.shareFailed"));
                    }}
                    onCancel={(requestId) =>
                      act(async () => {
                        await collectionFetch(`/api/payments/requests/${requestId}/cancel`, { method: "POST" });
                        return tr("money.collection.thread.requestCancelled");
                      })
                    }
                    onRetry={(ptx) =>
                      act(async () => {
                        const r = await collectionFetch<{ outcome: string }>(`/api/collection/settlements/${ptx}/retry`, { method: "POST", body: "{}" });
                        return r.outcome === "SETTLED" || r.outcome === "ALREADY_SETTLED" ? tr("money.collection.thread.receiptIssued") : tr("money.collection.shared.stillMissing");
                      })
                    }
                    onRefund={(t) => void openRefund(t)}
                  />
                )}
              </aside>
              </div>
            )}
          </>
        ) : null}
      </div>

      <AdaptiveOverlay open={refund !== null} onClose={() => setRefund(null)} variant="confirm" labelledBy="refund-title">
        <div style={{ padding: 20, display: "grid", gap: 10 }}>
          <h2 id="refund-title" style={{ margin: 0, fontSize: 18, color: W.ink }}>{tr("money.collection.thread.refundTitle")}</h2>
          <p style={{ margin: 0, color: W.muted, fontSize: 14 }}>
            {tr("money.collection.thread.refundBody")}
          </p>
          {refundMax === null ? (
            <span style={{ color: W.muted }}>{tr("money.collection.thread.checkingRefund")}</span>
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
                  <dt style={{ margin: 0 }}>{tr("money.collection.thread.paidOriginally")}</dt>
                  <dd style={{ margin: 0, color: W.ink, fontWeight: 700 }}>
                    {money(refundState.settledAmount, refundState.currency)}
                  </dd>
                  <dt style={{ margin: 0 }}>{tr("money.collection.thread.refundedSoFar")}</dt>
                  <dd style={{ margin: 0, color: W.ink }}>
                    {money(refundState.refundedTotal, refundState.currency)}
                  </dd>
                  {refundState.hasUnresolvedRefund ? (
                    <>
                      <dt style={{ margin: 0 }}>{tr("money.collection.thread.pendingVerification")}</dt>
                      <dd style={{ margin: 0, color: W.ink }}>
                        {tr("money.collection.thread.reservedUntil")}
                      </dd>
                    </>
                  ) : null}
                  <dt style={{ margin: 0 }}>{tr("money.collection.thread.refundableNow")}</dt>
                  <dd style={{ margin: 0, color: W.ink, fontWeight: 700 }}>
                    {money(refundState.refundableRemaining, refundState.currency)}
                  </dd>
                </dl>
              ) : null}
              <label htmlFor="refund-amount" style={{ fontWeight: 700 }}>
                {refundState && !refundState.canRefundPartially
                  ? tr("money.collection.thread.amountFullOnly", { amount: money(refundMax, refund?.currency) })
                  : tr("money.collection.thread.amountUpTo", { amount: money(refundMax, refund?.currency) })}
              </label>
              <input id="refund-amount" inputMode="decimal" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value.replace(/[^\d.]/g, ""))} style={warmInputStyle()} />
              <div style={{ display: "flex", gap: 8 }}>
                <WarmButton
                  disabled={busy || !(Number(refundAmount) > 0) || Number(refundAmount) > Number(refundMax)}
                  onClick={() =>
                    refund &&
                    act(async () => {
                      const r = await collectionFetch<{ outcome: RefundApiOutcome }>(`/api/payments/requests/${refund.requestId}/refund`, {
                        method: "POST",
                        body: JSON.stringify({ amount: refundAmount, idempotencyKey: refundKey }),
                      });
                      setRefund(null);
                      return refundOutcomeNotice(r.outcome, tr);
                    })
                  }
                >
                  {tr("money.collection.thread.refundAction", { amount: refundAmount ? money(refundAmount, refund?.currency) : "" })}
                </WarmButton>
                <WarmButton variant="text" onClick={() => setRefund(null)}>{tr("money.collection.thread.cancel")}</WarmButton>
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
  const { t: tr } = useI18n();
  const { money, dateTime } = useCollectionFormat();
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
        <Link href={`/billing/${e.invoiceId}`} style={{ color: W.ink }}>{tr("money.collection.shared.invoiceN", { number: e.number ?? "" })}</Link>,
        money(e.amount, e.currency),
        Number(e.outstanding) > 0 ? <span>{tr("money.collection.thread.remainingToCollect", { amount: money(e.outstanding, e.currency) })}</span> : <WarmPill tone="verified">{tr("money.collection.thread.closed")}</WarmPill>
      );
    case "CREDIT_NOTE_ISSUED":
      return row(<Link href={`/billing/${e.documentId}`} style={{ color: W.ink }}>{tr("money.collection.thread.creditNoteTitle", { number: e.number ?? "" })}</Link>, `−${money(e.amount, e.currency)}`, <span>{tr("money.collection.thread.reduction")}</span>);
    case "REQUEST_CREATED":
      return row(
        tr("money.collection.thread.paymentRequest"),
        money(e.amount, e.currency),
        <>
          {e.invoiceNumber ? <span>{tr("money.collection.shared.invoiceN", { number: e.invoiceNumber })}</span> : <span>{tr("money.collection.thread.noInvoice")}</span>}
          {e.status === "PENDING" ? <WarmPill tone="waiting">{tr("money.collection.shared.waiting")}</WarmPill> : null}
          {e.status === "CANCELLED" ? <WarmPill tone="waiting">{tr("money.collection.thread.cancelledPill")}</WarmPill> : null}
          {e.status === "FAILED" ? <WarmPill tone="late">{tr("money.collection.shared.failed")}</WarmPill> : null}
          {e.status === "EXPIRED" ? <WarmPill tone="late">{tr("money.collection.thread.expired")}</WarmPill> : null}
          {e.status === "PAID" ? <WarmPill tone="verified">{tr("money.collection.shared.paid")}</WarmPill> : null}
        </>,
        e.status === "PENDING" && e.paymentUrl ? (
          <>
            <WarmButton height={40} variant="secondary" onClick={() => onShare(e.paymentUrl!, e.amount, e.currency, e.invoiceNumber)}>{tr("money.collection.shared.shareAgain")}</WarmButton>
            <WarmButton height={40} variant="text" disabled={busy} onClick={() => onCancel(e.requestId)}>{tr("money.collection.shared.cancelRequest")}</WarmButton>
          </>
        ) : null
      );
    case "REQUEST_CANCELLED":
      return row(
        tr("money.collection.thread.requestCancelledTitle"),
        undefined,
        e.paidAfterward ? (
          <span>{tr("money.collection.thread.paidAfterward")}</span>
        ) : (
          <span>{tr("money.collection.thread.stoppedAsking")}</span>
        )
      );
    case "PAYMENT_FAILED":
      return row(tr("money.collection.thread.paymentFailedTitle"), money(e.amount, e.currency), <span>{tr("money.collection.thread.providerDeclined")}</span>);
    case "PAYMENT_VERIFIED": {
      const attention = e.accounting === "RECEIPT_ATTENTION" ? attentionText(e.attentionReason, tr) : null;
      return row(
        tr("money.collection.thread.verifiedTitle"),
        money(e.amount, e.currency),
        <>
          <WarmPill tone="verified">{tr("money.collection.shared.paid")}</WarmPill>
          {e.accounting === "RECEIPT_PENDING" ? <span>{tr("money.collection.shared.receiptPending")}</span> : null}
          {e.accounting === "NO_AUTOMATIC_RECEIPT" ? <span>{tr("money.collection.shared.noAutoReceipt")}</span> : null}
          {attention ? <span>{attention.title}</span> : null}
          <ProviderDocumentNote doc={e.providerDocument} t={tr} />
        </>,
        <>
          {attention ? <WarmButton height={40} disabled={busy} onClick={() => onRetry(e.paymentTransactionId)}>{tr("money.collection.shared.retryReceipt")}</WarmButton> : null}
          <WarmButton height={40} variant="text" onClick={() => onRefund({ requestId: e.requestId, suggested: null, currency: e.currency })}>{tr("money.collection.thread.refundMoney")}</WarmButton>
        </>
      );
    }
    case "RECEIPT_ISSUED":
      return row(
        <Link href={`/billing/${e.receiptId}`} style={{ color: W.ink }}>
          {tr("money.collection.thread.rowReceiptN", { number: e.number ?? "" })}
          {e.automatic ? ` ${tr("money.collection.thread.automatic")}` : ""}
        </Link>,
        money(e.amount, e.currency),
        <>
          {e.allocations.map((a) => (
            <span key={a.invoiceId}>{tr("money.collection.thread.allocated", { amount: money(a.amount, e.currency), number: a.invoiceNumber ?? "" })}</span>
          ))}
          {Number(e.unappliedAmount) > 0 ? <WarmPill tone="partial">{tr("money.collection.thread.unappliedPill", { amount: money(e.unappliedAmount, e.currency) })}</WarmPill> : null}
        </>
      );
    case "REFUND":
      return row(
        tr("money.collection.thread.refundMoney"),
        `−${money(e.amount, e.currency)}`,
        e.outcome === "SETTLED" ? (
          <span>{tr("money.collection.thread.refunded")}</span>
        ) : e.outcome === "PENDING" ? (
          <span>{tr("money.collection.thread.refundPending")}</span>
        ) : (
          <span>{tr("money.collection.thread.refundNotDone")}</span>
        )
      );
  }
}

/** A fresh refund-intent key: 32 hex characters (the server accepts 8–128). */
function newRefundKey(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return "rf-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
