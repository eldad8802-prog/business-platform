"use client";

/**
 * Collection Workspace — the main collection screen ("מרכז הגבייה").
 *
 * SINGLE source of truth: GET /api/payments/collection-workspace (real,
 * read-only). No mock, no local data, no Billing, no client-side joins.
 *
 * Four layers (spec-locked): daily sentence · restrained money strip ·
 * attention · active · quiet history. Two truth states only (waiting/verified)
 * + honest lifecycle labels. No aging/late, no partial, no "deposited",
 * no forecast — none of those have a source of truth.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TOKEN } from "@/lib/design/tokens";
import {
  WarmButton,
  WarmCard,
  WarmPill,
  type WarmPillTone,
} from "@/components/ui/warm/warm-primitives";

const W = TOKEN.warm;

type CollectionState =
  | "waiting"
  | "verified"
  | "failed"
  | "expired"
  | "cancelled";

type Figure = { amount: string; count: number };
type Item = {
  id: number;
  description: string | null;
  amount: string;
  currency: string;
  state: CollectionState;
  stateLabel: string;
};
type WorkspaceApi = {
  summary: { pending: Figure; collectedThisMonth: Figure; expired: Figure };
  attention: Item[];
  active: Item[];
  history: Item[];
};

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; ws: WorkspaceApi };

function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

function money(amount: string, currency = "ILS"): string {
  const n = Number(amount);
  const sym =
    currency === "ILS" ? "₪" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  if (!Number.isFinite(n)) return `${sym}${amount}`;
  return `${sym}${n.toLocaleString("he-IL")}`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "בוקר טוב";
  if (h < 18) return "צהריים טובים";
  return "ערב טוב";
}

function dailySentence(ws: WorkspaceApi): { lead: string; soft: string } {
  const open = ws.active.length + ws.attention.length;
  if (open === 0) return { lead: "אין כרגע גביות פתוחות.", soft: "" };
  const openPhrase =
    open === 1 ? "יש לך גבייה אחת פתוחה." : `יש לך ${open} גביות פתוחות.`;
  if (ws.attention.length > 0) {
    const soft =
      ws.attention.length === 1
        ? "אחת דורשת טיפול, השאר מתקדמות כרגיל."
        : `${ws.attention.length} דורשות טיפול, השאר מתקדמות כרגיל.`;
    return { lead: openPhrase, soft };
  }
  return { lead: openPhrase, soft: "כולן מתקדמות כרגיל." };
}

function toneFor(state: CollectionState): WarmPillTone {
  if (state === "verified") return "verified";
  if (state === "failed" || state === "expired") return "late";
  return "waiting"; // waiting, cancelled
}

export default function CollectionWorkspacePage() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    const token = getAuthToken();
    if (!token) {
      router.replace("/login");
      return;
    }
    try {
      const res = await fetch("/api/payments/collection-workspace", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) {
        setState({ status: "error" });
        return;
      }
      const ws = (await res.json()) as WorkspaceApi;
      setState({ status: "ready", ws });
    } catch {
      setState({ status: "error" });
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div dir="rtl" style={{ minHeight: "100%", background: W.canvas, padding: "22px 20px 40px" }}>
      <div style={{ maxWidth: 440, margin: "0 auto" }}>
        <header style={{ marginBottom: 18 }}>
          <h1 style={{ fontSize: 17, fontWeight: TOKEN.weight.semibold, color: W.ink }}>
            מרכז הגבייה
          </h1>
        </header>

        {state.status === "loading" ? (
          <p style={{ fontSize: 13, color: W.muted2, textAlign: "center", marginTop: 40 }}>
            טוען…
          </p>
        ) : state.status === "error" ? (
          <WarmCard style={{ textAlign: "center" } as React.CSSProperties}>
            <p style={{ fontSize: 14, color: W.muted, lineHeight: 1.6 }}>
              לא הצלחנו לטעון את מרכז הגבייה.
            </p>
            <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}>
              <WarmButton variant="secondary" height={44} onClick={() => void load()}>
                נסה שוב
              </WarmButton>
            </div>
          </WarmCard>
        ) : (
          <WorkspaceBody
            ws={state.ws}
            onOpen={(id) => router.push(`/payments/${id}`)}
            onCreate={() => router.push("/payments/new")}
          />
        )}
      </div>
    </div>
  );
}

function WorkspaceBody({
  ws,
  onOpen,
  onCreate,
}: {
  ws: WorkspaceApi;
  onOpen: (id: number) => void;
  onCreate: () => void;
}) {
  const daily = dailySentence(ws);
  const showMoney =
    ws.summary.pending.count > 0 ||
    ws.summary.collectedThisMonth.count > 0 ||
    ws.summary.expired.count > 0;

  return (
    <>
      {/* Layer 1 — daily sentence (voice, not KPI) */}
      <div style={{ padding: "6px 0 4px", marginBottom: showMoney ? 22 : 20 }}>
        <div style={{ fontSize: 12, fontWeight: TOKEN.weight.medium, color: W.muted2, marginBottom: 8 }}>
          {greeting()}
        </div>
        <div style={{ fontSize: 20, fontWeight: TOKEN.weight.semibold, lineHeight: 1.5, letterSpacing: "-0.3px", color: W.ink }}>
          {daily.lead} {daily.soft ? <span style={{ color: W.muted }}>{daily.soft}</span> : null}
        </div>
      </div>

      {/* Layer 2 — restrained money strip (objective only) */}
      {showMoney ? (
        <div
          style={{
            display: "flex",
            borderTop: `1px solid ${W.line}`,
            borderBottom: `1px solid ${W.line}`,
            marginBottom: 26,
          }}
        >
          <MoneyCell label="ממתין" value={money(ws.summary.pending.amount)} />
          <MoneyCell label="נגבה החודש" value={money(ws.summary.collectedThisMonth.amount)} tone="done" />
          {ws.summary.expired.count > 0 ? (
            <MoneyCell label="פג תוקף" value={money(ws.summary.expired.amount)} tone="late" />
          ) : null}
        </div>
      ) : null}

      {/* One primary action — קבל תשלום (→ existing standalone create) */}
      <WarmButton variant="primary" fullWidth height={48} onClick={onCreate} style={{ marginBottom: 28 }}>
        קבל תשלום
      </WarmButton>

      {/* Layer 3 — attention (failed + expired) */}
      {ws.attention.length > 0 ? (
        <Section title="דורש טיפול" count={ws.attention.length}>
          {ws.attention.map((item) => (
            <CollectionRow key={item.id} item={item} onClick={() => onOpen(item.id)} />
          ))}
        </Section>
      ) : null}

      {/* Layer 4 — active (waiting) */}
      {ws.active.length > 0 ? (
        <Section title="בעבודה" count={ws.active.length}>
          {ws.active.map((item) => (
            <CollectionRow key={item.id} item={item} onClick={() => onOpen(item.id)} />
          ))}
        </Section>
      ) : null}

      {/* Layer 5 — quiet history (verified + cancelled), read-only */}
      {ws.history.length > 0 ? (
        <Section title="הושלמו">
          {ws.history.map((item) => (
            <CollectionRow key={item.id} item={item} onClick={() => onOpen(item.id)} muted />
          ))}
        </Section>
      ) : null}

      {ws.attention.length === 0 && ws.active.length === 0 && ws.history.length === 0 ? (
        <p style={{ fontSize: 13, color: W.muted, textAlign: "center", marginTop: 8, lineHeight: 1.6 }}>
          כשתתחיל לגבות, הגביות שלך יופיעו כאן.
        </p>
      ) : null}
    </>
  );
}

function MoneyCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "done" | "late";
}) {
  const color = tone === "done" ? W.status.verified.ink : tone === "late" ? W.status.late.ink : W.ink;
  return (
    <div style={{ flex: 1, padding: "14px 4px", textAlign: "center", borderRight: `1px solid ${W.line}` }}>
      <div style={{ fontSize: 15, fontWeight: TOKEN.weight.semibold, color, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: W.muted, marginTop: 4 }}>{label}</div>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 12, fontWeight: TOKEN.weight.semibold, color: W.muted, letterSpacing: "0.2px" }}>
          {title}
        </span>
        {count != null ? (
          <span
            style={{
              fontSize: 11,
              fontWeight: TOKEN.weight.semibold,
              color: W.muted,
              background: W.surface2,
              borderRadius: W.radius.pill,
              padding: "1px 8px",
            }}
          >
            {count}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function CollectionRow({
  item,
  onClick,
  muted = false,
}: {
  item: Item;
  onClick: () => void;
  muted?: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      style={{ cursor: "pointer", marginBottom: 10 }}
    >
      <WarmCard interactive padding={14}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: muted ? TOKEN.weight.medium : TOKEN.weight.semibold,
                color: muted ? "#5A544C" : W.ink,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {item.description || "גבייה"}
            </div>
          </div>
          <div style={{ textAlign: "left", flexShrink: 0 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: muted ? TOKEN.weight.medium : TOKEN.weight.semibold,
                color: muted ? "#5A544C" : W.ink,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {money(item.amount, item.currency)}
            </div>
            <div style={{ marginTop: 6, display: "flex", justifyContent: "flex-end" }}>
              <WarmPill tone={toneFor(item.state)}>{item.stateLabel}</WarmPill>
            </div>
          </div>
        </div>
      </WarmCard>
    </div>
  );
}
