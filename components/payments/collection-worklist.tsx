"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TOKEN } from "@/lib/design/tokens";
import { WarmButton, WarmCard } from "@/components/ui/warm/warm-primitives";
import { CollectionRow } from "@/components/payments/collection-row";
import {
  dailySentence,
  getAuthToken,
  greeting,
  money,
  type CollectionWorkspaceApi,
} from "@/components/payments/collection-format";

const W = TOKEN.warm;

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; ws: CollectionWorkspaceApi };

/**
 * Collection worklist (master). Fetches the read-only workspace ONCE and lives
 * in the stable `payments/layout` — navigating between items does NOT refetch or
 * remount it. Renders the four spec-locked layers (daily sentence · money strip
 * · one primary action · attention/active/history). `selectedId` highlights the
 * open item in the desktop Master–Detail; on single-pane it is simply null while
 * the worklist is the visible screen.
 */
export function CollectionWorklist({ selectedId }: { selectedId: string | null }) {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  // Fetch returns the next state (never sets it) — so the effect updates state
  // only after the request resolves, never synchronously. It depends on NOTHING
  // reactive (no router), so a soft navigation can never re-trigger it and the
  // worklist is fetched exactly once.
  const fetchWorkspace = useCallback(async (): Promise<LoadState> => {
    try {
      const res = await fetch("/api/payments/collection-workspace", {
        headers: { Authorization: `Bearer ${getAuthToken() ?? ""}` },
        cache: "no-store",
      });
      if (!res.ok) return { status: "error" };
      const ws = (await res.json()) as CollectionWorkspaceApi;
      return { status: "ready", ws };
    } catch {
      return { status: "error" };
    }
  }, []);

  // Auth redirect kept separate from the fetch so router identity never
  // re-triggers a data load.
  useEffect(() => {
    if (!getAuthToken()) router.replace("/login");
  }, [router]);

  useEffect(() => {
    if (!getAuthToken()) return;
    let cancelled = false;
    void fetchWorkspace().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchWorkspace]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    void fetchWorkspace().then((next) => setState(next));
  }, [fetchWorkspace]);

  return (
    <div style={{ padding: "22px 20px 40px" }}>
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
          <WarmCard style={{ textAlign: "center" }}>
            <p style={{ fontSize: 14, color: W.muted, lineHeight: 1.6 }}>
              לא הצלחנו לטעון את מרכז הגבייה.
            </p>
            <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}>
              <WarmButton variant="secondary" height={44} onClick={retry}>
                נסה שוב
              </WarmButton>
            </div>
          </WarmCard>
        ) : (
          <WorkspaceBody
            ws={state.ws}
            selectedId={selectedId}
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
  selectedId,
  onOpen,
  onCreate,
}: {
  ws: CollectionWorkspaceApi;
  selectedId: string | null;
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
            <CollectionRow key={item.id} item={item} selected={String(item.id) === selectedId} onClick={() => onOpen(item.id)} />
          ))}
        </Section>
      ) : null}

      {/* Layer 4 — active (waiting) */}
      {ws.active.length > 0 ? (
        <Section title="בעבודה" count={ws.active.length}>
          {ws.active.map((item) => (
            <CollectionRow key={item.id} item={item} selected={String(item.id) === selectedId} onClick={() => onOpen(item.id)} />
          ))}
        </Section>
      ) : null}

      {/* Layer 5 — quiet history (verified + cancelled), read-only */}
      {ws.history.length > 0 ? (
        <Section title="הושלמו">
          {ws.history.map((item) => (
            <CollectionRow key={item.id} item={item} muted selected={String(item.id) === selectedId} onClick={() => onOpen(item.id)} />
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
