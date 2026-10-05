"use client";

import { useCallback, useEffect, useState } from "react";

import type { BusinessCostSummaryApi } from "@/lib/business-cost/business-cost-client";
import type { BusinessStatusItem } from "@/lib/business-status/types";
import type { BriefingApi } from "@/lib/obligations/secretary-client";
import { fetchJsonCached } from "@/lib/ui/cached-json";

import {
  FAILED,
  LOADING,
  buildWeekSeries,
  israelDateKey,
  ready,
  shiftDateKey,
  type CashflowSeries,
  type CollectionWaitingWire,
  type DocumentWire,
  type InventoryItemWire,
  type LeadWire,
  type Load,
  type PaidWire,
} from "./home-v3-model";

/**
 * HOME v3 — the ONE data read behind all three layouts.
 *
 * Each source is its own request and settles on its own: a source that fails
 * leaves its own element saying so, and never costs the owner the whole
 * screen or, worse, gets replaced by a plausible number. The three layouts
 * receive the same `HomeData` — there is no per-layout fetching.
 *
 * Sources only the desktop layout draws (the five KPIs' collection figure,
 * conversations, stock levels) are read only while the desktop layout is on
 * screen; the week view is read only when the owner asks for it.
 */

export type ConversationWire = {
  conversationId: number;
  customerName: string | null;
  channel: string;
  lastRelevantMessageText: string | null;
  relevantAt: string;
};

export type InsightView = { title: string; body: string | null; href: string };

export type HomeData = {
  dayIncome: Load<{ hours: string[]; total: string }>;
  cost: Load<BusinessCostSummaryApi>;
  briefing: Load<BriefingApi>;
  status: Load<BusinessStatusItem[]>;
  collection: Load<{ waiting: CollectionWaitingWire[]; paid: PaidWire[] }>;
  leads: Load<LeadWire[]>;
  documents: Load<{ items: DocumentWire[]; totalPendingReview: number }>;
  insight: Load<InsightView | null>;
  unread: boolean;
  /* desktop only */
  pending: Load<{ amount: string; count: number }>;
  conversations: Load<ConversationWire[]>;
  inventory: Load<InventoryItemWire[]>;
  /* on demand */
  week: Load<CashflowSeries> | null;
};

const INITIAL: HomeData = {
  dayIncome: LOADING,
  cost: LOADING,
  briefing: LOADING,
  status: LOADING,
  collection: LOADING,
  leads: LOADING,
  documents: LOADING,
  insight: LOADING,
  unread: false,
  pending: LOADING,
  conversations: LOADING,
  inventory: LOADING,
  week: null,
};

type HomeDayWire = { day?: { hours?: string[]; total?: string } };
type CollectionInboxWire = { waiting?: CollectionWaitingWire[]; paid?: PaidWire[] };
type LeadsWire = { leads?: LeadWire[] };
type DocumentsWire = {
  items?: DocumentWire[];
  financialPulse?: { inboxDocumentCounts?: { totalPendingReview?: number } };
};
type InsightsWire = {
  insights?: Array<{ title: string; interpretation?: string | null; factLines?: Array<{ text?: string }> }>;
};
type WorkspaceWire = { summary?: { pending?: { amount?: string; count?: number } } };
type AttentionWire = { waitingForReply?: ConversationWire[] };
type InventoryWire = { items?: InventoryItemWire[] };
type CollectionWeekWire = { current?: { points?: string[]; total?: string } };
type CostDayWire = { cashOut?: { total?: string } };

/** Fresh enough for a screen the owner opens many times a day. */
const TTL = 15_000;

export function useHomeData(enabled: boolean, desktop: boolean): {
  data: HomeData;
  loadWeek: () => void;
} {
  const [data, setData] = useState<HomeData>(INITIAL);

  const put = useCallback(<K extends keyof HomeData>(key: K, value: HomeData[K]) => {
    setData((prev) => ({ ...prev, [key]: value }));
  }, []);

  /* ------------------------------------------------ every layout -- */
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const settle = <K extends keyof HomeData, T>(key: K, p: Promise<T>, map: (v: T) => HomeData[K]) => {
      p.then(
        (v) => {
          if (!cancelled) put(key, map(v));
        },
        () => {
          if (!cancelled) put(key, FAILED as HomeData[K]);
        },
      );
    };

    settle("dayIncome", fetchJsonCached<HomeDayWire>("/api/home/day?scope=day", TTL), (j) =>
      Array.isArray(j.day?.hours) && j.day?.hours.length === 24 && typeof j.day.total === "string"
        ? ready({ hours: j.day.hours, total: j.day.total })
        : FAILED,
    );
    settle("cost", fetchJsonCached<BusinessCostSummaryApi>("/api/business-cost/summary", TTL), (j) => ready(j));
    settle("briefing", fetchJsonCached<BriefingApi>("/api/obligations/briefing", TTL), (j) => ready(j));
    settle(
      "status",
      fetchJsonCached<{ items?: BusinessStatusItem[] }>("/api/business-status", TTL),
      (j) => ready(j.items ?? []),
    );
    settle("collection", fetchJsonCached<CollectionInboxWire>("/api/collection/inbox", TTL), (j) =>
      ready({ waiting: j.waiting ?? [], paid: j.paid ?? [] }),
    );
    settle("leads", fetchJsonCached<LeadsWire>("/api/leads?status=NEW&limit=20", TTL), (j) =>
      // The list ranks urgent leads of ANY status in with the page — keep only
      // the ones that really are new, newest first.
      ready(
        (j.leads ?? [])
          .filter((l) => l.status === "NEW")
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
      ),
    );
    settle("documents", fetchJsonCached<DocumentsWire>("/api/documents/inbox?limit=30", TTL), (j) =>
      ready({
        items: j.items ?? [],
        totalPendingReview: j.financialPulse?.inboxDocumentCounts?.totalPendingReview ?? 0,
      }),
    );
    settle("insight", loadInsight(), (v) => ready(v));

    fetchJsonCached<{ unreadCount?: number }>("/api/notifications/unread-count", 0)
      .then((j) => {
        if (!cancelled) put("unread", (j.unreadCount ?? 0) > 0);
      })
      .catch(() => {
        /* The bell stays quiet. */
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, put]);

  /* ------------------------------------------------ desktop only -- */
  useEffect(() => {
    if (!enabled || !desktop) return;
    let cancelled = false;
    const done = <K extends keyof HomeData>(key: K) => (v: HomeData[K]) => {
      if (!cancelled) put(key, v);
    };
    const fail = <K extends keyof HomeData>(key: K) => () => {
      if (!cancelled) put(key, FAILED as HomeData[K]);
    };

    fetchJsonCached<WorkspaceWire>("/api/payments/collection-workspace", TTL)
      .then((j) => {
        const p = j.summary?.pending;
        return p && typeof p.amount === "string" ? ready({ amount: p.amount, count: p.count ?? 0 }) : FAILED;
      })
      .then(done("pending"), fail("pending"));
    fetchJsonCached<AttentionWire>("/api/inbox/attention?limit=50", TTL)
      .then((j) => ready(j.waitingForReply ?? []))
      .then(done("conversations"), fail("conversations"));
    fetchJsonCached<InventoryWire>("/api/inventory/items", TTL)
      .then((j) => ready(j.items ?? []))
      .then(done("inventory"), fail("inventory"));

    return () => {
      cancelled = true;
    };
  }, [enabled, desktop, put]);

  /* ------------------------------------------------ on demand -- */
  const loadWeek = useCallback(() => {
    setData((prev) => (prev.week && prev.week.state !== "failed" ? prev : { ...prev, week: LOADING }));
    const today = israelDateKey(new Date());
    const dayKeys = Array.from({ length: 7 }, (_, i) => shiftDateKey(today, i - 6));
    Promise.all([
      fetchJsonCached<CollectionWeekWire>("/api/home/collection?period=week", TTL),
      ...dayKeys.map((k) => fetchJsonCached<CostDayWire>(`/api/business-cost?date=${k}`, 60_000)),
    ])
      .then(([income, ...days]) => {
        const week = buildWeekSeries({
          cumulativeIncome: (income as CollectionWeekWire).current?.points ?? [],
          incomeTotal: (income as CollectionWeekWire).current?.total ?? "",
          dayKeys,
          expenses: (days as CostDayWire[]).map((d) => d.cashOut?.total ?? ""),
        });
        put("week", week ? ready(week) : FAILED);
      })
      .catch(() => put("week", FAILED));
  }, [put]);

  return { data, loadWeek };
}

/**
 * The newest open Business Insight, else the first cost insight the cost
 * engine raised today, else nothing — in which case the card is not drawn.
 */
async function loadInsight(): Promise<InsightView | null> {
  const [learned, cost] = await Promise.allSettled([
    fetchJsonCached<InsightsWire>("/api/insights", TTL),
    fetchJsonCached<BusinessCostSummaryApi>("/api/business-cost/summary", TTL),
  ]);
  if (learned.status === "fulfilled") {
    const first = learned.value.insights?.[0];
    if (first?.title) {
      const body = first.interpretation?.trim() || first.factLines?.[0]?.text?.trim() || null;
      return { title: first.title, body, href: "/secretary" };
    }
  }
  if (cost.status === "fulfilled") {
    const first = cost.value.insights?.[0];
    if (first?.title) return { title: first.title, body: first.body?.trim() || null, href: "/secretary" };
  }
  if (learned.status === "rejected" && cost.status === "rejected") throw new Error("no insight source");
  return null;
}
