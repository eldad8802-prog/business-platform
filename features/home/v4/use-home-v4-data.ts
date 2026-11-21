"use client";

import { useCallback, useEffect, useState } from "react";

import type { BusinessStatusItem } from "@/lib/business-status/types";
import type { BriefingApi } from "@/lib/obligations/secretary-client";
import type { SetupView } from "@/lib/services/onboarding/setup-model";
import { parseHomeHistory, type HomeHistory } from "@/lib/services/home/home-history-model";
import { fetchJsonCached, invalidateCachedJson } from "@/lib/ui/cached-json";
import { addCalendarDays, jerusalemDayKey, startOfJerusalemDayUtc } from "@/lib/utils/jerusalem-day";

import { loadInsight, loadRecommendationHome, type InsightView, type RecommendationHomeView } from "../v3/use-home-data";
import {
  FAILED,
  LOADING,
  ready,
  type CollectionWaitingWire,
  type CountClaim,
  type DocumentWire,
  type LeadWire,
  type Load,
  type PaidWire,
} from "../v3/home-v3-model";
import {
  businessKindOf,
  modulesFromCapabilities,
  planHrefFromCapabilities,
  resolveUserPermissions,
  subscriptionFromCapabilities,
  type BusinessKind,
  type BusinessProfileWire,
  type CapabilitiesWire,
  type HomeAccess,
  type HomeModule,
} from "./home-access";
import { loadActivity } from "./pack-engine-loader";
import { serviceCasesSummary, type QuoteWire, type ServiceCasesSummary, type Source, type TodayAppointment, type TodayTask } from "./home-v4-model";
import { RECOMMENDATIONS_URL } from "@/features/recommendations/recommendations-client";

/**
 * HOME v4 — the one data read behind the screen.
 *
 * Layer 1 (capabilities) is read first. A source that belongs to a module is requested ONLY once the module is
 * known to be ON — a module that is OFF is never fetched, so its data cannot reach the screen even by accident,
 * and the server is not asked for routes that answer 404 by design. Every source settles on its own: one that
 * fails leaves its own area saying so and never costs the rest of the screen.
 */

export type HomeV4Data = {
  access: Load<HomeAccess>;
  receipts: Load<{ month: { amount: string; mixed: boolean }; today: { amount: string; mixed: boolean } }>;
  briefing: Load<BriefingApi>;
  status: Load<BusinessStatusItem[]>;
  collection: Source<{ waiting: CollectionWaitingWire[]; paid: PaidWire[] }>;
  leads: Load<LeadWire[]>;
  documents: Source<{ items: DocumentWire[]; totalPendingReview: number }>;
  agenda: Source<{ tasks: TodayTask[]; count: CountClaim }>;
  appointments: Source<TodayAppointment[]>;
  serviceCases: Source<ServiceCasesSummary>;
  quotes: Source<QuoteWire[]>;
  recommendation: Source<RecommendationHomeView | null>;
  insight: Load<InsightView | null>;
  history: Load<HomeHistory>;
  setup: Load<SetupView>;
  unread: boolean;
};

const INITIAL: HomeV4Data = {
  access: LOADING,
  receipts: LOADING,
  briefing: LOADING,
  status: LOADING,
  collection: LOADING,
  leads: LOADING,
  documents: LOADING,
  agenda: LOADING,
  appointments: LOADING,
  serviceCases: LOADING,
  quotes: LOADING,
  recommendation: LOADING,
  insight: LOADING,
  history: LOADING,
  setup: LOADING,
  unread: false,
};

const TTL = 15_000;
const CAPABILITIES_TTL = 60_000;
const OFF = { state: "off" } as const;

type CollectionWire = {
  current?: { total?: string; isMixedCurrency?: boolean };
  month?: { amount?: string; isMixedCurrency?: boolean } | null;
};
type CollectionInboxWire = { waiting?: CollectionWaitingWire[]; paid?: PaidWire[] };
type DocumentsWire = { items?: DocumentWire[]; financialPulse?: { inboxDocumentCounts?: { totalPendingReview?: number } } };
type AgendaRowWire = { type: string; task?: { id: number; title: string; dueOn: string | null; dueMinute?: number | null; link?: { kind: string } | null } };
type AgendaWire = { buckets?: { bucket: string; rows: AgendaRowWire[] }[]; count?: number; countPartial?: boolean };

/** Everything requested, so a retry can drop exactly these from the shared cache. */
const urlsRequested = new Set<string>();
function get<T>(url: string, ttl = TTL): Promise<T> {
  urlsRequested.add(url);
  return fetchJsonCached<T>(url, ttl);
}

function todayWindow(now: Date): { from: string; to: string } {
  const today = jerusalemDayKey(now);
  return { from: startOfJerusalemDayUtc(today).toISOString(), to: startOfJerusalemDayUtc(addCalendarDays(today, 1)).toISOString() };
}

export function agendaToToday(wire: AgendaWire): { tasks: TodayTask[]; count: CountClaim } {
  const tasks: TodayTask[] = [];
  for (const b of wire.buckets ?? []) {
    for (const row of b.rows ?? []) {
      // The owner's own tasks only (lead follow-ups are the secretary's "פניות" — never counted twice).
      if (row.type !== "TASK" || !row.task || row.task.link?.kind === "lead") continue;
      tasks.push({ id: row.task.id, title: row.task.title, dueOn: row.task.dueOn, dueMinute: row.task.dueMinute ?? null, bucket: b.bucket });
    }
  }
  return { tasks, count: { n: typeof wire.count === "number" ? wire.count : 0, exact: wire.countPartial !== true && typeof wire.count === "number" } };
}

export function useHomeV4Data(enabled: boolean): { data: HomeV4Data; retry: () => void } {
  const [data, setData] = useState<HomeV4Data>(INITIAL);
  const [nonce, setNonce] = useState(0);

  const put = useCallback(<K extends keyof HomeV4Data>(key: K, value: HomeV4Data[K]) => {
    setData((prev) => ({ ...prev, [key]: value }));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const settle = <K extends keyof HomeV4Data, T>(key: K, p: Promise<T>, map: (v: T) => HomeV4Data[K]) => {
      p.then(
        (v) => !cancelled && put(key, map(v)),
        () => !cancelled && put(key, FAILED as HomeV4Data[K]),
      );
    };
    const now = new Date();

    /* ---- core: every business ---- */
    settle("briefing", get<BriefingApi>("/api/obligations/briefing"), (j) => ready(j));
    settle("status", get<{ items?: BusinessStatusItem[] }>("/api/business-status"), (j) => ready(j.items ?? []));
    settle("leads", get<{ leads?: LeadWire[] }>("/api/leads?status=NEW&limit=20"), (j) =>
      ready((j.leads ?? []).filter((l) => l.status === "NEW").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())),
    );
    settle("insight", loadInsight(), (v) => ready(v));
    settle("history", get<unknown>("/api/home/history"), (j) => {
      const h = parseHomeHistory(j);
      return h ? ready(h) : FAILED;
    });
    settle("setup", get<SetupView>("/api/business/setup"), (j) => ready(j));
    get<{ unreadCount?: number }>("/api/notifications/unread-count", 0)
      .then((j) => !cancelled && put("unread", (j.unreadCount ?? 0) > 0))
      .catch(() => undefined);

    /* ---- layer 1 + 2: capabilities, business kind ---- */
    const kindP: Promise<BusinessKind> = get<BusinessProfileWire>("/api/business/profile", 60_000)
      .then((p) => businessKindOf(p))
      // The kind is emphasis only: an unknown kind falls back to the general order, never blocks the screen.
      .catch(() => "general" as const);

    get<CapabilitiesWire>("/api/business/capabilities", CAPABILITIES_TTL).then(
      async (caps) => {
        const modules = modulesFromCapabilities(caps);
        const kind = await kindP;
        // Phase 2: the pack engine is downloaded only for a business that chose packs (null otherwise / on failure).
        const { activity, packs } = await loadActivity(caps);
        if (cancelled) return;
        put(
          "access",
          ready({
            businessId: typeof caps.businessId === "number" ? caps.businessId : null,
            modules,
            kind,
            permissions: resolveUserPermissions(),
            activity,
            packs,
            subscription: subscriptionFromCapabilities(caps),
            planHref: planHrefFromCapabilities(caps),
          }),
        );
        const on = (m: HomeModule) => modules.has(m);

        /* ---- module sources: requested only while the module is ON ---- */
        if (on("billing")) {
          settle("receipts", get<CollectionWire>("/api/home/collection?period=today"), (j) =>
            typeof j.current?.total === "string" && typeof j.month?.amount === "string"
              ? ready({
                  month: { amount: j.month.amount, mixed: j.month.isMixedCurrency === true },
                  today: { amount: j.current.total, mixed: j.current.isMixedCurrency === true },
                })
              : FAILED,
          );
          settle("collection", get<CollectionInboxWire>("/api/collection/inbox"), (j) => ready({ waiting: j.waiting ?? [], paid: j.paid ?? [] }));
        } else {
          put("receipts", FAILED); // never drawn: every money metric requires billing
          put("collection", OFF);
        }

        if (on("documents")) {
          settle("documents", get<DocumentsWire>("/api/documents/inbox?limit=30"), (j) =>
            ready({ items: j.items ?? [], totalPendingReview: j.financialPulse?.inboxDocumentCounts?.totalPendingReview ?? 0 }),
          );
        } else put("documents", OFF);

        if (on("daily_tasks")) settle("agenda", get<AgendaWire>("/api/tasks/agenda"), (j) => ready(agendaToToday(j)));
        else put("agenda", OFF);

        if (on("appointments")) {
          const w = todayWindow(now);
          const q = new URLSearchParams({ from: w.from, to: w.to });
          settle("appointments", get<{ appointments?: TodayAppointment[] }>(`/api/appointments?${q}`), (j) => ready(j.appointments ?? []));
        } else put("appointments", OFF);

        if (on("service_desk")) settle("serviceCases", get<{ cases?: { id?: number; status: string }[]; nextBeforeId?: number | null }>("/api/service-desk/cases?limit=100"), (j) => ready(serviceCasesSummary(j)));
        else put("serviceCases", OFF);

        if (on("business_documents")) settle("quotes", get<{ quotes?: QuoteWire[] }>("/api/business-documents/quotes"), (j) => ready(j.quotes ?? []));
        else put("quotes", OFF);

        if (on("owner_recommendations")) settle("recommendation", loadRecommendationHome(), (v) => ready(v));
        else put("recommendation", OFF);
      },
      () => {
        if (cancelled) return;
        // Capabilities unknown → fail closed: no module is assumed ON, and every module area says it could not load.
        put("access", FAILED);
        put("receipts", FAILED);
        for (const k of ["collection", "documents", "agenda", "appointments", "serviceCases", "quotes", "recommendation"] as const) put(k, FAILED);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [enabled, put, nonce]);

  const retry = useCallback(() => {
    for (const url of urlsRequested) invalidateCachedJson(url);
    // Read by the shared v3 loaders (insight / recommendation) outside `get`.
    for (const url of ["/api/insights", "/api/business-cost/summary", RECOMMENDATIONS_URL]) invalidateCachedJson(url);
    urlsRequested.clear();
    setData((prev) => ({ ...INITIAL, unread: prev.unread }));
    setNonce((n) => n + 1);
  }, []);

  return { data, retry };
}
