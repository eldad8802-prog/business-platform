"use client";

import { useEffect, useState } from "react";

import { countText, leadsWaitingClaim } from "@/features/home/v3/home-v3-model";
import type { BusinessStatusItem } from "@/lib/business-status/types";
import { fetchJsonCached } from "@/lib/ui/cached-json";

/**
 * The live signals the desktop sidebar hangs on its items — read only from
 * real sources, and only while the sidebar is actually on screen.
 *
 * Every badge here has a truth source, or it is not drawn:
 *   שיחות        GET /api/inbox/attention → waitingForReply (count; "N+" when
 *                the list reached the requested limit and may have been cut)
 *   גבייה        GET /api/collection/inbox → summary.attention.count (dot)
 *   התחייבויות   GET /api/payables/commitments?scope=open → commitments whose
 *                worst installment is OVERDUE or DUE (count — the list is the
 *                whole open set, never paged)
 *   לידים        GET /api/business-status → its lead items, through the SAME
 *                leadsWaitingClaim() the Home's "מה מחכה" uses — one definition
 *                (the canonical evaluateLeadAttention), one source; "N+" when
 *                a cap may have cut the list. Re-read on every navigation with
 *                the Home's own URL and cache window, so on /app both surfaces
 *                share one response and can never disagree.
 *   מלאי         GET /api/inventory/alerts?type=CRITICAL_STOCK&isResolved=false
 *                → "קריטי" when at least one is open
 * A source that fails simply leaves its badge off — a badge that guesses is
 * worse than no badge.
 */

export type NavBadge =
  | { kind: "count"; text: string; tone: "brand" | "warn" | "new" }
  | { kind: "label"; text: string; tone: "critical" }
  | { kind: "dot"; tone: "critical" | "alert" };

export type NavBadges = Partial<Record<string, NavBadge>>;

const BADGE_TTL_MS = 60_000;
const CONVERSATIONS_LIMIT = 50;

type AttentionWire = { waitingForReply?: unknown[] };
type CollectionInboxWire = { summary?: { attention?: { count?: number } } };
type CommitmentsWire = { commitments?: Array<{ attention?: string }> };
type StatusWire = { items?: BusinessStatusItem[] };

/** Same URL and window as the Home's read (features/home/v3/use-home-data.ts). */
const STATUS_URL = "/api/business-status";
const STATUS_TTL_MS = 15_000;
type AlertsWire = { alerts?: unknown[] };
type MeWire = { user?: { name?: string | null; businessName?: string | null } };
type UnreadWire = { unreadCount?: number };

function countBadge(n: number, cap: number | null, tone: "brand" | "warn" | "new"): NavBadge | undefined {
  if (n <= 0) return undefined;
  const text = cap !== null && n >= cap ? `${cap}+` : String(n);
  return { kind: "count", text, tone };
}

export function useNavBadges(enabled: boolean, pathname: string): NavBadges {
  const [badges, setBadges] = useState<NavBadges>({});

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const set = (key: string, badge: NavBadge | undefined) => {
      if (cancelled) return;
      setBadges((prev) => ({ ...prev, [key]: badge }));
    };
    const quiet = () => {
      /* No source, no badge. */
    };

    fetchJsonCached<AttentionWire>(`/api/inbox/attention?limit=${CONVERSATIONS_LIMIT}`, BADGE_TTL_MS)
      .then((j) => set("chats", countBadge(j.waitingForReply?.length ?? 0, CONVERSATIONS_LIMIT, "brand")))
      .catch(quiet);

    fetchJsonCached<CollectionInboxWire>("/api/collection/inbox", BADGE_TTL_MS)
      .then((j) =>
        set("payments", (j.summary?.attention?.count ?? 0) > 0 ? { kind: "dot", tone: "critical" } : undefined),
      )
      .catch(quiet);

    fetchJsonCached<CommitmentsWire>("/api/payables/commitments?scope=open", BADGE_TTL_MS)
      .then((j) => {
        const n = (j.commitments ?? []).filter((c) => c.attention === "OVERDUE" || c.attention === "DUE").length;
        set("payables", countBadge(n, null, "warn"));
      })
      .catch(quiet);

    fetchJsonCached<AlertsWire>("/api/inventory/alerts?type=CRITICAL_STOCK&isResolved=false", BADGE_TTL_MS)
      .then((j) =>
        set("inventory", (j.alerts?.length ?? 0) > 0 ? { kind: "label", text: "קריטי", tone: "critical" } : undefined),
      )
      .catch(quiet);

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchJsonCached<StatusWire>(STATUS_URL, STATUS_TTL_MS)
      .then((j) => {
        if (cancelled) return;
        const claim = leadsWaitingClaim(j.items ?? []);
        const badge: NavBadge | undefined =
          claim.n > 0 ? { kind: "count", text: countText(claim), tone: "new" } : undefined;
        setBadges((prev) => ({ ...prev, leads: badge }));
      })
      .catch(() => {
        /* No source, no badge. */
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, pathname]);

  return badges;
}

/** Who is signed in and which business — for the sidebar's business card. */
export function useSessionIdentity(enabled: boolean): { businessName: string | null; userName: string | null } {
  const [identity, setIdentity] = useState<{ businessName: string | null; userName: string | null }>({
    businessName: null,
    userName: null,
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchJsonCached<MeWire>("/api/auth/me", 5 * 60_000)
      .then((j) => {
        if (cancelled) return;
        setIdentity({
          businessName: j.user?.businessName?.trim() || null,
          userName: j.user?.name?.trim() || null,
        });
      })
      .catch(() => {
        /* The card stays without a name rather than guessing one. */
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return identity;
}

/**
 * Whether anything is waiting in the notification centre, for the rail and the
 * sidebar. (The bottom bar keeps its own copy of this read — see bottom-bar.)
 * Re-read on navigation, never polled; a failure leaves the dot off.
 */
export function useHasUnreadNotifications(pathname: string, enabled: boolean): boolean {
  const [hasUnread, setHasUnread] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchJsonCached<UnreadWire>("/api/notifications/unread-count", 0)
      .then((j) => {
        if (!cancelled && typeof j.unreadCount === "number") setHasUnread(j.unreadCount > 0);
      })
      .catch(() => {
        /* The bell stays quiet. */
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, enabled]);

  return hasUnread;
}
