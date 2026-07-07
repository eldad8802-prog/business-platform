"use client";

/**
 * Collection Detail (Ledger) — read-only, warm design language.
 *
 * Source of truth: GET /api/payments/requests/[id] (real, read-only) →
 * { request, transactions, audit }. Renders the two truth states only
 * (ממתין · נגבה ואומת) and a business-milestone timeline. NEVER shows refund,
 * receipt, "deposited", or a manual "mark paid" — none of those exist.
 *
 * Honest data limits (flagged, not faked):
 *  - No `sentAt`/channel in the data model → the v3 "נשלח ללקוח" milestone is
 *    OMITTED rather than fabricated. Milestones shown are only those the API
 *    actually backs: created → paid → verified.
 *  - No payee name in the model (only description) → the header shows the
 *    description, never an invented name.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { TOKEN } from "@/lib/design/tokens";
import BackButton from "@/components/ui/back-button";
import {
  WarmButton,
  WarmCard,
  WarmTimeline,
  type WarmTimelineStep,
} from "@/components/ui/warm/warm-primitives";

const W = TOKEN.warm;

type DetailApi = {
  request: {
    id: number;
    status: string;
    amount: string;
    currency: string;
    description: string | null;
    paymentUrl: string | null;
    createdAt: string;
    paidAt: string | null;
  };
  transactions: { id: number; createdAt: string }[];
  audit: { id: number; eventType: string; occurredAt: string }[];
};

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; detail: DetailApi };

function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

function fmt(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("he-IL", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function fmtAmount(amount: string, currency: string): string {
  const n = Number(amount);
  const symbol = currency === "ILS" ? "₪" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  if (!Number.isFinite(n)) return `${symbol}${amount}`;
  return `${symbol}${n.toLocaleString("he-IL")}`;
}

/** Two truth states + honest lifecycle labels (never a faked settlement truth). */
function statusView(status: string): { label: string; verified: boolean; late: boolean } {
  switch (status) {
    case "PAID":
      return { label: "נגבה ואומת", verified: true, late: false };
    case "FAILED":
      return { label: "התשלום לא הושלם", verified: false, late: true };
    case "EXPIRED":
      return { label: "פג תוקף", verified: false, late: true };
    case "CANCELLED":
      return { label: "הגבייה בוטלה", verified: false, late: false };
    default:
      return { label: "ממתין לתשלום", verified: false, late: false };
  }
}

export default function CollectionDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    const token = getAuthToken();
    if (!token) {
      router.replace("/login");
      return;
    }
    try {
      const res = await fetch(`/api/payments/requests/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) {
        setState({ status: "error" });
        return;
      }
      const detail = (await res.json()) as DetailApi;
      setState({ status: "ready", detail });
    } catch {
      setState({ status: "error" });
    }
  }, [id, router]);

  useEffect(() => {
    if (id) void load();
  }, [id, load]);

  async function shareLink(url: string) {
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // user cancelled share — no-op
    }
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // ignore
    }
  }

  return (
    <div dir="rtl" style={{ minHeight: "100%", background: W.canvas, padding: "20px 20px 40px" }}>
      <div style={{ maxWidth: 440, margin: "0 auto" }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <h1 style={{ fontSize: 17, fontWeight: TOKEN.weight.semibold, color: W.ink }}>גבייה</h1>
          <BackButton />
        </header>

        {state.status === "loading" ? (
          <p style={{ fontSize: 13, color: W.muted2, textAlign: "center", marginTop: 40 }}>
            טוען…
          </p>
        ) : state.status === "error" ? (
          <WarmCard style={{ textAlign: "center" } as React.CSSProperties}>
            <p style={{ fontSize: 14, color: W.muted, lineHeight: 1.6 }}>
              לא הצלחנו לטעון את הגבייה.
            </p>
            <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}>
              <WarmButton variant="secondary" height={44} onClick={() => void load()}>
                נסה שוב
              </WarmButton>
            </div>
          </WarmCard>
        ) : (
          <DetailBody
            detail={state.detail}
            copied={copied}
            onShare={shareLink}
            onCopy={copyLink}
          />
        )}
      </div>
    </div>
  );
}

function DetailBody({
  detail,
  copied,
  onShare,
  onCopy,
}: {
  detail: DetailApi;
  copied: boolean;
  onShare: (url: string) => void;
  onCopy: (url: string) => void;
}) {
  const { request, transactions } = detail;
  const sv = statusView(request.status);
  const isPaid = sv.verified;
  const paidMoment = request.paidAt ?? transactions[0]?.createdAt ?? null;

  const steps: WarmTimelineStep[] = [
    {
      title: "הגבייה נוצרה",
      meta: fmt(request.createdAt),
      done: true,
      now: !isPaid,
    },
    {
      title: "הלקוח שילם",
      meta: isPaid ? fmt(paidMoment) : "ממתין לתשלום מהלקוח",
      done: isPaid,
    },
    {
      title: "נגבה ואומת",
      meta: isPaid ? fmt(paidMoment) : "אימות דרך ספק הגבייה",
      done: isPaid,
    },
  ];

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 18, fontWeight: TOKEN.weight.semibold, color: W.ink, letterSpacing: "-0.2px" }}>
          {request.description || "גבייה"}
        </div>
      </div>

      <WarmCard style={{ textAlign: "center", marginBottom: 22 } as React.CSSProperties} padding={18}>
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
          {fmtAmount(request.amount, request.currency)}
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
            שלח שוב
          </WarmButton>
          <WarmButton variant="secondary" height={48} fullWidth onClick={() => onCopy(request.paymentUrl!)}>
            {copied ? "הועתק" : "העתק קישור"}
          </WarmButton>
        </div>
      ) : null}
    </>
  );
}
