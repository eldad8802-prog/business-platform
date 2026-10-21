"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useEntryState } from "@/hooks/useEntryState";
import { TOKEN } from "@/lib/design/tokens";
import { WarmButton, WarmCard, WarmPill } from "@/components/ui/warm/warm-primitives";
import { AdaptiveOverlay } from "@/components/ui/adaptive-overlay";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";
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
  recordCollectionAction,
  shareOrCopy,
  useCollectionFormat,
} from "../collection-client";
import { CustomerPicker } from "../customer-picker";

const W = TOKEN.warm;

type Segment = "toCollect" | "waiting" | "attention" | "paid";

const SEGMENTS: { key: Segment; label: MessageKey }[] = [
  { key: "toCollect", label: "money.collection.inbox.segToCollect" },
  { key: "waiting", label: "money.collection.shared.waiting" },
  { key: "attention", label: "money.collection.shared.needsAttention" },
  { key: "paid", label: "money.collection.shared.paid" },
];

/**
 * /collection — the owner's collection action inbox.
 *
 * Stage-aware: it opens on "דורש טיפול" when something needs a decision,
 * otherwise on "צריך לגבות". The primary action is always "גבה"; every row
 * carries its own next step. Provider names never appear here.
 */
export function CollectionInboxScreen() {
  const { t } = useI18n();
  const { money, shortDate } = useCollectionFormat();
  const router = useRouter();
  const [inbox, setInbox] = useState<CollectionInbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [segment, setSegment] = useEntryState<Segment | null>("segment", null);
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
        if (!cancelled) setError(t("money.collection.inbox.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, t]);

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
      setNotice(t("money.collection.inbox.cancelled"));
      setConfirmCancel(null);
      load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t("money.collection.inbox.cancelFailed"));
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
          ? t("money.collection.inbox.receiptAllocated")
          : r.outcome === "RETRY_SCHEDULED"
            ? t("money.collection.inbox.retryScheduled")
            : t("money.collection.shared.stillMissing")
      );
      setNameCustomerFor(null);
      load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t("money.collection.inbox.retryFailed"));
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
    setNotice(r === "copied" ? t("money.collection.shared.linkCopied") : r === "shared" ? t("money.collection.shared.shareOpened") : t("money.collection.shared.copyFailed"));
  }

  const paidAll = [...(inbox?.paid ?? []), ...olderPaid];

  return (
    <div style={{ minHeight: "100%", background: W.canvas, padding: "20px 16px 96px" }}>
      <style>{`
        .col-desk { max-width: 760px; margin: 0 auto; display: grid; gap: 16px; }
        .col-desk__facts, .col-desk__table { display: none; }
        @media (min-width: 1200px) {
          .col-desk {
            max-width: none;
            grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
            align-items: start;
            gap: 20px 28px;
          }
          .col-desk__side { position: sticky; top: 16px; display: grid !important; gap: 12px; align-content: start; justify-items: stretch; }
          .col-desk__queue { display: grid; gap: 12px; min-width: 0; }
          .col-desk__span { grid-column: 1 / -1; }
          .col-desk__facts { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
          .col-desk__facts li { display: flex; justify-content: space-between; gap: 12px; background: #fff; border: 1px solid rgba(52,60,50,0.08); border-radius: 12px; padding: 10px 12px; font-size: 13px; }
          .col-desk__table { display: block; background: #fff; border: 1px solid rgba(52,60,50,0.08); border-radius: 16px; overflow: auto; }
          .col-desk__table table { width: 100%; border-collapse: collapse; }
          .col-desk__table th, .col-desk__table td { text-align: start; padding: 12px 14px; border-bottom: 1px solid rgba(52,60,50,0.08); font-size: 14px; }
          .col-desk__table th { font-size: 12px; color: #6d675f; font-weight: 600; }
          .col-desk__cards { display: none !important; }
        }
      `}</style>
      <div className="col-desk">
        <header className="col-desk__side" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, color: W.ink }}>{t("money.collection.inbox.title")}</h1>
            {inbox ? (
              <p style={{ margin: "4px 0 0", color: W.muted, fontSize: 14 }}>
                {inbox.summary.toCollect.count > 0
                  ? t(inbox.summary.toCollect.count === 1 ? "money.collection.inbox.summaryOne" : "money.collection.inbox.summaryMany", {
                      amount: money(inbox.summary.toCollect.amount, inbox.summary.toCollect.currency ?? "ILS"),
                      count: inbox.summary.toCollect.count,
                    })
                  : t("money.collection.inbox.noDebts")}
              </p>
            ) : null}
          </div>
          <WarmButton onClick={() => router.push("/collection/new")}>{t("money.collection.shared.collect")}</WarmButton>
          {inbox ? (
            <ul className="col-desk__facts">
              <li><span>{t("money.collection.inbox.segToCollect")}</span><strong>{money(inbox.summary.toCollect.amount, inbox.summary.toCollect.currency ?? "ILS")}</strong></li>
              <li><span>{t("money.collection.shared.waiting")}</span><strong>{inbox.summary.waiting.count}</strong></li>
              <li><span>{t("money.collection.shared.needsAttention")}</span><strong>{inbox.summary.attention.count}</strong></li>
              <li><span>{t("money.collection.inbox.paidRecent")}</span><strong>{money(inbox.summary.paidRecent.amount, "ILS")}</strong></li>
            </ul>
          ) : null}
        </header>

        {notice ? (
          <div className="col-desk__span" role="status" style={{ background: W.surface2, border: `1px solid ${W.line}`, borderRadius: 12, padding: "10px 12px", color: W.ink, fontSize: 14, display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} aria-label={t("money.collection.inbox.dismissNotice")} style={{ background: "none", border: 0, color: W.muted, cursor: "pointer" }}>✕</button>
          </div>
        ) : null}

        {error ? (
          <WarmCard>
            <p style={{ margin: 0, color: W.ink }}>{error}</p>
            <div style={{ marginTop: 12 }}>
              <WarmButton variant="secondary" onClick={() => load()}>{t("money.collection.inbox.tryAgain")}</WarmButton>
            </div>
          </WarmCard>
        ) : null}

        {inbox && segment ? (
          <div className="col-desk__queue">
            <nav role="tablist" aria-label={t("money.collection.inbox.tabsAria")} style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, background: W.surface2, padding: 4, borderRadius: 14 }}>
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
                    {t(s.label)}
                    {counts[s.key] > 0 ? <span style={{ marginInlineStart: 6, color: s.key === "attention" ? W.clay : W.muted2 }}>{counts[s.key]}</span> : null}
                  </button>
                );
              })}
            </nav>

            <section role="tabpanel" style={{ display: "grid", gap: 10 }}>
              {segment === "toCollect" &&
                (inbox.toCollect.length === 0 ? (
                  <Empty text={t("money.collection.inbox.emptyToCollect")} />
                ) : (
                  <>
                    <div className="col-desk__table">
                      <table>
                        <thead>
                          <tr>
                            <th>{t("money.collection.inbox.thCustomer")}</th>
                            <th>{t("money.collection.inbox.thInvoices")}</th>
                            <th>{t("money.collection.inbox.thSince")}</th>
                            <th>{t("money.collection.inbox.thBalance")}</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {inbox.toCollect.map((c, i) => (
                            <tr key={c.customerId ?? `u${i}`}>
                              <td>{c.customerName ?? t("money.collection.shared.unnamedCustomer")}</td>
                              <td>
                                {c.invoices.length === 1
                                  ? c.invoices[0]?.documentNumber ?? t("money.collection.inbox.oneInvoice")
                                  : t("money.collection.inbox.invoicesMany", { count: c.invoices.length })}
                              </td>
                              <td>{c.awaitingSince ? shortDate(c.awaitingSince) : "—"}</td>
                              <td>{money(c.totalOutstanding, c.currency)}</td>
                              <td>
                                {c.customerId ? (
                                  <WarmButton height={36} onClick={() => router.push(`/collection/new?customerId=${c.customerId}`)}>{t("money.collection.shared.collect")}</WarmButton>
                                ) : null}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="col-desk__cards" style={{ display: "grid", gap: 10 }}>
                      {inbox.toCollect.map((c, i) => <DebtRow key={c.customerId ?? `u${i}`} c={c} />)}
                    </div>
                  </>
                ))}

              {segment === "waiting" &&
                (inbox.waiting.length === 0 ? (
                  <Empty text={t("money.collection.inbox.emptyWaiting")} />
                ) : (
                  inbox.waiting.map((w) => (
                    <WarmCard key={w.requestId}>
                      <RowHead title={w.customerName ?? t("money.collection.shared.customer")} amount={money(w.amount, w.currency)} href={w.customerId ? `/collection/c/${w.customerId}?request=${w.requestId}` : undefined} />
                      <Meta>
                        {t("money.collection.inbox.requestCreated", { date: shortDate(w.createdAt) })}
                        {w.invoiceNumber ? ` · ${t("money.collection.shared.invoiceN", { number: w.invoiceNumber })}` : ""} ·{" "}
                        <WarmPill tone="waiting">{t("money.collection.shared.waiting")}</WarmPill>
                      </Meta>
                      <Actions>
                        {w.paymentUrl ? <WarmButton variant="secondary" height={40} onClick={() => void shareRequest(w)}>{t("money.collection.shared.shareAgain")}</WarmButton> : null}
                        {w.paymentUrl ? (
                          <WarmButton variant="text" height={40} onClick={async () => {
                            const copied = await copyText(w.paymentUrl!);
                            if (copied) recordCollectionAction("LINK_COPIED", "CLIPBOARD", { customerId: w.customerId, paymentRequestId: w.requestId });
                            setNotice(copied ? t("money.collection.shared.linkCopied") : t("money.collection.shared.copyFailed"));
                          }}>{t("money.collection.inbox.copyLink")}</WarmButton>
                        ) : null}
                        <WarmButton variant="text" height={40} onClick={() => setConfirmCancel(w)}>{t("money.collection.shared.cancelRequest")}</WarmButton>
                      </Actions>
                    </WarmCard>
                  ))
                ))}

              {segment === "attention" &&
                (inbox.attention.length === 0 ? (
                  <Empty text={t("money.collection.inbox.emptyAttention")} />
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
                    <Empty text={t("money.collection.inbox.emptyPaid")} />
                  ) : (
                    paidAll.map((p) => <PaidRow key={p.paymentTransactionId ?? p.requestId} p={p} />)
                  )}
                  {olderCursor ? (
                    <WarmButton variant="secondary" onClick={() => void loadOlder()}>{t("money.collection.inbox.showOlder")}</WarmButton>
                  ) : null}
                </>
              )}
            </section>
          </div>
        ) : !error ? (
          <p className="col-desk__queue" style={{ color: W.muted, textAlign: "center" }}>{t("money.common.loading")}</p>
        ) : null}
      </div>

      <AdaptiveOverlay open={confirmCancel !== null} onClose={() => setConfirmCancel(null)} variant="confirm" labelledBy="cancel-title">
        <div style={{ padding: 20, display: "grid", gap: 12 }}>
          <h2 id="cancel-title" style={{ margin: 0, fontSize: 18, color: W.ink }}>{t("money.collection.inbox.cancelTitle")}</h2>
          <p style={{ margin: 0, color: W.muted, fontSize: 14 }}>
            {t("money.collection.inbox.cancelBody")}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <WarmButton disabled={busy} onClick={() => confirmCancel && void cancelRequest(confirmCancel)}>{t("money.collection.shared.cancelRequest")}</WarmButton>
            <WarmButton variant="text" onClick={() => setConfirmCancel(null)}>{t("money.collection.shared.back")}</WarmButton>
          </div>
        </div>
      </AdaptiveOverlay>

      <AdaptiveOverlay open={nameCustomerFor !== null} onClose={() => setNameCustomerFor(null)} variant="form" labelledBy="name-customer-title">
        <div style={{ padding: 20, display: "grid", gap: 12 }}>
          <h2 id="name-customer-title" style={{ margin: 0, fontSize: 18, color: W.ink }}>{t("money.collection.inbox.whoPaid")}</h2>
          <p style={{ margin: 0, color: W.muted, fontSize: 14 }}>{t("money.collection.inbox.whoPaidBody")}</p>
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
  const { t } = useI18n();
  const { money, shortDate } = useCollectionFormat();
  const router = useRouter();
  const invoiceCount = c.invoices.length;
  return (
    <WarmCard>
      <RowHead
        title={c.customerName ?? t("money.collection.shared.unnamedCustomer")}
        amount={money(c.totalOutstanding, c.currency)}
        href={c.customerId ? `/collection/c/${c.customerId}` : undefined}
      />
      <Meta>
        {invoiceCount === 1 ? t("money.collection.inbox.debtOneOpen") : t("money.collection.inbox.debtManyOpen", { count: invoiceCount })}
        {c.awaitingSince ? ` · ${t("money.collection.inbox.waitingSince", { date: shortDate(c.awaitingSince) })}` : ""}
        {c.openRequestCount > 0 ? ` · ${t("money.collection.inbox.hasOpenRequest")}` : ""}
      </Meta>
      <Actions>
        {c.customerId ? (
          <WarmButton height={40} onClick={() => router.push(`/collection/new?customerId=${c.customerId}`)}>
            {t("money.collection.inbox.collectAmount", { amount: money(c.totalOutstanding, c.currency) })}
          </WarmButton>
        ) : (
          <span style={{ color: W.muted, fontSize: 13 }}>{t("money.collection.inbox.assignToCollect")}</span>
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
  const { t } = useI18n();
  const { money } = useCollectionFormat();
  const router = useRouter();
  const r = a.request;
  const thread = r.customerId ? `/collection/c/${r.customerId}?request=${r.requestId}` : undefined;
  if (a.kind === "PAYMENT_FAILED" || a.kind === "LINK_EXPIRED") {
    return (
      <WarmCard>
        <RowHead title={r.customerName ?? t("money.collection.shared.customer")} amount={money(r.amount, r.currency)} href={thread} />
        <Meta>
          <WarmPill tone="late">{a.kind === "PAYMENT_FAILED" ? t("money.collection.shared.failed") : t("money.collection.inbox.linkExpired")}</WarmPill>
          {" "}
          {a.kind === "PAYMENT_FAILED" ? t("money.collection.inbox.failedBody") : t("money.collection.inbox.expiredBody")}
        </Meta>
        <Actions>
          {r.customerId ? (
            <WarmButton height={40} onClick={() => router.push(`/collection/new?customerId=${r.customerId}${r.invoiceId ? `&invoiceId=${r.invoiceId}` : ""}`)}>
              {t("money.collection.inbox.sendNewRequest")}
            </WarmButton>
          ) : null}
        </Actions>
      </WarmCard>
    );
  }
  if (a.kind === "RECEIPT_ATTENTION") {
    const att = attentionText(a.reason, t);
    return (
      <WarmCard>
        <RowHead title={r.customerName ?? t("money.collection.inbox.receivedPayment")} amount={money(r.amount, r.currency)} href={thread} />
        <Meta><WarmPill tone="partial">{t("money.collection.shared.needsAttention")}</WarmPill> {t("money.collection.inbox.attentionLine", { title: att.title })}</Meta>
        <Actions>
          {att.action === "NAME_CUSTOMER" ? (
            <WarmButton height={40} disabled={busy} onClick={() => onNameCustomer(a.paymentTransactionId)}>{t("money.collection.inbox.pickCustomer")}</WarmButton>
          ) : null}
          {att.action === "FIX_BUSINESS" ? (
            <WarmButton height={40} onClick={() => router.push("/business")}>{t("money.collection.inbox.fixBusiness")}</WarmButton>
          ) : null}
          <WarmButton variant={att.action === "RETRY" ? "primary" : "secondary"} height={40} disabled={busy} onClick={() => onRetry(a.paymentTransactionId)}>
            {t("money.collection.shared.retryReceipt")}
          </WarmButton>
        </Actions>
      </WarmCard>
    );
  }
  if (a.kind !== "UNAPPLIED_EXCESS") return null;
  return (
    <WarmCard>
      <RowHead title={r.customerName ?? t("money.collection.shared.customer")} amount={money(a.unappliedAmount, r.currency)} href={thread} />
      <Meta>
        <WarmPill tone="partial">{t("money.collection.inbox.excess")}</WarmPill>
        {t("money.collection.inbox.excessBody", { amount: money(a.unappliedAmount, r.currency) })}
        {Number(a.refundedAmount) > 0 ? ` (${t("money.collection.inbox.excessRefunded", { amount: money(a.refundedAmount, r.currency) })})` : ""}.
      </Meta>
      <Actions>
        {thread ? <WarmButton height={40} onClick={() => router.push(thread)}>{t("money.collection.inbox.handleExcess")}</WarmButton> : null}
      </Actions>
    </WarmCard>
  );
}

function PaidRow({ p }: { p: InboxPaidItem }) {
  const { t } = useI18n();
  const { money, shortDate } = useCollectionFormat();
  const line =
    p.accounting === "RECEIPTED"
      ? `${t("money.collection.inbox.receiptIssued", { number: p.receiptNumber ?? "" })}${Number(p.unappliedAmount ?? 0) > 0 ? ` · ${t("money.collection.inbox.excessN", { amount: money(p.unappliedAmount!, p.currency) })}` : ""}`
      : p.accounting === "RECEIPT_PENDING"
        ? t("money.collection.shared.receiptPending")
        : p.accounting === "RECEIPT_ATTENTION"
          ? t("money.collection.inbox.receiptAttention")
          : t("money.collection.shared.noAutoReceipt");
  return (
    <WarmCard>
      <RowHead title={p.customerName ?? t("money.collection.shared.customer")} amount={money(p.amount, p.currency)} href={p.customerId ? `/collection/c/${p.customerId}?request=${p.requestId}` : undefined} />
      <Meta>
        <WarmPill tone="verified">{t("money.collection.shared.paid")}</WarmPill> {shortDate(p.paidAt)}
        {p.invoiceNumber ? ` · ${t("money.collection.shared.invoiceN", { number: p.invoiceNumber })}` : ""} · {line}
      </Meta>
    </WarmCard>
  );
}
