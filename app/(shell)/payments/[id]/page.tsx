"use client";

/**
 * Collection Detail (Ledger) — read-only, warm design language. Canonical route
 * for a single collection: deep-link / refresh / back all resolve here.
 *
 * Source of truth: GET /api/payments/requests/[id] (real, read-only) →
 * { request, transactions, audit }. Rendering is delegated to <CollectionDetail>;
 * this page owns only the fetch + the adaptive frame.
 *
 * Adaptive frame (CSS only — no window.innerWidth): on single-pane (mobile /
 * tablet, and any hard load < 1024px) it is a full page with a back button; at
 * ≥1024px it renders inside the Master–Detail panel (from payments/layout) — the
 * back button is hidden (the worklist is visible) and the column widens. The
 * warm canvas is provided by the layout, so this page sets none.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { TOKEN } from "@/lib/design/tokens";
import BackButton from "@/components/ui/back-button";
import { WarmButton, WarmCard } from "@/components/ui/warm/warm-primitives";
import { CollectionDetail } from "@/components/payments/collection-detail";
import { getAuthToken, type CollectionDetailApi } from "@/components/payments/collection-format";

const W = TOKEN.warm;

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; detail: CollectionDetailApi };

/* Pilot (Spec v1 §23): the detail LEAF stops undoing the workspace. In the
 * parallel mode the pane is ~1270px at 1920 — the content now fills it with a
 * comfortable reading column (840) instead of re-capping at 560 and leaving
 * ~700px of dead canvas. Mobile column unchanged. */
const detailCss = `
.pay-detail__inner { max-width: 520px; margin: 0 auto; }
@media (min-width: 1024px) {
  .pay-detail__inner { max-width: 840px; padding-inline: 24px; }
  .pay-detail__back { display: none; }
}
`;

export default function CollectionDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [copied, setCopied] = useState(false);

  // Fetch returns the next state (never sets it). It depends only on `id` (no
  // router), so a soft navigation between items fetches the detail exactly once.
  const fetchDetail = useCallback(async (): Promise<LoadState> => {
    try {
      const res = await fetch(`/api/payments/requests/${id}`, {
        headers: { Authorization: `Bearer ${getAuthToken() ?? ""}` },
        cache: "no-store",
      });
      if (!res.ok) return { status: "error" };
      const detail = (await res.json()) as CollectionDetailApi;
      return { status: "ready", detail };
    } catch {
      return { status: "error" };
    }
  }, [id]);

  // Auth redirect kept separate from the fetch so router identity never
  // re-triggers a data load.
  useEffect(() => {
    if (!getAuthToken()) router.replace("/login");
  }, [router]);

  useEffect(() => {
    if (!id || !getAuthToken()) return;
    let cancelled = false;
    void fetchDetail().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [id, fetchDetail]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    void fetchDetail().then((next) => {
      if (next) setState(next);
    });
  }, [fetchDetail]);

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
    <div className="pay-detail" style={{ padding: "20px 20px 40px" }}>
      <style>{detailCss}</style>
      <div className="pay-detail__inner">
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <h1 style={{ fontSize: 17, fontWeight: TOKEN.weight.semibold, color: W.ink }}>גבייה</h1>
          <span className="pay-detail__back">
            <BackButton />
          </span>
        </header>

        {state.status === "loading" ? (
          <p style={{ fontSize: 13, color: W.muted2, textAlign: "center", marginTop: 40 }}>
            טוען…
          </p>
        ) : state.status === "error" ? (
          <WarmCard style={{ textAlign: "center" }}>
            <p style={{ fontSize: 14, color: W.muted, lineHeight: 1.6 }}>
              לא הצלחנו לטעון את הגבייה.
            </p>
            <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}>
              <WarmButton variant="secondary" height={44} onClick={retry}>
                נסה שוב
              </WarmButton>
            </div>
          </WarmCard>
        ) : (
          <CollectionDetail detail={state.detail} copied={copied} onShare={shareLink} onCopy={copyLink} />
        )}
      </div>
    </div>
  );
}
