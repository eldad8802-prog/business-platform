"use client";

import { useEffect, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { useRouter } from "next/navigation";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

export type VibeId =
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
  contentArchetypeId?: string;
  goal?: string;
  audienceTypes?: string[];
  contentAngle?: string;
  contentGoalPrompt?: string;
  selectedDirection?: unknown;
  selectedFormat?: "reel" | "video" | "image" | "post";
  selectedPlatform?: "instagram" | "tiktok" | "facebook";
};

type VibeCard = {
  id: VibeId;
  label: string;
  sublabel: string;
  bgGradient: string;
  textColor: string;
  sublabelColor: string;
  borderColor: string;
  selectedBorderColor: string;
  icon: string;
};

const vibeCards: VibeCard[] = [
  {
    id: "professional_clean",
    label: "נקי ומקצועי",
    sublabel: "מסודר, ברור, מעורר אמון",
    bgGradient: "linear-gradient(145deg, #f8fafc 0%, #e2e8f0 100%)",
    textColor: "#0f172a",
    sublabelColor: "#475569",
    borderColor: "#e2e8f0",
    selectedBorderColor: "#334155",
    icon: "✦",
  },
  {
    id: "warm_personal",
    label: "חם ואישי",
    sublabel: "אנושי, אמיתי, מחבר",
    bgGradient: "linear-gradient(145deg, #fffbeb 0%, #fde68a 100%)",
    textColor: "#78350f",
    sublabelColor: "#92400e",
    borderColor: "#fde68a",
    selectedBorderColor: "#b45309",
    icon: "♥",
  },
  {
    id: "bold_energetic",
    label: "אנרגטי ודינמי",
    sublabel: "חזק, מרגש, עוצר גלגל",
    bgGradient: "linear-gradient(145deg, #f5f3ff 0%, #ddd6fe 100%)",
    textColor: "#4c1d95",
    sublabelColor: "#5b21b6",
    borderColor: "#ddd6fe",
    selectedBorderColor: "#7c3aed",
    icon: "⚡",
  },
  {
    id: "premium_luxury",
    label: "פרמיום ויוקרתי",
    sublabel: "עמוק, מרשים, בלתי נשכח",
    bgGradient: "linear-gradient(145deg, #1e293b 0%, #0f172a 100%)",
    textColor: "#f1f5f9",
    sublabelColor: "#94a3b8",
    borderColor: "#334155",
    selectedBorderColor: "#e2e8f0",
    icon: "◆",
  },
];

function vibeToMode(canFilm: boolean): ContentMode {
  return canFilm ? "camera" : "ai";
}

function vibeToEntryMode(canFilm: boolean): CreationEntryMode {
  return canFilm ? "reel_from_assets" : "ai_full_video";
}

export default function ContentPage() {
  const router = useRouter();
  const [selectedVibe, setSelectedVibe] = useState<VibeId | null>(null);
  const [canFilm, setCanFilm] = useState<boolean | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem("content_flow");
    if (!raw) return;
    try {
      const parsed: ContentFlow = JSON.parse(raw);
      if (parsed.vibe) setSelectedVibe(parsed.vibe);
      if (typeof parsed.canFilm === "boolean") setCanFilm(parsed.canFilm);
    } catch {
      // ignore
    }
  }, []);

  const canContinue = selectedVibe !== null && canFilm !== null;

  function handleContinue() {
    if (!canContinue || selectedVibe === null || canFilm === null) return;
    const raw = localStorage.getItem("content_flow");
    const existing: ContentFlow = raw ? JSON.parse(raw) : {};
    const updated: ContentFlow = {
      ...existing,
      vibe: selectedVibe,
      canFilm,
      mode: vibeToMode(canFilm),
      creationEntryMode: vibeToEntryMode(canFilm),
    };
    localStorage.setItem("content_flow", JSON.stringify(updated));
    router.push("/content/goal");
  }

  return (
    <div style={pageStyle}>
      <style>{`
        .vibe-tile:focus-visible { outline: 3px solid #3b82f6; outline-offset: 3px; }
        .vibe-tile:focus:not(:focus-visible) { outline: none; }
        .film-pill:focus-visible { outline: 3px solid #3b82f6; outline-offset: 2px; }
        .film-pill:focus:not(:focus-visible) { outline: none; }
      `}</style>

      <div style={shellStyle}>
        <div style={topBarStyle}>
          <button type="button" onClick={() => router.back()} style={backButtonStyle}>
            חזרה
          </button>
          <div style={{ flex: 1 }} />
        </div>

        <ProgressBar progress={8} />

        <div style={contentAreaStyle}>
          <header style={heroStyle}>
            <h1 style={titleStyle}>איך בא לך שהתוכן ירגיש?</h1>
            <p style={subtitleStyle}>בחר/י את הוויב שמתאים לעסק שלך</p>
          </header>

          <div style={cardsGridStyle} role="radiogroup" aria-label="סגנון תוכן">
            {vibeCards.map((card) => {
              const isSelected = selectedVibe === card.id;
              return (
                <button
                  key={card.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={`${card.label} — ${card.sublabel}`}
                  className="vibe-tile"
                  onClick={() => setSelectedVibe(card.id)}
                  style={vibeTileStyle(card, isSelected)}
                >
                  <span style={tileIconStyle(card)} aria-hidden>
                    {card.icon}
                  </span>
                  <div style={tileTextGroup}>
                    <span style={tileLabelStyle(card)}>{card.label}</span>
                    <span style={tileSublabelStyle(card)}>{card.sublabel}</span>
                  </div>
                  <span style={tileRingStyle(isSelected, card)} aria-hidden />
                </button>
              );
            })}
          </div>

          {/* canFilm question — slides in after vibe selection */}
          <div
            style={{
              ...filmSectionStyle,
              opacity: selectedVibe ? 1 : 0,
              transform: selectedVibe ? "translateY(0)" : "translateY(10px)",
              pointerEvents: selectedVibe ? "auto" : "none",
            }}
            aria-hidden={!selectedVibe}
          >
            <p style={filmQuestionLabelStyle}>יכול/ה להצטלם מול המצלמה?</p>
            <div style={filmChoicesRowStyle}>
              <button
                type="button"
                className="film-pill"
                aria-pressed={canFilm === true}
                onClick={() => setCanFilm(true)}
                style={filmPillStyle(canFilm === true)}
              >
                כן, בטח
              </button>
              <button
                type="button"
                className="film-pill"
                aria-pressed={canFilm === false}
                onClick={() => setCanFilm(false)}
                style={filmPillStyle(canFilm === false)}
              >
                עדיף לא
              </button>
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

const cardsGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "clamp(10px, 3vw, 14px)",
};

const vibeTileStyle = (card: VibeCard, selected: boolean): React.CSSProperties => ({
  position: "relative",
  width: "100%",
  aspectRatio: "3 / 4",
  minHeight: 152,
  borderRadius: 20,
  border: selected
    ? `2.5px solid ${card.selectedBorderColor}`
    : `1.5px solid ${card.borderColor}`,
  background: card.bgGradient,
  padding: "clamp(12px, 4vw, 16px)",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  justifyContent: "space-between",
  textAlign: "right",
  boxShadow: selected
    ? `0 10px 28px rgba(0,0,0,0.12), 0 0 0 1px ${card.selectedBorderColor}33`
    : "0 4px 14px rgba(15,23,42,0.07)",
  transform: selected ? "scale(1.025)" : "scale(1)",
  transition:
    "border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease",
  WebkitTapHighlightColor: "transparent",
});

const tileIconStyle = (card: VibeCard): React.CSSProperties => ({
  fontSize: "clamp(1.6rem, 6vw, 2rem)",
  lineHeight: 1,
  color: card.textColor,
  userSelect: "none",
  alignSelf: "flex-end",
});

const tileTextGroup: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  width: "100%",
  alignItems: "flex-end",
};

const tileLabelStyle = (card: VibeCard): React.CSSProperties => ({
  fontSize: "clamp(0.9rem, 3.5vw, 1.05rem)",
  fontWeight: 800,
  color: card.textColor,
  lineHeight: 1.3,
});

const tileSublabelStyle = (card: VibeCard): React.CSSProperties => ({
  fontSize: "clamp(0.68rem, 2.6vw, 0.76rem)",
  color: card.sublabelColor,
  lineHeight: 1.4,
});

const tileRingStyle = (selected: boolean, card: VibeCard): React.CSSProperties => ({
  position: "absolute",
  top: 12,
  left: 12,
  width: 13,
  height: 13,
  borderRadius: "50%",
  border: selected ? "none" : `2px solid ${card.borderColor}`,
  background: selected ? card.selectedBorderColor : "transparent",
  transition: "background 0.15s ease, border-color 0.15s ease",
});

const filmSectionStyle: React.CSSProperties = {
  marginTop: 28,
  textAlign: "right",
  transition: "opacity 0.22s ease, transform 0.22s ease",
};

const filmQuestionLabelStyle: React.CSSProperties = {
  fontSize: "clamp(1rem, 3.8vw, 1.1rem)",
  fontWeight: 700,
  color: "#0f172a",
  margin: 0,
  marginBottom: 14,
};

const filmChoicesRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  justifyContent: "flex-end",
};

const filmPillStyle = (selected: boolean): React.CSSProperties => ({
  height: 44,
  paddingInline: 24,
  borderRadius: 999,
  border: selected ? "none" : "1.5px solid #e2e8f0",
  background: selected ? "#0f172a" : "#ffffff",
  color: selected ? "#ffffff" : "#374151",
  fontSize: 15,
  fontWeight: 700,
  cursor: "pointer",
  boxShadow: selected
    ? "0 6px 18px rgba(15,23,42,0.2)"
    : "0 2px 8px rgba(15,23,42,0.06)",
  transition: "background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease",
  WebkitTapHighlightColor: "transparent",
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
