"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ProgressBar from "@/components/ProgressBar";
import BackButton from "@/components/ui/back-button";
import { baseStyles } from "@/lib/styles/baseStyles";
import { mapContentArchetypeToGoalAngle } from "@/lib/content/content-archetype-map";
import { TOKEN } from "@/lib/design/tokens";

// ── Types ─────────────────────────────────────────────────────────────────────

type GoalId = "leads" | "trust" | "exposure" | "sales" | "brand";
type VibeId =
  | "professional_clean"
  | "warm_personal"
  | "bold_energetic"
  | "premium_luxury";
type AudienceType = "new" | "interested" | "ready" | "existing" | "all";

type ContentFlow = {
  mode?: string;
  contentArchetypeId?: string;
  goal?: string;
  contentAngle?: string;
  primaryGoal?: GoalId;
  vibe?: VibeId;
  directionType?: string;
  creatorContext?: string;
  audienceTypes?: AudienceType[];
  contentGoalPrompt?: string;
  contentInsightAnswers?: unknown[];
  // preserved passthrough fields
  creationEntryMode?: string;
  canFilm?: boolean;
  selectedPlatform?: string;
  selectedDirection?: unknown;
  selectedFormat?: string;
};

// ── Placeholder rotation ───────────────────────────────────────────────────────

const PLACEHOLDERS = [
  "שלא ירגיש כמו פרסומת",
  "אני רוצה שירגישו שאפשר לסמוך עליי",
  "שיהיה קליל אבל עדיין מקצועי",
  "שזה ירגיש כמו שיחה אמיתית",
  "שיעצרו כבר בשנייה הראשונה",
  "שיבינו למה אני שונה מאחרים",
] as const;

// ── Prompt synthesis ───────────────────────────────────────────────────────────

const GOAL_DESCRIPTIONS: Record<string, string> = {
  leads: "לייצר פניות לקוחות חדשות",
  trust: "לבנות אמון ומקצועיות",
  exposure: "להגיע לקהל חדש",
  sales: "לקדם מכירה ישירה",
  brand: "לחזק את המותג והנוכחות",
};

function buildContentGoalPrompt(goal: string, creatorContext: string): string {
  const desc = GOAL_DESCRIPTIONS[goal] ?? "קידום שירות";
  const context = creatorContext.trim()
    ? `הקשר אישי: ${creatorContext.trim()}.`
    : "רוצים שזה ירגיש ברור, אנושי וקרוב ללקוח.";
  return `אני רוצה לקדם: ${desc}. מה שבדרך כלל עוצר אנשים: —. ${context}`;
}

// ── Direction synthesis helpers ────────────────────────────────────────────────

type SelectedFormat = "reel" | "video" | "image" | "post";

const DIRECTION_META: Record<
  string,
  { title: string; whyItFits: string; description: string; strategy: string }
> = {
  authentic: {
    title: "שיחה אמיתית",
    whyItFits: "מרגיש טבעי ולא כמו פרסומת",
    description: "יש לך קשר אישי עם הלקוחות שלך",
    strategy: "explain",
  },
  attention: {
    title: "פתיחה חזקה",
    whyItFits: "בנוי לעצור אנשים מהר",
    description: "רוצים להגיע לאנשים חדשים שלא מכירים אותך",
    strategy: "attention",
  },
  proof: {
    title: "סיפור קצר",
    whyItFits: "בונה חיבור ורגש לאורך הסרטון",
    description: "יש לך תוצאה טובה שאפשר להראות",
    strategy: "trust",
  },
  differentiation: {
    title: "משהו שונה",
    whyItFits: "מראה את ההבדל שלך מהמתחרים",
    description: "רוצים שאנשים יבינו מה מייחד אותך",
    strategy: "show_difference",
  },
  direct: {
    title: "ישיר ולעניין",
    whyItFits: "הצעה ברורה שמובילה ישר לפעולה",
    description: "יש לך מבצע, שירות או הצעה ספציפית",
    strategy: "cta",
  },
};

function vibeToTone(vibe: string | undefined): string {
  const map: Record<string, string> = {
    professional_clean: "clear",
    warm_personal: "warm",
    bold_energetic: "energetic",
    premium_luxury: "premium",
  };
  return map[vibe ?? ""] ?? "warm";
}

function goalToPace(goal: string | undefined): string {
  if (goal === "leads" || goal === "sales" || goal === "exposure") return "fast";
  return "medium";
}

function inferSelectedFormat(
  canFilm: boolean | undefined,
  platform: string | undefined
): SelectedFormat {
  if (canFilm && platform === "facebook") return "video";
  return "reel";
}

// ── Audience defaults ─────────────────────────────────────────────────────────

function defaultAudienceTypes(goal: string): AudienceType[] {
  if (goal === "sales") return ["ready"];
  if (goal === "exposure" || goal === "brand") return ["new"];
  return ["new", "interested"];
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ContextInjectionPage() {
  const router = useRouter();
  const [contextText, setContextText] = useState("");
  const [focused, setFocused] = useState(false);
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const [flowGoal, setFlowGoal] = useState<string>("trust");
  const [flowArchetypeId, setFlowArchetypeId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Restore prior state from localStorage
  useEffect(() => {
    const raw = localStorage.getItem("content_flow");
    if (!raw) {
      router.replace("/content");
      return;
    }
    try {
      const parsed: ContentFlow = JSON.parse(raw);
      if (!parsed.mode) {
        router.replace("/content");
        return;
      }
      if (!mapContentArchetypeToGoalAngle(parsed.contentArchetypeId)) {
        router.replace("/content/archetype");
        return;
      }
      if (parsed.contentArchetypeId) setFlowArchetypeId(parsed.contentArchetypeId);
      if (parsed.goal) setFlowGoal(parsed.goal);
      if (parsed.creatorContext) setContextText(parsed.creatorContext);
    } catch {
      router.replace("/content");
    }
  }, [router]);

  // Cycle placeholder while textarea is empty and unfocused
  useEffect(() => {
    if (focused || contextText.trim().length > 0) return;
    const id = setInterval(
      () => setPlaceholderIdx((i) => (i + 1) % PLACEHOLDERS.length),
      3200
    );
    return () => clearInterval(id);
  }, [focused, contextText]);

  const hasText = contextText.trim().length > 0;
  const ctaLabel = hasText ? "בוא נבנה את זה" : "המשך";

  function handleContinue() {
    if (!flowArchetypeId) return;

    const mapped = mapContentArchetypeToGoalAngle(flowArchetypeId);
    if (!mapped) {
      router.replace("/content/archetype");
      return;
    }

    const raw = localStorage.getItem("content_flow");
    const existing: ContentFlow = raw ? JSON.parse(raw) : {};

    // Guard: Layer 4 must have set directionType
    const directionMeta = DIRECTION_META[existing.directionType ?? ""] ?? null;
    if (!directionMeta) {
      router.replace("/content/archetype");
      return;
    }

    const goal = mapped.goal;
    const contentGoalPrompt = buildContentGoalPrompt(goal, contextText);

    // Normalize "unknown" to a valid SelectedPlatform — decision engine doesn't accept it
    const resolvedPlatform =
      existing.selectedPlatform === "unknown" || !existing.selectedPlatform
        ? "instagram"
        : existing.selectedPlatform;

    const recommendedFormat = inferSelectedFormat(existing.canFilm, resolvedPlatform);

    const selectedDirection = {
      id: existing.directionType,
      title: directionMeta.title,
      description: directionMeta.description,
      whyItFits: directionMeta.whyItFits,
      type: existing.directionType,
      strategy: directionMeta.strategy,
      tone: vibeToTone(existing.vibe),
      pace: goalToPace(goal),
      recommendedFormat,
    };

    localStorage.setItem(
      "content_flow",
      JSON.stringify({
        ...existing,
        goal,
        contentAngle: mapped.contentAngle,
        creatorContext: contextText.trim() || null,
        contentGoalPrompt,
        audienceTypes: defaultAudienceTypes(goal),
        contentInsightAnswers: Array.isArray(existing.contentInsightAnswers)
          ? existing.contentInsightAnswers
          : [],
        selectedDirection,
        selectedFormat: recommendedFormat,
        selectedPlatform: resolvedPlatform,
      })
    );

    router.push("/content/creator-plan");
  }

  return (
    <div style={pageStyle}>
      <style>{`
        .context-textarea:focus { outline: none; }
        .context-textarea::placeholder { color: #94a3b8; }
      `}</style>

      <div style={shellStyle}>
        <div style={topBarStyle}>
          <BackButton />
          <div style={{ flex: 1 }} />
        </div>

        <ProgressBar progress={36} />

        <div style={contentAreaStyle}>
          <header style={heroStyle}>
            <h1 style={titleStyle}>
              יש משהו חשוב שתרצה שהתוכן יעביר?
            </h1>
            <p style={subtitleStyle}>
              אפשר לכתוב במשפט אחד מה חשוב לך שאנשים ירגישו או יבינו.
            </p>
          </header>

          <div style={textareaWrapperStyle(focused)}>
            <textarea
              ref={textareaRef}
              className="context-textarea"
              value={contextText}
              onChange={(e) => setContextText(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={PLACEHOLDERS[placeholderIdx]}
              rows={5}
              style={textareaInnerStyle}
              aria-label="הקשר אישי לתוכן"
            />
          </div>

          <p style={hintTextStyle}>
            ככל שתספר/י יותר במילים שלך, המערכת תוכל לדייק טוב יותר את התוכן.
          </p>

          <p style={optionalLabelStyle}>לא חובה — אפשר גם להמשיך ישירות.</p>
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            onClick={handleContinue}
            style={ctaButtonStyle(hasText)}
          >
            {ctaLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const pageStyle: React.CSSProperties = {
  ...baseStyles.page,
  background: "linear-gradient(180deg, #f4f6fb 0%, #ffffff 42%, #f8fafc 100%)",
};

const shellStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 720,
  margin: "0 auto",
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
  paddingInline: 16,
};

const topBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  paddingTop: 12,
  paddingBottom: 4,
};

const contentAreaStyle: React.CSSProperties = {
  flex: 1,
  width: "100%",
  maxWidth: 680,
  margin: "0 auto",
  paddingBottom: 16,
};

const heroStyle: React.CSSProperties = {
  textAlign: "right",
  marginBottom: 24,
  marginTop: 4,
};

const titleStyle: React.CSSProperties = {
  fontSize: "clamp(1.55rem, 5vw, 1.85rem)",
  fontWeight: 800,
  lineHeight: 1.25,
  color: "#0f172a",
  margin: 0,
  marginBottom: 10,
  letterSpacing: "-0.02em",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: "clamp(0.95rem, 3.5vw, 1.05rem)",
  lineHeight: 1.65,
  color: "#64748b",
  margin: 0,
};

const textareaWrapperStyle = (focused: boolean): React.CSSProperties => ({
  borderRadius: 20,
  border: focused ? "2px solid #0f172a" : "1.5px solid #e2e8f0",
  background: "#ffffff",
  boxShadow: focused
    ? "0 8px 28px rgba(15,23,42,0.1)"
    : "0 3px 12px rgba(15,23,42,0.06)",
  transition: "border-color 0.18s ease, box-shadow 0.18s ease",
  overflow: "hidden",
  marginBottom: 14,
});

const textareaInnerStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  minHeight: 148,
  padding: "clamp(16px, 4.5vw, 20px)",
  fontSize: "clamp(1rem, 3.8vw, 1.1rem)",
  lineHeight: 1.7,
  color: "#0f172a",
  background: "transparent",
  border: "none",
  resize: "none",
  textAlign: "right",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const hintTextStyle: React.CSSProperties = {
  fontSize: "clamp(0.78rem, 2.8vw, 0.85rem)",
  color: "#94a3b8",
  textAlign: "right",
  lineHeight: 1.55,
  margin: 0,
  marginBottom: 8,
};

const optionalLabelStyle: React.CSSProperties = {
  fontSize: "clamp(0.75rem, 2.6vw, 0.82rem)",
  color: "#cbd5e1",
  textAlign: "right",
  margin: 0,
};

const footerStyle: React.CSSProperties = {
  position: "sticky",
  bottom: 0,
  zIndex: 20,
  background: "linear-gradient(180deg, transparent 0%, #f8fafc 28%)",
  paddingTop: 16,
  paddingBottom: "calc(16px + env(safe-area-inset-bottom))",
  marginTop: "auto",
};

const ctaButtonStyle = (hasText: boolean): React.CSSProperties => ({
  width: "100%",
  maxWidth: 680,
  margin: "0 auto",
  display: "block",
  height: 52,
  borderRadius: 16,
  border: "none",
  background: "#0f172a",
  color: "#ffffff",
  fontSize: 16,
  fontWeight: 800,
  cursor: "pointer",
  boxShadow: hasText
    ? "0 12px 28px rgba(15,23,42,0.28)"
    : "0 8px 20px rgba(15,23,42,0.16)",
  transition: "box-shadow 0.2s ease",
});
