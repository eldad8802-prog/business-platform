"use client";

import BackButton from "@/components/ui/back-button";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useFlowStep } from "@/hooks/useFlowStep";
import { TOKEN } from "@/lib/design/tokens";
import { WarmButton, WarmCard, warmInputStyle } from "@/components/ui/warm/warm-primitives";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { CustomerFinancialThread } from "@/lib/services/billing/collection/customer-financial-thread.service";
import type { CollectionReadiness } from "@/lib/services/billing/collection/collection-readiness.service";
import { buildPaymentRequestMessage } from "@/lib/services/billing/collection/collection-message";
import { currencySymbol, toWhatsAppNumber } from "@/lib/services/billing/collection/collection-display";
import {
  blockerText,
  collectionFetch,
  copyText,
  recordCollectionAction,
  shareOrCopy,
  useCollectionFormat,
  whatsAppHref,
  type BlockerCode,
} from "../collection-client";
import { CustomerPicker } from "../customer-picker";
import { CollectionCurrencyChoice } from "./collection-currency-choice";
import { offerableFrom, requestCurrency, showCurrencyChoice } from "./collection-currency";
import type { CurrencyCode } from "@/lib/money/currency";

const W = TOKEN.warm;
const AD_HOC = "adhoc";

type Created = { id: number; paymentUrl: string | null; amount: string; currency: string };

/**
 * /collection/new — "גבה 450 ₪ מיוסי כהן".
 *
 *   ready? → customer → what for, and how much → create → how to send it
 *
 * Missing setup is shown BEFORE anything is created. The owner never picks a
 * provider and is never sent to the checkout meant for the customer: the link
 * is for the customer, and the owner's next step is to send it.
 */
export function CollectionCreateScreen() {
  const { t: tr } = useI18n();
  const { money } = useCollectionFormat();
  const router = useRouter();
  const params = useSearchParams();
  const [readiness, setReadiness] = useState<CollectionReadiness | null>(null);
  const [customerId, setCustomerId] = useState<number | null>(() => {
    const v = Number(params.get("customerId"));
    return Number.isInteger(v) && v > 0 ? v : null;
  });
  const [loadedThread, setThread] = useState<CustomerFinancialThread | null>(null);
  // The thread shown is only ever the one for the customer currently chosen.
  const thread = customerId !== null && loadedThread?.customer.id === customerId ? loadedThread : null;
  const [target, setTarget] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [chosenCurrency, setChosenCurrency] = useState<CurrencyCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [channelNote, setChannelNote] = useState<string | null>(null);

  // The flow's steps are real history entries (?step=…): back — the button or
  // the browser — walks them in the order the user took them, and the data
  // entered stays (this screen stays mounted). Entered with ?customerId (from a
  // customer thread / the inbox) the flow starts at the details step.
  const [enteredWithCustomer] = useState(() => customerId !== null);
  // ?invoiceId preselects an invoice for the customer the flow was entered with.
  const [entryInvoiceId] = useState(() => Number(params.get("invoiceId")));
  const flow = useFlowStep<"customer" | "details" | "send">({
    steps: enteredWithCustomer ? ["details", "customer", "send"] : ["customer", "details", "send"],
    canShow: (st) => (st === "details" ? customerId !== null : st === "send" ? created !== null : true),
  });

  useEffect(() => {
    collectionFetch<CollectionReadiness>("/api/collection/readiness")
      .then(setReadiness)
      .catch(() => setError(tr("money.collection.create.checkFailed")));
  }, [tr]);

  useEffect(() => {
    if (customerId === null) return;
    let cancelled = false;
    collectionFetch<CustomerFinancialThread>(`/api/collection/customers/${customerId}`)
      .then((t) => {
        if (cancelled) return;
        setThread(t);
        const wanted = entryInvoiceId;
        const chosen = t.openInvoices.find((i) => i.id === wanted) ?? (t.openInvoices.length === 1 ? t.openInvoices[0] : null);
        if (chosen) {
          setTarget(String(chosen.id));
          setAmount(Number(chosen.outstanding).toString());
        } else if (t.openInvoices.length === 0) {
          setTarget(AD_HOC);
        }
      })
      .catch(() => {
        if (!cancelled) setError(tr("money.collection.create.customerLoadFailed"));
      });
    return () => {
      cancelled = true;
    };
    // Only a CHANGE OF CUSTOMER reloads and re-defaults the target/amount.
    // Depending on the search params would re-run on every step change and
    // overwrite what the owner typed when they come back to this step.
  }, [customerId, entryInvoiceId, tr]);

  const invoice = useMemo(
    () => (target && target !== AD_HOC ? thread?.openInvoices.find((i) => String(i.id) === target) ?? null : null),
    [target, thread]
  );
  // Standalone requests may be raised in another currency only when the
  // connected provider supports more than ILS; invoice-backed ones never.
  const offerable = useMemo(() => offerableFrom(readiness?.offerableCurrencies), [readiness]);
  const currencyChoiceShown = showCurrencyChoice({ standalone: target === AD_HOC, offerable });
  const currency = requestCurrency({
    invoiceCurrency: invoice?.currency,
    threadCurrency: thread?.totals.currency,
    chosen: chosenCurrency,
    choiceShown: currencyChoiceShown,
    offerable,
  });

  const amountError = useMemo(() => {
    if (!amount) return null;
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return tr("money.collection.create.amountPositive");
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) return tr("money.collection.create.amountDecimals");
    if (invoice && n > Number(invoice.outstanding)) return tr("money.collection.create.amountMax", { amount: money(invoice.outstanding, invoice.currency) });
    return null;
  }, [amount, invoice, money, tr]);

  async function create() {
    if (!thread || !target || !amount || amountError) return;
    setCreating(true);
    setError(null);
    try {
      const res = await collectionFetch<{ id: number; paymentUrl: string | null; amount: string; currency: string }>(
        "/api/payments/requests",
        {
          method: "POST",
          body: JSON.stringify({
            customerId: thread.customer.id,
            ...(invoice ? { billingDocumentId: invoice.id } : {}),
            amount,
            currency,
          }),
        }
      );
      setCreated({ id: res.id, paymentUrl: res.paymentUrl, amount: res.amount, currency: res.currency });
      // COMPLETED FLOW: the request now exists. "send" replaces the details
      // step and the flow's earlier steps are consumed, so back leaves the
      // finished flow to where it was entered — never into a filled form that
      // would create a duplicate request.
      flow.complete("send", ["customer", "details"]);
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("money.collection.create.createFailed"));
    } finally {
      setCreating(false);
    }
  }

  const message =
    created?.paymentUrl && thread
      ? buildPaymentRequestMessage({
          customerName: thread.customer.name,
          amount: Number(created.amount).toLocaleString("he-IL"),
          currencySymbol: currencySymbol(created.currency),
          invoiceNumber: invoice?.number ?? null,
          paymentUrl: created.paymentUrl,
          businessName: thread.businessName,
        })
      : "";

  return (
    <div className="col-create" style={{ minHeight: "100%", background: W.canvas, padding: "20px 16px 96px" }}>
      <style>{`
        .col-create { max-width: 560px; margin: 0 auto; display: grid; gap: 16px; }
        .col-create__aside { display: none; }
        @media (min-width: 1200px) {
          .col-create { max-width: none; grid-template-columns: minmax(0, 1.15fr) minmax(300px, 400px); align-items: start; column-gap: 28px; padding: 28px 32px 48px; }
          .col-create__head, .col-create__span { grid-column: 1 / -1; }
          .col-create__aside { display: grid; gap: 8px; align-content: start; position: sticky; top: 16px; background: #fff; border: 1px solid rgba(52,60,50,0.08); border-radius: 16px; padding: 16px; }
        }
      `}</style>
        <div className="col-create__head" style={{ display: "grid", gap: 8 }}>
          <div><BackButton /></div>
          <h1 style={{ margin: 0, fontSize: 24, color: W.ink }}>
            {flow.step === "send" && created
              ? tr("money.collection.create.titleSend")
              : flow.step === "details" && thread
                ? tr("money.collection.create.titleDetails", { name: thread.customer.name })
                : tr("money.collection.create.titleCustomer")}
          </h1>
        </div>

        {error ? <div className="col-create__span"><WarmCard><p role="alert" style={{ margin: 0, color: W.clay }}>{error}</p></WarmCard></div> : null}

        {readiness && !readiness.ready ? (
          <div className="col-create__span" style={{ display: "grid", gap: 16 }}>
          {readiness.blockers.map((b) => {
            const t = blockerText(b as BlockerCode, tr);
            return (
              <WarmCard key={b}>
                <h2 style={{ margin: 0, fontSize: 17, color: W.ink }}>{t.title}</h2>
                <p style={{ margin: "6px 0 12px", color: W.muted, fontSize: 14 }}>{t.body}</p>
                <WarmButton onClick={() => router.push(t.href)}>{t.cta}</WarmButton>
              </WarmCard>
            );
          })}
          </div>
        ) : !readiness ? (
          <p className="col-create__span" style={{ color: W.muted }}>{tr("money.collection.create.checking")}</p>
        ) : flow.step === "send" && created ? (
          <>
          <WarmCard>
            <p style={{ margin: 0, color: W.ink, fontSize: 16 }}>
              {tr("money.collection.create.createdBefore")} <strong>{money(created.amount, created.currency)}</strong>{" "}
              {tr("money.collection.create.createdAfter", { name: thread?.customer.name ?? "" })}
            </p>
            {created.paymentUrl ? (
              <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
                <WarmButton
                  fullWidth
                  onClick={() => {
                    window.open(whatsAppHref(toWhatsAppNumber(thread?.customer.phone), message), "_blank", "noopener");
                    // Opening WhatsApp is the whole of what is observed — which is exactly what the
                    // notice below already tells the owner. The record says the same thing.
                    recordCollectionAction("WHATSAPP_OPENED", "WHATSAPP", { customerId: thread?.customer.id, paymentRequestId: created.id });
                    setChannelNote(tr("money.collection.create.whatsappOpened"));
                  }}
                >
                  {tr("money.collection.create.sendWhatsapp")}
                </WarmButton>
                <WarmButton
                  variant="secondary"
                  fullWidth
                  onClick={async () => {
                    const copied = await copyText(message);
                    if (copied) recordCollectionAction("MESSAGE_COPIED", "CLIPBOARD", { customerId: thread?.customer.id, paymentRequestId: created.id });
                    setChannelNote(copied ? tr("money.collection.create.messageCopied") : tr("money.collection.shared.copyFailed"));
                  }}
                >
                  {tr("money.collection.create.copyMessage")}
                </WarmButton>
                <WarmButton
                  variant="text"
                  fullWidth
                  onClick={async () => {
                    const r = await shareOrCopy(message, created.paymentUrl!);
                    if (r !== "failed") {
                      recordCollectionAction(
                        r === "shared" ? "SHARE_INITIATED" : "LINK_COPIED",
                        r === "shared" ? "SYSTEM_SHARE" : "CLIPBOARD",
                        { customerId: thread?.customer.id, paymentRequestId: created.id },
                      );
                    }
                    setChannelNote(r === "shared" ? tr("money.collection.shared.shareOpened") : r === "copied" ? tr("money.collection.shared.linkCopied") : tr("money.collection.shared.shareFailed"));
                  }}
                >
                  {tr("money.collection.create.shareOther")}
                </WarmButton>
                {channelNote ? <p role="status" style={{ margin: 0, color: W.muted, fontSize: 13 }}>{channelNote}</p> : null}
              </div>
            ) : (
              <p style={{ color: W.clay }}>{tr("money.collection.create.noLink")}</p>
            )}
            <div style={{ marginTop: 14 }}>
              <WarmButton variant="text" onClick={() => router.push(`/collection/c/${thread?.customer.id}?request=${created.id}`)}>{tr("money.collection.create.finish")}</WarmButton>
            </div>
          </WarmCard>
          <aside className="col-create__aside">
            <h2 style={{ margin: 0, fontSize: 16, color: W.ink }}>{tr("money.collection.create.beforeSend")}</h2>
            <p style={{ margin: 0, color: W.muted, fontSize: 14, lineHeight: 1.5 }}>
              {thread?.customer.name} · {money(created.amount, created.currency)}
              {invoice?.number ? ` · ${tr("money.collection.shared.invoiceN", { number: invoice.number })}` : ` · ${tr("money.collection.create.noInvoice")}`}
            </p>
            <p style={{ margin: 0, color: W.muted, fontSize: 14, lineHeight: 1.5 }}>
              {tr("money.collection.create.sendNotPaid")}
            </p>
          </aside>
          </>
        ) : flow.step === "customer" ? (
          <>
          <WarmCard>
            <CustomerPicker
              onPick={(c) => {
                setCustomerId(c.id);
                flow.go("details");
              }}
            />
          </WarmCard>
          <aside className="col-create__aside">
            <h2 style={{ margin: 0, fontSize: 16, color: W.ink }}>{tr("money.collection.create.seeBefore")}</h2>
            <p style={{ margin: 0, color: W.muted, fontSize: 14, lineHeight: 1.5 }}>{tr("money.collection.create.seeBeforeBody")}</p>
          </aside>
          </>
        ) : !thread ? (
          <p className="col-create__span" style={{ color: W.muted }}>{tr("money.common.loading")}</p>
        ) : (
          <>
          <WarmCard>
            <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }}>
              <legend style={{ fontWeight: 700, color: W.ink, marginBottom: 6 }}>{tr("money.collection.create.whatFor")}</legend>
              {thread.openInvoices.map((i) => (
                <label key={i.id} style={choiceStyle(target === String(i.id))}>
                  <input
                    type="radio"
                    name="target"
                    checked={target === String(i.id)}
                    onChange={() => {
                      setTarget(String(i.id));
                      setAmount(Number(i.outstanding).toString());
                    }}
                  />
                  <span style={{ flex: 1 }}>{tr("money.collection.shared.invoiceN", { number: i.number ?? "" })}</span>
                  <span style={{ fontWeight: 700 }}>{tr("money.collection.create.remainingN", { amount: money(i.outstanding, i.currency) })}</span>
                </label>
              ))}
              <label style={choiceStyle(target === AD_HOC)}>
                <input type="radio" name="target" checked={target === AD_HOC} onChange={() => { setTarget(AD_HOC); setAmount(""); }} />
                <span>{tr("money.collection.create.notInvoice")}</span>
              </label>
            </fieldset>
            {thread.totals ? (
              <p style={{ margin: "12px 0 0", color: W.muted, fontSize: 13 }}>
                {tr("money.collection.create.openBalance", { amount: money(thread.totals.outstanding, thread.totals.currency ?? "ILS") })}
              </p>
            ) : null}
          </WarmCard>
          <WarmCard>
            <CollectionCurrencyChoice shown={currencyChoiceShown} offerable={offerable} value={currency} onChange={setChosenCurrency} />
            {target ? (
              <div style={{ marginTop: 14, display: "grid", gap: 6 }}>
                <label htmlFor="amount" style={{ fontWeight: 700, color: W.ink }}>{tr("money.collection.create.howMuch", { symbol: currencySymbol(currency) })}</label>
                <input
                  id="amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                  style={warmInputStyle({ fontSize: 20, fontWeight: 700 })}
                  aria-invalid={amountError ? true : undefined}
                />
                {amountError ? <span role="alert" style={{ color: W.clay, fontSize: 13 }}>{amountError}</span> : null}
                {invoice && Number(amount) > 0 && Number(amount) < Number(invoice.outstanding) && !amountError ? (
                  <span style={{ color: W.muted, fontSize: 13 }}>
                    {tr("money.collection.create.partial", { amount: money(Number(invoice.outstanding) - Number(amount), invoice.currency) })}
                  </span>
                ) : null}
              </div>
            ) : null}

            <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
              <WarmButton disabled={!target || !amount || !!amountError || creating} onClick={() => void create()}>
                {creating
                  ? tr("money.collection.create.creatingRequest")
                  : amount && !amountError
                    ? tr("money.collection.create.createFor", { amount: money(amount, currency) })
                    : tr("money.collection.create.createRequest")}
              </WarmButton>
              {/* Forward to the customer step (an entry), not a reset: back from
                  it returns to this customer with what was entered. */}
              <WarmButton variant="text" onClick={() => flow.go("customer")}>{tr("money.collection.create.otherCustomer")}</WarmButton>
            </div>
          </WarmCard>
          </>
        )}
    </div>
  );
}

function choiceStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: 10, minHeight: 48, padding: "8px 12px", borderRadius: 12, cursor: "pointer",
    border: `1px solid ${active ? W.tealDeep : W.line}`, background: active ? W.surface2 : W.surface, color: W.ink, fontSize: 15,
  };
}
