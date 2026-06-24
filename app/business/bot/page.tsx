"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import {
  BUILDER_SHELL_MAX_WIDTH,
  BotIdentityHero,
  GuardNote,
  HubAreaCard,
} from "../bot-settings/_components/bot-builder-area-ui";

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

type AreaState = "ready" | "partial" | "soon";
type WorkMode = "MANUAL" | "SMART_DRAFTS" | "AUTO_OPENING_FUTURE";

type AreaIconName =
  | "goal"
  | "personality"
  | "voice"
  | "conversation"
  | "approach"
  | "knowledge"
  | "memory"
  | "autonomy"
  | "allowed"
  | "forbidden"
  | "handoff"
  | "learning";

type HubPayload = {
  identity: { displayName: string | null; avatar: string | null };
  runtime: { workMode: WorkMode; enabled: boolean; draftOnly: boolean };
  signals: {
    welcomeOk: boolean;
    questionsCount: number;
    finishOk: boolean;
    productLinkOk: boolean;
    workModeManual: boolean;
    identityNamed: boolean;
    voiceExtrasOk: boolean;
    personalityOk: boolean;
    approachOk: boolean;
    goalsCount: number;
    knowledgeOk: boolean;
  };
  areaStates: Record<AreaIconName, AreaState>;
};

type BuilderArea = {
  id: AreaIconName;
  icon: AreaIconName;
  title: string;
  summary: string;
  state: AreaState;
  href: string;
};

function areaStateLabel(state: AreaState): string {
  if (state === "ready") return "מוכן";
  if (state === "soon") return "בקרוב";
  return "לעריכה";
}

function deriveAreas(payload: HubPayload): BuilderArea[] {
  const { signals, areaStates } = payload;
  const summaries: Record<AreaIconName, string> = {
    goal:
      signals.goalsCount > 0
        ? `${signals.goalsCount} מטרות נבחרו`
        : "טרם נבחרו מטרות",
    personality: signals.personalityOk ? "אופי מוגדר" : "טרם הוגדר אופי",
    voice: signals.welcomeOk ? "הודעת פתיחה קיימת" : "חסרה הודעת פתיחה",
    conversation:
      signals.questionsCount > 0
        ? `${signals.questionsCount} שאלות legacy`
        : "אין שאלות עדיין",
    approach: signals.approachOk ? "גישה מוגדרת" : "טרם הוגדרה גישה",
    knowledge: signals.knowledgeOk
      ? "ידע עסקי מוגדר"
      : signals.productLinkOk
        ? "קישור קטלוג בלבד"
        : "טרם הוגדר ידע",
    memory: "זיכרון לקוח מתמשך · בקרוב",
    autonomy: signals.workModeManual ? "רמה 1 · ידני" : "רמה 2 · טיוטות חכמות",
    allowed: signals.finishOk ? "סיום שיחה מוגדר" : "חסר סיום שיחה",
    forbidden: "גבולות העברה ושמירה ברקע",
    handoff: "מחיר, נציג, חוסר ודאות ועוד",
    learning: "הצעות ולמידה מאישורים · בקרוב",
  };
  const titles: Record<AreaIconName, string> = {
    goal: "המטרה שלו",
    personality: "האופי שלו",
    voice: "איך הוא מדבר",
    conversation: "איך השיחה עובדת",
    approach: "הגישה שלו",
    knowledge: "מה הוא יודע",
    memory: "מה הוא זוכר על לקוחות",
    autonomy: "כמה עצמאות נתת לו",
    allowed: "מה הוא רשאי לעשות",
    forbidden: "מה אסור לו",
    handoff: "מתי מעביר אליי",
    learning: "איך הוא משתפר",
  };
  const order: AreaIconName[] = [
    "goal",
    "personality",
    "voice",
    "conversation",
    "approach",
    "knowledge",
    "memory",
    "autonomy",
    "allowed",
    "forbidden",
    "handoff",
    "learning",
  ];
  return order.map((id) => ({
    id,
    icon: id,
    title: titles[id],
    summary: summaries[id],
    state: areaStates[id] ?? "partial",
    href: `/business/bot-settings/${id}`,
  }));
}

export default function BusinessBotHubPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<HubPayload | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/business/bot-hub", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as HubPayload;
      if (!data) throw new Error();
      setPayload(data);
    } catch {
      setError("לא ניתן לטעון את נתוני הבוט");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const derived = useMemo(() => {
    if (!payload) {
      return {
        areas: [] as BuilderArea[],
        botName: "הבוט של העסק",
        avatar: null as string | null,
        subtitle: "",
        statusText: "טוען...",
      };
    }
    const manual = payload.runtime.workMode === "MANUAL";
    return {
      areas: deriveAreas(payload),
      botName: payload.identity.displayName || "הבוט של העסק",
      avatar: payload.identity.avatar,
      subtitle: manual
        ? "האינבוקס מסדר שיחות. אין טיוטות בוט פעילות."
        : "בנה אותו בדיוק כמו שהעסק שלך עובד. כל דבר כאן ניתן לשינוי.",
      statusText: manual
        ? "ידני · draft-only"
        : "פעיל · מכין טיוטות · draft-only",
    };
  }, [payload]);

  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main
        style={{
          maxWidth: BUILDER_SHELL_MAX_WIDTH,
          margin: "0 auto",
          padding: "18px 0 96px",
          boxSizing: "border-box",
        }}
      >
        <header style={{ padding: "8px 18px 6px" }}>
          <h1
            style={{
              margin: 0,
              color: TOKEN.ink.primary,
              fontSize: TOKEN.font.hero,
              fontWeight: TOKEN.weight.bold,
              lineHeight: 1.2,
            }}
          >
            הבוט שלי
          </h1>
        </header>

        {loading ? (
          <p style={{ margin: "14px 18px", color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>טוען...</p>
        ) : error ? (
          <p style={{ margin: "14px 18px", color: TOKEN.semantic.urgent.ink, fontSize: TOKEN.font.body }}>{error}</p>
        ) : payload ? (
          <>
            <p
              style={{
                margin: 0,
                padding: "0 18px",
                color: TOKEN.ink.muted,
                fontSize: TOKEN.font.body,
                fontWeight: TOKEN.weight.semibold,
                lineHeight: 1.55,
              }}
            >
              {derived.subtitle}
            </p>

            <BotIdentityHero
              icon={
                derived.avatar ? (
                  <span style={{ fontSize: 30, lineHeight: 1 }}>{derived.avatar}</span>
                ) : (
                  <BotAvatarIcon />
                )
              }
              name={derived.botName}
              status={derived.statusText}
            />

            <section style={{ marginTop: 20 }}>
              <div
                style={{
                  padding: "0 20px 8px",
                  color: TOKEN.ink.muted,
                  fontSize: TOKEN.font.meta,
                  fontWeight: TOKEN.weight.bold,
                }}
              >
                מה מרכיב את הבוט שלך
              </div>
              {derived.areas.map((area) => (
                <HubAreaCard
                  key={area.id}
                  href={area.href}
                  icon={<BotAreaIcon name={area.icon} />}
                  title={area.title}
                  summary={area.summary}
                  statusLabel={areaStateLabel(area.state)}
                  inactive={area.state === "soon"}
                />
              ))}
            </section>

            <GuardNote>
              Dubiz שומר ברקע שהבוט לא ימציא מידע ולא יפעל מעבר למה שהגדרת.
            </GuardNote>
          </>
        ) : null}
      </main>
    </div>
  );
}

function BotAvatarIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 10h10M9 14h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M6.5 5.5h11A2.5 2.5 0 0 1 20 8v7.5A2.5 2.5 0 0 1 17.5 18H11l-4.5 3v-3A2.5 2.5 0 0 1 4 15.5V8a2.5 2.5 0 0 1 2.5-2.5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" fill="none" />
      <path d="M9 3v2M15 3v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function BotAreaIcon({ name }: { name: AreaIconName }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    "aria-hidden": true,
  } as const;

  switch (name) {
    case "goal":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" fill="none" />
          <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" fill="none" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "personality":
      return (
        <svg {...common}>
          <path d="M5 8c2-3 5-3 7 0 2-3 5-3 7 0v4c0 4-3 7-7 8-4-1-7-4-7-8V8Z" stroke="currentColor" strokeWidth="2" fill="none" strokeLinejoin="round" />
          <path d="M8.5 11.5h.01M15.5 11.5h.01M9 15c2 1.3 4 1.3 6 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "voice":
      return (
        <svg {...common}>
          <path d="M5 9v6M9 6v12M13 8v8M17 5v14M21 10v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "conversation":
      return (
        <svg {...common}>
          <path d="M5 6h14v9H9l-4 3V6Z" stroke="currentColor" strokeWidth="2" fill="none" strokeLinejoin="round" />
          <path d="M8 10h8M8 13h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "approach":
      return (
        <svg {...common}>
          <path d="M7 12l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M4 14l4 4M16 6l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "knowledge":
      return (
        <svg {...common}>
          <path d="M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 0-3-3V4Z" stroke="currentColor" strokeWidth="2" fill="none" strokeLinejoin="round" />
          <path d="M8 8h6M8 12h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "memory":
      return (
        <svg {...common}>
          <path d="M8 7a4 4 0 0 1 8 0 4 4 0 0 1 1 7 5 5 0 0 1-10 0 4 4 0 0 1 1-7Z" stroke="currentColor" strokeWidth="2" fill="none" />
          <path d="M10 12h4M12 10v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "autonomy":
      return (
        <svg {...common}>
          <path d="M5 7h14M5 12h14M5 17h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="9" cy="7" r="2" stroke="currentColor" strokeWidth="2" fill="none" />
          <circle cx="15" cy="12" r="2" stroke="currentColor" strokeWidth="2" fill="none" />
          <circle cx="11" cy="17" r="2" stroke="currentColor" strokeWidth="2" fill="none" />
        </svg>
      );
    case "allowed":
      return (
        <svg {...common}>
          <path d="M13 2 5 13h6l-1 9 8-12h-6l1-8Z" stroke="currentColor" strokeWidth="2" fill="none" strokeLinejoin="round" />
        </svg>
      );
    case "forbidden":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" fill="none" />
          <path d="M7 7l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "handoff":
      return (
        <svg {...common}>
          <path d="M8 11V7a2 2 0 0 1 4 0v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M12 11V6a2 2 0 0 1 4 0v7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M16 13c2 0 3 1 3 3v1c0 3-2 5-6 5h-1c-3 0-5-2-6-5l-1-4a2 2 0 0 1 4-1l1 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      );
    case "learning":
      return (
        <svg {...common}>
          <path d="M5 19V5M5 19h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="m8 15 3-3 3 2 4-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      );
  }
}
