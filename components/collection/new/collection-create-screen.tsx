"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { WarmButton, WarmCard, warmInputStyle } from "@/components/ui/warm/warm-primitives";
import type { CustomerFinancialThread } from "@/lib/services/billing/collection/customer-financial-thread.service";
import type { CollectionReadiness } from "@/lib/services/billing/collection/collection-readiness.service";
import { buildPaymentRequestMessage } from "@/lib/services/billing/collection/collection-message";
import { currencySymbol, toWhatsAppNumber } from "@/lib/services/billing/collection/collection-display";
import {
  BLOCKER_TEXT,
  collectionFetch,
  copyText,
  money,
  recordCollectionAction,
  shareOrCopy,
  whatsAppHref,
  type BlockerCode,
} from "../collection-client";
import { CustomerPicker } from "../customer-picker";

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
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [channelNote, setChannelNote] = useState<string | null>(null);

  useEffect(() => {
    collectionFetch<CollectionReadiness>("/api/collection/readiness")
      .then(setReadiness)
      .catch(() => setError("לא הצלחנו לבדוק אם אפשר לגבות כרגע."));
  }, []);

  useEffect(() => {
    if (customerId === null) return;
    let cancelled = false;
    collectionFetch<CustomerFinancialThread>(`/api/collection/customers/${customerId}`)
      .then((t) => {
        if (cancelled) return;
        setThread(t);
        const wanted = Number(params.get("invoiceId"));
        const chosen = t.openInvoices.find((i) => i.id === wanted) ?? (t.openInvoices.length === 1 ? t.openInvoices[0] : null);
        if (chosen) {
          setTarget(String(chosen.id));
          setAmount(Number(chosen.outstanding).toString());
        } else if (t.openInvoices.length === 0) {
          setTarget(AD_HOC);
        }
      })
      .catch(() => {
        if (!cancelled) setError("לא הצלחנו לטעון את הלקוח.");
      });
    return () => {
      cancelled = true;
    };
  }, [customerId, params]);

  const invoice = useMemo(
    () => (target && target !== AD_HOC ? thread?.openInvoices.find((i) => String(i.id) === target) ?? null : null),
    [target, thread]
  );
  const currency = invoice?.currency ?? thread?.totals.currency ?? "ILS";

  const amountError = useMemo(() => {
    if (!amount) return null;
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return "הסכום צריך להיות גדול מאפס";
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) return "עד שתי ספרות אחרי הנקודה";
    if (invoice && n > Number(invoice.outstanding)) return `אפשר לגבות עד ${money(invoice.outstanding, invoice.currency)} על החשבונית הזו`;
    return null;
  }, [amount, invoice]);

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
    } catch (e) {
      setError(e instanceof Error ? e.message : "לא הצלחנו ליצור בקשת תשלום");
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
    <div dir="rtl" style={{ minHeight: "100%", background: W.canvas, padding: "20px 16px 96px" }}>
      <div style={{ maxWidth: 560, margin: "0 auto", display: "grid", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Link href="/collection" style={{ color: W.muted, textDecoration: "none", fontSize: 14 }}>→ גבייה</Link>
        </div>
        <h1 style={{ margin: 0, fontSize: 24, color: W.ink }}>
          {created ? "הבקשה מוכנה — איך לשלוח?" : thread ? `גבייה מ${thread.customer.name}` : "ממי לגבות?"}
        </h1>

        {error ? <WarmCard><p role="alert" style={{ margin: 0, color: W.clay }}>{error}</p></WarmCard> : null}

        {readiness && !readiness.ready ? (
          readiness.blockers.map((b) => {
            const t = BLOCKER_TEXT[b as BlockerCode];
            return (
              <WarmCard key={b}>
                <h2 style={{ margin: 0, fontSize: 17, color: W.ink }}>{t.title}</h2>
                <p style={{ margin: "6px 0 12px", color: W.muted, fontSize: 14 }}>{t.body}</p>
                <WarmButton onClick={() => router.push(t.href)}>{t.cta}</WarmButton>
              </WarmCard>
            );
          })
        ) : !readiness ? (
          <p style={{ color: W.muted }}>בודק…</p>
        ) : created ? (
          <WarmCard>
            <p style={{ margin: 0, color: W.ink, fontSize: 16 }}>
              בקשת תשלום של <strong>{money(created.amount, created.currency)}</strong> מ{thread?.customer.name} נוצרה.
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
                    setChannelNote("וואטסאפ נפתח עם ההודעה. Dubiz לא רואה אם ההודעה נשלחה.");
                  }}
                >
                  שליחה בוואטסאפ
                </WarmButton>
                <WarmButton
                  variant="secondary"
                  fullWidth
                  onClick={async () => {
                    const copied = await copyText(message);
                    if (copied) recordCollectionAction("MESSAGE_COPIED", "CLIPBOARD", { customerId: thread?.customer.id, paymentRequestId: created.id });
                    setChannelNote(copied ? "ההודעה עם הקישור הועתקה." : "לא הצלחנו להעתיק.");
                  }}
                >
                  העתק הודעה וקישור
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
                    setChannelNote(r === "shared" ? "נפתח חלון השיתוף." : r === "copied" ? "הקישור הועתק." : "לא הצלחנו לשתף.");
                  }}
                >
                  שיתוף בדרך אחרת
                </WarmButton>
                {channelNote ? <p role="status" style={{ margin: 0, color: W.muted, fontSize: 13 }}>{channelNote}</p> : null}
              </div>
            ) : (
              <p style={{ color: W.clay }}>הבקשה נוצרה אבל לא התקבל קישור תשלום. נסו ליצור בקשה חדשה.</p>
            )}
            <div style={{ marginTop: 14 }}>
              <WarmButton variant="text" onClick={() => router.push(`/collection/c/${thread?.customer.id}?request=${created.id}`)}>סיום — לתיק הלקוח</WarmButton>
            </div>
          </WarmCard>
        ) : !thread ? (
          <WarmCard>
            <CustomerPicker onPick={(c) => setCustomerId(c.id)} />
          </WarmCard>
        ) : (
          <WarmCard>
            <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }}>
              <legend style={{ fontWeight: 700, color: W.ink, marginBottom: 6 }}>על מה?</legend>
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
                  <span style={{ flex: 1 }}>חשבונית {i.number ?? ""}</span>
                  <span style={{ fontWeight: 700 }}>נותר {money(i.outstanding, i.currency)}</span>
                </label>
              ))}
              <label style={choiceStyle(target === AD_HOC)}>
                <input type="radio" name="target" checked={target === AD_HOC} onChange={() => { setTarget(AD_HOC); setAmount(""); }} />
                <span>תשלום שלא קשור לחשבונית</span>
              </label>
            </fieldset>

            {target ? (
              <div style={{ marginTop: 14, display: "grid", gap: 6 }}>
                <label htmlFor="amount" style={{ fontWeight: 700, color: W.ink }}>כמה לגבות? ({currencySymbol(currency)})</label>
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
                  <span style={{ color: W.muted, fontSize: 13 }}>גבייה חלקית — יישארו {money(Number(invoice.outstanding) - Number(amount), invoice.currency)} פתוחים.</span>
                ) : null}
              </div>
            ) : null}

            <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
              <WarmButton disabled={!target || !amount || !!amountError || creating} onClick={() => void create()}>
                {creating ? "יוצר בקשה…" : amount && !amountError ? `צור בקשה על ${money(amount, currency)}` : "צור בקשת תשלום"}
              </WarmButton>
              <WarmButton variant="text" onClick={() => { setCustomerId(null); setTarget(null); setAmount(""); }}>לקוח אחר</WarmButton>
            </div>
          </WarmCard>
        )}
      </div>
    </div>
  );
}

function choiceStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: 10, minHeight: 48, padding: "8px 12px", borderRadius: 12, cursor: "pointer",
    border: `1px solid ${active ? W.tealDeep : W.line}`, background: active ? W.surface2 : W.surface, color: W.ink, fontSize: 15,
  };
}
