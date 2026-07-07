"use client";

import { useEffect, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { useRouter } from "next/navigation";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

export type GoalId = "leads" | "exposure" | "trust" | "sales" | "brand";
export type PlatformId = "instagram" | "tiktok" | "facebook" | "unknown";

type VibeId =
  | "professional_clean"
  | "warm_personal"
  | "bold_energetic"
  | "premium_luxury";
type ContentMode = "ai" | "camera" | "voice";
type CreationEntryMode =
  | "ai_full_video"
  | "reel_from_assets"
  | "talking_head"
  | "post_or_carousel"
  | "system_recommended";

type ContentFlow = {
  mode?: ContentMode;
  creationEntryMode?: CreationEntryMode;
  vibe?: VibeId;
  canFilm?: boolean;
  primaryGoal?: GoalId;
  goal?: string;
  contentArchetypeId?: string;
  audienceTypes?: string[];
  contentAngle?: string;
  contentGoalPrompt?: string;
  selectedDirection?: unknown;
  selectedFormat?: "reel" | "video" | "image" | "post";
  selectedPlatform?: PlatformId;
};

type GoalCard = {
  id: GoalId;
  icon: string;
  title: string;
  description: string;
  legacyGoal: "leads" | "trust" | "exposure" | "sales";
};

type PlatformChip = {
  id: PlatformId;
  label: string;
};

const goalCards: GoalCard[] = [
  {
    id: "leads",
    icon: "📩",
    title: "שישלחו הודעה",
    description: "תוכן שמוביל אנשים לפנות אליך",
    legacyGoal: "leads",
  },
  {
    id: "exposure",
    icon: "👀",
    title: "שיכירו אותי",
    description: "להגיע לעוד אנשים ולעצור את הגלילה",
    legacyGoal: "exposure",
  },
  {
    id: "trust",
    icon: "🤝",
    title: "שיסמכו עליי",
    description: "לבנות אמון ולהרגיש מקצועי",
    legacyGoal: "trust",
  },
  {
    id: "sales",
    icon: "🛍️",
    title: "שיקנו / יזמינו",
    description: "לקדם מוצר, שירות או הצעה",
    legacyGoal: "sales",
  },
  {
    id: "brand",
    icon: "✨",
    title: "שיזכרו אותי",
    description: "לחזק את הנוכחות והמותג שלך",
    legacyGoal: "exposure",
  },
];

const platformChips: PlatformChip[] = [
  { id: "instagram", label: "Instagram" },
  { id: "tiktok", label: "TikTok" },
  { id: "facebook", label: "Facebook" },
  { id: "unknown", label: "עדיין לא יודע/ת" },
];

function goalToLegacy(id: GoalId): string {
  return goalCards.find((c) => c.id === id)?.legacyGoal ?? "leads";
}

export default function GoalPage() {
  const router = useRouter();
  const [selectedGoal, setSelectedGoal] = useState<GoalId | null>(null);
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformId | null>(
    null
  );

  useEffect(() => {
    const raw = localStorage.getItem("content_flow");
    if (!raw) return;
    try {
      const parsed: ContentFlow = JSON.parse(raw);
      if (parsed.primaryGoal) setSelectedGoal(parsed.primaryGoal);
      if (parsed.selectedPlatform) setSelectedPlatform(parsed.selectedPlatform);
    } catch {
      // ignore
    }
  }, []);

  const canContinue = selectedGoal !== null && selectedPlatform !== null;

  function handleContinue() {
    if (!canContinue || selectedGoal === null || selectedPlatform === null)
      return;
    const raw = localStorage.getItem("content_flow");
    const existing: ContentFlow = raw ? JSON.parse(raw) : {};
    const updated: ContentFlow = {
      ...existing,
      primaryGoal: selectedGoal,
      goal: goalToLegacy(selectedGoal),
      selectedPlatform,
    };
    localStorage.setItem("content_flow", JSON.stringify(updated));
    router.push("/content/archetype");
  }

  return (
    <div style={pageStyle}>
      <style>{`
        .goal-card:focus-visible { outline: 3px solid #3b82f6; outline-offset: 3px; }
        .goal-card:focus:not(:focus-visible) { outline: none; }
        .platform-chip:focus-visible { outline: 3px solid #3b82f6; outline-offset: 2px; }
        .platform-chip:focus:not(:focus-visible) { outline: none; }
      `}</style>

      <div style={shellStyle}>
        <div style={topBarStyle}>
          <button
            type="button"
            onClick={() => router.back()}
            style={backButtonStyle}
          >
            חזרה
          </button>
          <div style={{ flex: 1 }} />
        </div>

        <ProgressBar progress={16} />

        <div style={contentAreaStyle}>
          <header style={heroStyle}>
            <h1 style={titleStyle}>מה הכי חשוב שהתוכן הזה יעשה?</h1>
            <p style={subtitleStyle}>בחר/י את המטרה המרכזית של הפוסט הזה.</p>
          </header>

          <div style={cardsListStyle} role="radiogroup" aria-label="מטרת התוכן">
            {goalCards.map((card) => {
              const isSelected = selectedGoal === card.id;
              return (
                <button
                  key={card.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={`${card.title} — ${card.description}`}
                  className="goal-card"
                  onClick={() => setSelectedGoal(card.id)}
                  style={goalCardStyle(isSelected)}
                >
                  {/* row-reverse: DOM order [icon, text, ring] renders as [ring | text | icon] */}
                  <span style={cardIconStyle} aria-hidden>
                    {card.icon}
                  </span>
                  <div style={cardTextBlockStyle}>
                    <span style={cardTitleStyle(isSelected)}>
                      {card.title}
                    </span>
                    <span style={cardDescStyle}>{card.description}</span>
                  </div>
                  <span style={cardRingStyle(isSelected)} aria-hidden />
                </button>
              );
            })}
          </div>

          {/* Platform mini-step — slides in after goal selection */}
          <div
            style={{
              ...platformSectionStyle,
              opacity: selectedGoal ? 1 : 0,
              transform: selectedGoal ? "translateY(0)" : "translateY(10px)",
              pointerEvents: selectedGoal ? "auto" : "none",
            }}
            aria-hidden={!selectedGoal}
          >
            <p style={platformLabelStyle}>איפה זה יעלה?</p>
            <div style={platformChipsRowStyle}>
              {platformChips.map((chip) => {
                const isSelected = selectedPlatform === chip.id;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    className="platform-chip"
                    aria-pressed={isSelected}
                    onClick={() => setSelectedPlatform(chip.id)}
                    style={platformChipStyle(isSelected)}
                  >
                    {chip.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            onClick={handleContinue}
            disabled={!canContinue}
            style={ctaButtonStyle(canContinue)}
          >
            המשך
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

const backButtonStyle: React.CSSProperties = {
  minWidth: 72,
  height: 40,
  borderRadius: 12,
  border: "1px solid #e5e7eb",
  background: "#ffffff",
  color: "#111827",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
  boxShadow: "0 2px 10px rgba(0,0,0,0.04)",
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
  marginBottom: 20,
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

const cardsListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "clamp(8px, 2.5vw, 12px)",
};

const goalCardStyle = (selected: boolean): React.CSSProperties => ({
  display: "flex",
  flexDirection: "row-reverse",
  alignItems: "center",
  gap: "clamp(10px, 3.5vw, 14px)",
  width: "100%",
  padding: "clamp(14px, 4vw, 18px) clamp(14px, 4vw, 18px)",
  borderRadius: 16,
  border: selected ? "2.5px solid #0f172a" : "1.5px solid #e2e8f0",
  background: selected
    ? "linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)"
    : "#ffffff",
  cursor: "pointer",
  textAlign: "right",
  boxShadow: selected
    ? "0 8px 24px rgba(15,23,42,0.12)"
    : "0 2px 10px rgba(15,23,42,0.06)",
  transform: selected ? "scale(1.015)" : "scale(1)",
  transition:
    "border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease, background 0.18s ease",
  WebkitTapHighlightColor: "transparent",
});

const cardIconStyle: React.CSSProperties = {
  fontSize: "clamp(1.55rem, 5.5vw, 1.9rem)",
  lineHeight: 1,
  flexShrink: 0,
  userSelect: "none",
};

const cardTextBlockStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: 3,
  minWidth: 0,
};

const cardTitleStyle = (selected: boolean): React.CSSProperties => ({
  display: "block",
  fontSize: "clamp(0.92rem, 3.5vw, 1.05rem)",
  fontWeight: 800,
  color: selected ? "#0f172a" : "#1e293b",
  lineHeight: 1.3,
});

const cardDescStyle: React.CSSProperties = {
  display: "block",
  fontSize: "clamp(0.75rem, 2.9vw, 0.84rem)",
  color: "#64748b",
  lineHeight: 1.45,
};

const cardRingStyle = (selected: boolean): React.CSSProperties => ({
  flexShrink: 0,
  width: 16,
  height: 16,
  borderRadius: "50%",
  border: selected ? "none" : "2px solid #cbd5e1",
  background: selected ? "#0f172a" : "transparent",
  transition: "background 0.15s ease, border-color 0.15s ease",
});

const platformSectionStyle: React.CSSProperties = {
  marginTop: 28,
  textAlign: "right",
  transition: "opacity 0.22s ease, transform 0.22s ease",
};

const platformLabelStyle: React.CSSProperties = {
  fontSize: "clamp(0.95rem, 3.5vw, 1rem)",
  fontWeight: 700,
  color: "#0f172a",
  margin: 0,
  marginBottom: 12,
};

const platformChipsRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  justifyContent: "flex-end",
};

const platformChipStyle = (selected: boolean): React.CSSProperties => ({
  height: 40,
  paddingInline: 18,
  borderRadius: 999,
  border: selected ? "none" : "1.5px solid #e2e8f0",
  background: selected ? "#0f172a" : "#ffffff",
  color: selected ? "#ffffff" : "#374151",
  fontSize: "clamp(0.82rem, 3vw, 0.9rem)",
  fontWeight: 700,
  cursor: "pointer",
  boxShadow: selected
    ? "0 4px 14px rgba(15,23,42,0.18)"
    : "0 1px 6px rgba(15,23,42,0.06)",
  transition:
    "background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease",
  WebkitTapHighlightColor: "transparent",
  whiteSpace: "nowrap",
});

const footerStyle: React.CSSProperties = {
  position: "sticky",
  bottom: 0,
  zIndex: 20,
  background: "linear-gradient(180deg, transparent 0%, #f8fafc 28%)",
  paddingTop: 16,
  paddingBottom: "calc(16px + env(safe-area-inset-bottom))",
  marginTop: "auto",
};

const ctaButtonStyle = (enabled: boolean): React.CSSProperties => ({
  width: "100%",
  maxWidth: 680,
  margin: "0 auto",
  display: "block",
  height: 52,
  borderRadius: 16,
  border: "none",
  background: enabled ? TOKEN.action.primary.background : "#cbd5e1",
  color: "#ffffff",
  fontSize: 16,
  fontWeight: 800,
  cursor: enabled ? "pointer" : "not-allowed",
  boxShadow: enabled ? TOKEN.action.primary.shadow : "none",
  transition: "background 0.15s ease, box-shadow 0.15s ease",
});
