"use client";

import { TOKEN } from "@/lib/design/tokens";
import { WarmButton, WarmCard, WarmTimeline, type WarmTimelineStep } from "@/components/ui/warm/warm-primitives";
import {
  fmtDateTime,
  money,
  statusView,
  type CollectionDetailApi,
} from "@/components/payments/collection-format";

const W = TOKEN.warm;

/**
 * Collection detail body — read-only ledger. Presentational: it receives the
 * already-fetched detail and the share/copy handlers. Shows ONLY what the API
 * backs (status · amount · description · created→paid→verified timeline · share/
 * copy of the existing payment link). No customer name, no invoice, no due date,
 * no aging, no channel, no server actions — none of those exist in the model.
 *
 * The share button reads "שלח קישור" (send link), not "שלח שוב" (resend): the
 * real action is sharing the existing payment URL (native share sheet, clipboard
 * fallback) — no server resend exists, so the copy reflects the true action.
 */
export function CollectionDetail({
  detail,
  copied,
  onShare,
  onCopy,
}: {
  detail: CollectionDetailApi;
  copied: boolean;
  onShare: (url: string) => void;
  onCopy: (url: string) => void;
}) {
  const { request, transactions } = detail;
  const sv = statusView(request.status);
  const isPaid = sv.verified;
  const paidMoment = request.paidAt ?? transactions[0]?.createdAt ?? null;

  const steps: WarmTimelineStep[] = [
    { title: "הגבייה נוצרה", meta: fmtDateTime(request.createdAt), done: true, now: !isPaid },
    { title: "הלקוח שילם", meta: isPaid ? fmtDateTime(paidMoment) : "ממתין לתשלום מהלקוח", done: isPaid },
    { title: "נגבה ואומת", meta: isPaid ? fmtDateTime(paidMoment) : "אימות דרך ספק הגבייה", done: isPaid },
  ];

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 18, fontWeight: TOKEN.weight.semibold, color: W.ink, letterSpacing: "-0.2px" }}>
          {request.description || "גבייה"}
        </div>
      </div>

      <WarmCard style={{ textAlign: "center", marginBottom: 22 }} padding={18}>
        <div style={{ fontSize: 12, fontWeight: TOKEN.weight.semibold, color: W.muted, marginBottom: 8 }}>
          מצב הגבייה
        </div>
        <div
          style={{
            fontSize: 20,
            fontWeight: TOKEN.weight.semibold,
            letterSpacing: "-0.2px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
            color: sv.verified ? W.status.verified.ink : sv.late ? W.status.late.ink : W.muted,
          }}
        >
          {sv.verified ? (
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: "rgba(36, 105, 102, 0.1)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke={W.status.verified.ink} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </span>
          ) : null}
          {sv.label}
        </div>
        <div style={{ fontSize: 15, fontWeight: TOKEN.weight.semibold, color: W.ink, marginTop: 10, fontVariantNumeric: "tabular-nums" }}>
          {money(request.amount, request.currency)}
        </div>
      </WarmCard>

      <WarmTimeline steps={steps} />

      {isPaid ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            fontSize: 11.5,
            color: W.muted2,
            marginTop: 18,
          }}
        >
          <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: W.status.verified.ink }} />
          אומת דרך ספק הגבייה
        </div>
      ) : request.paymentUrl ? (
        <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
          <WarmButton variant="primary" height={48} fullWidth onClick={() => onShare(request.paymentUrl!)}>
            שלח קישור
          </WarmButton>
          <WarmButton variant="secondary" height={48} fullWidth onClick={() => onCopy(request.paymentUrl!)}>
            {copied ? "הועתק" : "העתק קישור"}
          </WarmButton>
        </div>
      ) : null}
    </>
  );
}
