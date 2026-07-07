"use client";

import { useEffect, useMemo, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { useRouter } from "next/navigation";
import ProgressBar from "@/components/ProgressBar";
import BackButton from "@/components/ui/back-button";
import { baseStyles } from "@/lib/styles/baseStyles";
import { TOKEN } from "@/lib/design/tokens";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DirectionId =
  | "authentic"
  | "attention"
  | "proof"
  | "differentiation"
  | "direct";

type GoalId = "leads" | "exposure" | "trust" | "sales" | "brand";
type VibeId =
  | "professional_clean"
  | "warm_personal"
  | "bold_energetic"
  | "premium_luxury";
type PlatformId = "instagram" | "tiktok" | "facebook" | "unknown";

type Signals = {
  primaryGoal: GoalId;
  vibe: VibeId;
  canFilm: boolean;
  platform: PlatformId;
};

type ContentFlow = {
  vibe?: VibeId;
  canFilm?: boolean;
  primaryGoal?: GoalId;
  goal?: string;
  selectedPlatform?: PlatformId;
  directionType?: DirectionId;
  directionReasoning?: string;
  contentArchetypeId?: string;
  contentAngle?: string;
  mode?: string;
  creationEntryMode?: string;
  contentGoalPrompt?: string;
  contentInsightAnswers?: unknown[];
  audienceTypes?: string[];
  selectedDirection?: unknown;
  selectedFormat?: string;
};

type DirectionCard = {
  id: DirectionId;
  icon: string;
  title: string;
  vibeTag: string;
  fitsIf: string;
  contentArchetypeId: string;
  legacyGoal: string;
  legacyAngle: string;
  accentBg: string;
  accentBorder: string;
  goalAffinity: GoalId[];
  vibeAffinity: VibeId[];
  platformBoost?: PlatformId[];
  cameraPreferred?: boolean;
};

type ScoredDirection = DirectionCard & {
  score: number;
  isRecommended: boolean;
  platformBadge: string | null;
};

// ── Direction library (one per unique video.* archetype) ──────────────────────

const DIRECTION_LIBRARY: DirectionCard[] = [
  {
    id: "authentic",
    icon: "🎤",
    title: "שיחה אמיתית",
    vibeTag: "מרגיש טבעי ולא כמו פרסומת",
    fitsIf: "יש לך קשר אישי עם הלקוחות שלך",
    contentArchetypeId: "video.creator",
    legacyGoal: "trust",
    legacyAngle: "explain",
    accentBg: "#fff7ed",
    accentBorder: "#fed7aa",
    goalAffinity: ["trust", "leads", "brand"],
    vibeAffinity: ["warm_personal"],
    cameraPreferred: true,
  },
  {
    id: "attention",
    icon: "⚡",
    title: "פתיחה חזקה",
    vibeTag: "בנוי לעצור אנשים מהר",
    fitsIf: "רוצים להגיע לאנשים חדשים שלא מכירים אותך",
    contentArchetypeId: "video.stop_scroll",
    legacyGoal: "exposure",
    legacyAngle: "attention",
    accentBg: "#f5f3ff",
    accentBorder: "#ddd6fe",
    goalAffinity: ["exposure", "leads", "brand"],
    vibeAffinity: ["bold_energetic", "warm_personal", "professional_clean"],
    platformBoost: ["tiktok", "instagram"],
  },
  {
    id: "proof",
    icon: "🎬",
    title: "סיפור קצר",
    vibeTag: "בונה חיבור ורגש לאורך הסרטון",
    fitsIf: "יש לך תוצאה טובה שאפשר להראות",
    contentArchetypeId: "video.trust",
    legacyGoal: "trust",
    legacyAngle: "trust",
    accentBg: "#f0fdf4",
    accentBorder: "#bbf7d0",
    goalAffinity: ["trust", "sales", "leads"],
    vibeAffinity: ["warm_personal", "professional_clean", "premium_luxury"],
  },
  {
    id: "differentiation",
    icon: "💡",
    title: "משהו שונה",
    vibeTag: "מראה את ההבדל שלך מהמתחרים",
    fitsIf: "רוצים שאנשים יבינו מה מייחד אותך",
    contentArchetypeId: "video.opinion",
    legacyGoal: "exposure",
    legacyAngle: "show_difference",
    accentBg: "#fefce8",
    accentBorder: "#fde68a",
    goalAffinity: ["exposure", "brand", "trust"],
    vibeAffinity: ["professional_clean", "bold_energetic", "premium_luxury"],
  },
  {
    id: "direct",
    icon: "📣",
    title: "ישיר ולעניין",
    vibeTag: "הצעה ברורה שמובילה ישר לפעולה",
    fitsIf: "יש לך מבצע, שירות או הצעה ספציפית",
    contentArchetypeId: "video.leads",
    legacyGoal: "leads",
    legacyAngle: "cta",
    accentBg: "#fff1f2",
    accentBorder: "#fecdd3",
    goalAffinity: ["leads", "sales"],
    vibeAffinity: [
      "professional_clean",
      "bold_energetic",
      "warm_personal",
      "premium_luxury",
    ],
  },
];

// ── Scoring & filtering ────────────────────────────────────────────────────────

function scoreDirection(dir: DirectionCard, signals: Signals): number {
  let score = 0;
  if (dir.goalAffinity.includes(signals.primaryGoal)) score += 4;
  if (dir.vibeAffinity.includes(signals.vibe)) score += 3;
  if (signals.canFilm && dir.cameraPreferred) score += 2;
  if (!signals.canFilm && dir.cameraPreferred) score -= 2;
  if (dir.platformBoost?.includes(signals.platform)) score += 1;
  return score;
}

function buildPlatformBadge(dir: DirectionCard, platform: PlatformId): string | null {
  if (!dir.platformBoost?.includes(platform)) return null;
  if (platform === "tiktok") return "עובד טוב ב-TikTok";
  if (platform === "instagram") return "מתאים לאינסטגרם";
  return null;
}

function filterDirections(signals: Signals): ScoredDirection[] {
  const scored = DIRECTION_LIBRARY.map((dir) => ({
    ...dir,
    score: scoreDirection(dir, signals),
  })).sort((a, b) => b.score - a.score);

  // deduplicate by contentArchetypeId (safety net)
  const seen = new Set<string>();
  const deduped = scored.filter(
    (d) => !seen.has(d.contentArchetypeId) && !!seen.add(d.contentArchetypeId)
  );

  // show up to 3 positive-scoring directions; fall back to top 2
  const positive = deduped.filter((d) => d.score > 0);
  const result = positive.length >= 2 ? positive.slice(0, 3) : deduped.slice(0, 2);

  return result.map((d, idx) => ({
    ...d,
    isRecommended: idx === 0,
    platformBadge: idx > 0 ? buildPlatformBadge(d, signals.platform) : null,
  }));
}

function toGoalId(val?: string): GoalId {
  const valid: GoalId[] = ["leads", "trust", "exposure", "sales", "brand"];
  return valid.includes(val as GoalId) ? (val as GoalId) : "trust";
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ContentDirectionPage() {
  const router = useRouter();
  const [signals, setSignals] = useState<Signals | null>(null);
  const [selectedId, setSelectedId] = useState<DirectionId | null>(null);

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
      setSignals({
        primaryGoal: parsed.primaryGoal ?? toGoalId(parsed.goal),
        vibe: parsed.vibe ?? "warm_personal",
        canFilm: parsed.canFilm ?? false,
        platform: parsed.selectedPlatform ?? "instagram",
      });
      if (parsed.directionType) setSelectedId(parsed.directionType);
    } catch {
      router.replace("/content");
    }
  }, [router]);

  const filteredDirections = useMemo(
    () => (signals ? filterDirections(signals) : []),
    [signals]
  );

  // if previously selected direction no longer appears in filtered list, clear it
  const effectiveSelectedId = useMemo(() => {
    if (!selectedId) return null;
    return filteredDirections.some((d) => d.id === selectedId) ? selectedId : null;
  }, [selectedId, filteredDirections]);

  const canContinue = Boolean(effectiveSelectedId);

  function handleContinue() {
    if (!effectiveSelectedId) return;
    const selected = filteredDirections.find((d) => d.id === effectiveSelectedId);
    if (!selected) return;

    const raw = localStorage.getItem("content_flow");
    const existing: ContentFlow = raw ? JSON.parse(raw) : {};

    localStorage.setItem(
      "content_flow",
      JSON.stringify({
        ...existing,
        contentArchetypeId: selected.contentArchetypeId,
        goal: selected.legacyGoal,
        contentAngle: selected.legacyAngle,
        directionType: selected.id,
        directionReasoning: selected.vibeTag,
      })
    );
    router.push("/content/setup");
  }

  if (!signals || filteredDirections.length === 0) {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <div style={topBarStyle}>
            <BackButton />
            <div style={{ flex: 1 }} />
          </div>
          <ProgressBar progress={24} />
          <p style={loadingTextStyle}>רגע אחד…</p>
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <style>{`
        .direction-card:focus-visible { outline: 3px solid #3b82f6; outline-offset: 3px; }
        .direction-card:focus:not(:focus-visible) { outline: none; }
      `}</style>

      <div style={shellStyle}>
        <div style={topBarStyle}>
          <BackButton />
          <div style={{ flex: 1 }} />
        </div>

        <ProgressBar progress={24} />

        <div style={contentAreaStyle}>
          <header style={heroStyle}>
            <h1 style={titleStyle}>איזה כיוון מרגיש הכי נכון לתוכן הזה?</h1>
            <p style={subtitleStyle}>
              בחר/י את הסגנון שהכי מתאים למה שרוצים להשיג.
            </p>
          </header>

          <div
            style={cardsListStyle}
            role="radiogroup"
            aria-label="כיוון יצירתי"
          >
            {filteredDirections.map((card) => {
              const isSelected = effectiveSelectedId === card.id;
              const badge = card.isRecommended
                ? "מומלץ בשבילך"
                : card.platformBadge ?? null;

              return (
                <button
                  key={card.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={`${card.title} — ${card.vibeTag}`}
                  className="direction-card"
                  onClick={() => setSelectedId(card.id)}
                  style={directionCardStyle(card, isSelected)}
                >
                  {badge && (
                    <span
                      style={badgeStyle(card.isRecommended)}
                      aria-hidden
                    >
                      {badge}
                    </span>
                  )}

                  {/* Icon + title row */}
                  <div style={cardHeaderRowStyle}>
                    <span style={cardTitleTextStyle(isSelected)}>
                      {card.title}
                    </span>
                    <span style={cardIconStyle} aria-hidden>
                      {card.icon}
                    </span>
                  </div>

                  {/* Vibe tag */}
                  <p style={vibeTagStyle(isSelected)}>{card.vibeTag}</p>

                  {/* Divider */}
                  <div style={dividerStyle(isSelected)} />

                  {/* Fits-if */}
                  <p style={fitsIfStyle}>
                    <span style={fitsIfLabelStyle}>מתאים אם: </span>
                    {card.fitsIf}
                  </p>
                </button>
              );
            })}
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

const loadingTextStyle: React.CSSProperties = {
  ...subtitleStyle,
  textAlign: "right",
  paddingTop: 24,
};

const cardsListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "clamp(12px, 3.5vw, 16px)",
};

const directionCardStyle = (
  card: DirectionCard,
  selected: boolean
): React.CSSProperties => ({
  position: "relative",
  width: "100%",
  minHeight: 152,
  borderRadius: 20,
  border: selected ? `2.5px solid ${card.accentBorder}` : "1.5px solid #e2e8f0",
  background: selected ? card.accentBg : "#ffffff",
  padding: "clamp(16px, 4.5vw, 20px) clamp(16px, 4.5vw, 20px)",
  cursor: "pointer",
  textAlign: "right",
  display: "flex",
  flexDirection: "column",
  gap: 0,
  boxShadow: selected
    ? `0 10px 32px rgba(0,0,0,0.08), 0 0 0 1px ${card.accentBorder}66`
    : "0 3px 12px rgba(15,23,42,0.07)",
  transform: selected ? "scale(1.015)" : "scale(1)",
  transition:
    "border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease, background 0.18s ease",
  WebkitTapHighlightColor: "transparent",
});

const badgeStyle = (isRecommended: boolean): React.CSSProperties => ({
  position: "absolute",
  top: 14,
  left: 14,
  fontSize: "clamp(0.68rem, 2.5vw, 0.74rem)",
  fontWeight: 800,
  letterSpacing: "0.02em",
  borderRadius: 999,
  padding: "4px 10px",
  background: isRecommended ? "#0f172a" : "#0ea5e9",
  color: "#ffffff",
  pointerEvents: "none",
  whiteSpace: "nowrap",
});

// row-reverse in LTR: icon (first in DOM) → rightmost; title → left of icon
const cardHeaderRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row-reverse",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "clamp(8px, 3vw, 12px)",
  marginBottom: 8,
};

const cardIconStyle: React.CSSProperties = {
  fontSize: "clamp(1.6rem, 5.5vw, 2rem)",
  lineHeight: 1,
  flexShrink: 0,
  userSelect: "none",
};

const cardTitleTextStyle = (selected: boolean): React.CSSProperties => ({
  fontSize: "clamp(1rem, 4vw, 1.2rem)",
  fontWeight: 800,
  color: selected ? "#0f172a" : "#1e293b",
  lineHeight: 1.25,
});

const vibeTagStyle = (selected: boolean): React.CSSProperties => ({
  fontSize: "clamp(0.82rem, 3vw, 0.92rem)",
  color: selected ? "#374151" : "#64748b",
  lineHeight: 1.5,
  margin: 0,
  marginBottom: 12,
});

const dividerStyle = (selected: boolean): React.CSSProperties => ({
  width: "100%",
  height: 1,
  background: selected ? "rgba(15,23,42,0.1)" : "rgba(226,232,240,0.9)",
  marginBottom: 10,
  flexShrink: 0,
});

const fitsIfStyle: React.CSSProperties = {
  fontSize: "clamp(0.72rem, 2.7vw, 0.8rem)",
  color: "#94a3b8",
  lineHeight: 1.5,
  margin: 0,
};

const fitsIfLabelStyle: React.CSSProperties = {
  fontWeight: 700,
  color: "#64748b",
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
