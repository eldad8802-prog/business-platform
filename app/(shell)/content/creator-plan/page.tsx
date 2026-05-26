"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";
import type { ContentInsightAnswer } from "@/lib/features/content/question-engine/types";

// ── Types (unchanged) ─────────────────────────────────────────────────────────

type Goal = "leads" | "trust" | "exposure" | "sales";
type ContentAngle =
  | "show_result"
  | "explain"
  | "show_difference"
  | "attention"
  | "trust"
  | "cta";
type SelectedFormat = "reel" | "video" | "image" | "post";
type SelectedPlatform = "instagram" | "tiktok" | "facebook";
type Mode = "ai" | "camera" | "voice";
type VideoType = "SHORT" | "MID" | "FULL";

type CreationEntryMode =
  | "ai_full_video"
  | "reel_from_assets"
  | "talking_head"
  | "post_or_carousel"
  | "system_recommended";

type ContentFlow = {
  mode?: Mode;
  creationEntryMode?: CreationEntryMode;
  goal?: Goal;
  intent?: string;
  audienceTypes?: string[];
  contentAngle?: ContentAngle;
  contentGoalPrompt?: string;
  contentArchetypeId?: string;
  contentInsightAnswers?: ContentInsightAnswer[];
  selectedDirection?: {
    id?: string;
    title?: string;
    description?: string;
    whyItFits?: string;
    type?: string;
    strategy?: string;
    tone?: string;
    pace?: string;
    recommendedFormat?: SelectedFormat;
    score?: number;
  };
  selectedFormat?: SelectedFormat;
  selectedPlatform?: SelectedPlatform;
};

type Shot = {
  visual: string;
  voice: string;
};

type ShotRequest = {
  index: number;
  purpose: string;
  visualPrompt: string;
  shootingGuidance: string;
};

type AssetsPlan = {
  requiredAssets: string[];
  optionalAssets: string[];
};

type Variant = {
  id: string;
  title: string;
  description: string;
  whyItFits: string;
  score: number;
  tone: string;
  pace: string;
  videoType: VideoType;
  durationSeconds: number;
  structure: string[];
  script: {
    title?: string;
    hook?: string;
    scriptText?: string;
    caption?: string;
    shots?: Shot[];
  };
  shotRequests?: ShotRequest[];
  assetsPlan?: AssetsPlan;
};

type ApiResponse = {
  success?: boolean;
  variants?: Variant[];
  videoDecision?: {
    videoType?: VideoType;
    durationSeconds?: number;
    structure?: string[];
    reasoning?: string;
  };
};

// ── Business logic helpers (unchanged) ───────────────────────────────────────

/** Filming / mandatory-upload paths — product source of truth is `creationEntryMode` when present. */
function prefersFilmingAssetsBranch(flow: ContentFlow): boolean {
  const entry = flow.creationEntryMode;
  if (entry === "reel_from_assets" || entry === "talking_head") return true;
  if (
    entry === "ai_full_video" ||
    entry === "post_or_carousel" ||
    entry === "system_recommended"
  )
    return false;
  return flow.mode === "camera" || flow.mode === "voice";
}

// ── UI helpers ────────────────────────────────────────────────────────────────

type ToneAccent = { bg: string; border: string; ring: string };

function toneToAccent(tone?: string): ToneAccent {
  if (tone === "warm")
    return { bg: "#fff7ed", border: "#fed7aa", ring: "#b45309" };
  if (tone === "energetic")
    return { bg: "#f5f3ff", border: "#ddd6fe", ring: "#7c3aed" };
  if (tone === "premium")
    return { bg: "#0f172a", border: "#334155", ring: "#e2e8f0" };
  return { bg: "#f8fafc", border: "#e2e8f0", ring: "#334155" };
}

function buildMiniTags(variant: Variant, flow: ContentFlow | null): string[] {
  const tags: string[] = [];

  const toneMap: Record<string, string> = {
    warm: "חם ואישי",
    clear: "ישיר ומקצועי",
    energetic: "אנרגטי",
    premium: "פרמיום",
  };
  const toneTag = toneMap[variant.tone];
  if (toneTag) tags.push(toneTag);

  if (flow?.goal === "trust") tags.push("בונה אמון");
  else if (flow?.goal === "leads") tags.push("מניע לפנייה");
  else if (flow?.goal === "exposure") tags.push("מגיע לחשיפה");
  else if (flow?.goal === "sales") tags.push("מניע לרכישה");

  return tags.slice(0, 2);
}

type DurationFeel = "קצר ומהיר" | "מאוזן" | "יותר סיפור";

function getDurationFeel(
  pace: string | undefined,
  platform: SelectedPlatform | undefined
): DurationFeel {
  if (pace === "fast") return "קצר ומהיר";
  if (pace === "slow" && platform !== "tiktok") return "יותר סיפור";
  return "מאוזן";
}

function getDurationFeelLine(feel: DurationFeel): string {
  if (feel === "קצר ומהיר") return "בנוי לעצור מהר בפיד";
  if (feel === "יותר סיפור") return "נותן מקום לחיבור ואמון";
  return "יש זמן להסביר בלי לאבד קצב";
}

const LOADING_MESSAGES = [
  "מכינים כמה כיוונים שיכולים לעבוד",
  "רגע — בוחרים מה ירגיש הכי נכון",
  "כמעט מוכן",
] as const;

// ── Component ─────────────────────────────────────────────────────────────────

export default function CreatorPlanPage() {
  const router = useRouter();

  const [flow, setFlow] = useState<ContentFlow | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [selectedVariantId, setSelectedVariantId] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadingMsgIndex, setLoadingMsgIndex] = useState(0);

  const selectedVariant = useMemo(
    () => variants.find((v) => v.id === selectedVariantId) || null,
    [variants, selectedVariantId]
  );

  const showFilmingPrep = useMemo(
    () => (flow ? prefersFilmingAssetsBranch(flow) : false),
    [flow]
  );

  // ── Gate ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const flowRaw = localStorage.getItem("content_flow");
    if (!flowRaw) {
      router.replace("/content");
      return;
    }
    try {
      const parsedFlow = JSON.parse(flowRaw) as ContentFlow;
      if (
        !parsedFlow.mode ||
        !parsedFlow.goal ||
        !parsedFlow.contentAngle ||
        !parsedFlow.selectedDirection ||
        !parsedFlow.selectedFormat ||
        !parsedFlow.selectedPlatform
      ) {
        router.replace("/content/archetype");
        return;
      }
      setFlow(parsedFlow);
    } catch (err) {
      console.error(err);
      router.replace("/content");
    }
  }, [router]);

  // ── Loading message cycle ───────────────────────────────────────────────────
  useEffect(() => {
    if (!isLoading) return;
    const id = window.setInterval(
      () => setLoadingMsgIndex((i) => (i + 1) % LOADING_MESSAGES.length),
      2800
    );
    return () => window.clearInterval(id);
  }, [isLoading]);

  // ── API call (unchanged) ────────────────────────────────────────────────────
  useEffect(() => {
    if (!flow) return;

    const currentFlow = flow;
    let cancelled = false;
    const token = localStorage.getItem("token");

    async function loadPlan() {
      try {
        setIsLoading(true);
        setError("");
        setLoadingMsgIndex(0);

        if (!token) {
          setError("כדי להמשיך צריך להתחבר מחדש.");
          return;
        }

        let snapshot: ContentFlow = currentFlow;
        const flowRaw = localStorage.getItem("content_flow");
        if (flowRaw) {
          try {
            snapshot = JSON.parse(flowRaw) as ContentFlow;
          } catch {
            snapshot = currentFlow;
          }
        }

        const merged: ContentFlow = { ...currentFlow, ...snapshot };

        const res = await fetch("/api/video/plan", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            mode: merged.mode,
            goal: merged.goal,
            intent: merged.intent,
            audienceTypes: merged.audienceTypes ?? [],
            contentAngle: merged.contentAngle,
            contentGoalPrompt: merged.contentGoalPrompt ?? "",
            contentArchetypeId: merged.contentArchetypeId,
            ...(Array.isArray(merged.contentInsightAnswers) &&
            merged.contentInsightAnswers.length > 0
              ? { contentInsightAnswers: merged.contentInsightAnswers }
              : {}),
            selectedDirection: merged.selectedDirection,
            selectedFormat: merged.selectedFormat,
            selectedPlatform: merged.selectedPlatform,
          }),
        });

        const data = (await res.json()) as ApiResponse;

        if (!res.ok) {
          if ((data as { error?: string })?.error === "brief_required") {
            if (!cancelled) router.replace("/content/setup");
            return;
          }
          throw new Error(
            typeof (data as { error?: unknown })?.error === "string"
              ? String((data as { error: string }).error)
              : "failed_to_build_plan"
          );
        }

        const nextVariants = Array.isArray(data.variants) ? data.variants : [];
        if (!nextVariants.length) throw new Error("no_variants_returned");
        if (cancelled) return;

        setVariants(nextVariants);
        setSelectedVariantId(nextVariants[0].id);
      } catch (err) {
        console.error(err);
        if (!cancelled)
          setError(
            "לא הצלחנו להרכיב את התכנון כרגע. אפשר לנסות שוב בעוד רגע."
          );
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void loadPlan();
    return () => {
      cancelled = true;
    };
  }, [flow]);

  // ── Handlers (unchanged) ────────────────────────────────────────────────────
  function handleBack() {
    router.back();
  }

  function handleSelectVariant(id: string) {
    setSelectedVariantId(id);
  }

  function handleContinue() {
    if (!flow || !selectedVariant) return;
    try {
      setIsSaving(true);
      localStorage.setItem(
        "content_result",
        JSON.stringify({ selectedVariant, variants })
      );
      router.push(
        prefersFilmingAssetsBranch(flow)
          ? "/content/shot-direction"
          : "/content/ai-assets"
      );
    } catch (err) {
      console.error(err);
      setError("לא הצלחנו לשמור את הבחירה. נסה שוב.");
      setIsSaving(false);
    }
  }

  const canContinue =
    Boolean(selectedVariant) && !isLoading && !error && !isSaving;

  const ctaLabel = isSaving
    ? "רגע אחד…"
    : showFilmingPrep
      ? "המשך — לצילום"
      : "זה הכיוון שלי";

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={pageStyle}>
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @keyframes cpLoaderSpin { to { transform: rotate(360deg); } }
            .cp-card:focus-visible { outline: 3px solid #3b82f6; outline-offset: 3px; }
            .cp-card:focus:not(:focus-visible) { outline: none; }
          `,
        }}
      />

      <div style={shellStyle}>
        {/* Top bar */}
        <div style={topBarStyle}>
          <button type="button" onClick={handleBack} style={backButtonStyle}>
            חזרה
          </button>
          <div style={{ flex: 1 }} />
        </div>

        <ProgressBar progress={68} />

        <div style={contentAreaStyle}>
          {/* ── Header ── */}
          <header style={heroStyle}>
            {isLoading ? (
              <>
                <div style={eyebrowLoadingStyle}>כמעט שם</div>
                <h1 style={titleLoadingStyle}>
                  {showFilmingPrep
                    ? "מכינים את רשימת הצילום"
                    : "מכינים כמה כיוונים לבחירה"}
                </h1>
              </>
            ) : (
              <>
                <div style={eyebrowStyle}>בחירה</div>
                <h1 style={titleStyle}>
                  {showFilmingPrep
                    ? "לפני הצילום — בחר/י את הכיוון"
                    : "בנינו כמה כיוונים שיכולים לעבוד מצוין בשבילך"}
                </h1>
                <p style={subtitleStyle}>
                  {showFilmingPrep
                    ? "בחרו סגנון, ואחר כך נרכיב רשימת ציוד וצילום."
                    : "בחר/י את הסגנון שהכי מתאים למה שרוצים להשיג."}
                </p>
              </>
            )}
          </header>

          {/* ── Loading ── */}
          {isLoading && (
            <div style={loadingCardStyle}>
              <div style={loadingSpinnerWrapStyle}>
                <div style={loadingSpinnerStyle} aria-hidden />
              </div>
              <div style={loadingTitleStyle}>
                {LOADING_MESSAGES[loadingMsgIndex]}
              </div>
              <div style={loadingBodyStyle}>
                {showFilmingPrep
                  ? "רגע קצר — מסדרים את מה שיעזור לכם לצלם בביטחון."
                  : "רגע קצר — מכינים כמה כיוונים שונים שתוכלו לבחור מהם."}
              </div>
            </div>
          )}

          {/* ── Error ── */}
          {error && (
            <div style={errorBoxStyle}>
              <div style={errorTitleStyle}>רגע, משהו נתקע</div>
              <div style={errorBodyStyle}>{error}</div>
            </div>
          )}

          {/* ── Recommendation strip ── */}
          {!isLoading && !error && variants.length > 0 && (
            <div style={recommendationStripStyle}>
              <span style={sparkStyle} aria-hidden>
                ✦
              </span>
              <span style={recommendationTextStyle}>
                לפי הוויב, המטרה והפלטפורמה שבחרת — הכיוון הראשון צפוי לעבוד הכי טוב.
              </span>
            </div>
          )}

          {/* ── Variant cards ── */}
          {!isLoading && !error && (
            <div
              style={cardsListStyle}
              role="radiogroup"
              aria-label="כיוון יצירתי"
            >
              {variants.map((variant, index) => {
                const isSelected = variant.id === selectedVariantId;
                const isRecommended = index === 0;
                const accent = toneToAccent(variant.tone);
                const isPremium = variant.tone === "premium";
                const tags = buildMiniTags(variant, flow);
                const durationFeel = getDurationFeel(variant.pace, flow?.selectedPlatform);
                const durationLine = getDurationFeelLine(durationFeel);

                return (
                  <button
                    key={variant.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    aria-label={variant.title}
                    className="cp-card"
                    onClick={() => handleSelectVariant(variant.id)}
                    style={variantCardStyle(isSelected, accent, isPremium)}
                  >
                    {/* Recommended badge */}
                    {isRecommended && (
                      <span style={recommendedBadgeStyle} aria-label="מומלץ בשבילך">
                        מומלץ בשבילך
                      </span>
                    )}

                    {/* Title row + selection ring */}
                    <div style={cardHeaderRowStyle}>
                      <div style={selectionRingStyle(isSelected, accent, isPremium)}>
                        {isSelected && (
                          <span style={checkmarkStyle}>✓</span>
                        )}
                      </div>
                      <h2 style={cardTitleStyle(isPremium)}>{variant.title}</h2>
                    </div>

                    {/* Vibe line */}
                    <p style={vibeLineStyle(isPremium)}>{variant.description}</p>

                    {/* Divider */}
                    <div style={dividerStyle(isPremium)} />

                    {/* Hook preview */}
                    {variant.script?.hook && (
                      <div style={hookWrapStyle(isPremium)}>
                        <span style={hookLabelStyle(isPremium)}>פתיחה</span>
                        <p style={hookTextStyle(isPremium)}>
                          "{variant.script.hook}"
                        </p>
                      </div>
                    )}

                    {/* Why it fits */}
                    <p style={whyItFitsStyle(isPremium)}>
                      <span style={fitsLabelStyle(isPremium)}>מתאים אם: </span>
                      {variant.whyItFits}
                    </p>

                    {/* Duration feel line */}
                    <p style={durationFeelLineStyle(isPremium)}>
                      {durationLine}
                    </p>

                    {/* Mini tags + duration feel badge */}
                    <div style={miniTagsRowStyle}>
                      {tags.map((tag) => (
                        <span key={tag} style={miniTagStyle(isPremium)}>
                          {tag}
                        </span>
                      ))}
                      <span style={durationTagStyle(isPremium)}>
                        {durationFeel}
                      </span>
                    </div>

                    {/* Filming prep — inline when selected */}
                    {isSelected && showFilmingPrep && (
                      <div style={filmingPrepStyle(isPremium)}>
                        {variant.script?.shots?.length ? (
                          <div style={prepSectionStyle}>
                            <div style={prepSectionTitleStyle(isPremium)}>
                              שוטים
                            </div>
                            {variant.script.shots.map((shot, i) => (
                              <div key={i} style={shotRowStyle(isPremium)}>
                                <div style={shotIndexStyle(isPremium)}>
                                  שוט {i + 1}
                                </div>
                                <div style={shotFieldStyle(isPremium)}>
                                  <strong>מה רואים:</strong> {shot.visual}
                                </div>
                                <div style={shotFieldStyle(isPremium)}>
                                  <strong>מה אומרים:</strong> {shot.voice}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}

                        {variant.shotRequests?.length ? (
                          <div style={prepSectionStyle}>
                            <div style={prepSectionTitleStyle(isPremium)}>
                              הנחיות צילום
                            </div>
                            {variant.shotRequests.map((req) => (
                              <div key={req.index} style={shotRowStyle(isPremium)}>
                                <div style={shotIndexStyle(isPremium)}>
                                  שוט {req.index + 1}
                                </div>
                                <div style={shotFieldStyle(isPremium)}>
                                  <strong>מטרה:</strong> {req.purpose}
                                </div>
                                <div style={shotFieldStyle(isPremium)}>
                                  <strong>מה לצלם:</strong> {req.visualPrompt}
                                </div>
                                <div style={shotFieldStyle(isPremium)}>
                                  <strong>הנחיה:</strong> {req.shootingGuidance}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}

                        {variant.assetsPlan ? (
                          <div style={prepSectionStyle}>
                            <div style={prepSectionTitleStyle(isPremium)}>
                              חומרים
                            </div>
                            <div style={assetsGridStyle}>
                              <div>
                                <div style={assetGroupTitleStyle(isPremium)}>
                                  נדרשים
                                </div>
                                {variant.assetsPlan.requiredAssets.map(
                                  (item, i) => (
                                    <div key={i} style={assetItemStyle(isPremium)}>
                                      • {item}
                                    </div>
                                  )
                                )}
                              </div>
                              <div>
                                <div style={assetGroupTitleStyle(isPremium)}>
                                  אופציונלי
                                </div>
                                {variant.assetsPlan.optionalAssets.map(
                                  (item, i) => (
                                    <div key={i} style={assetItemStyle(isPremium)}>
                                      • {item}
                                    </div>
                                  )
                                )}
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Hint after selection */}
          {selectedVariant && !showFilmingPrep && !isLoading && !error && (
            <p style={aiHintStyle}>
              אפשר לשנות בחירה בכל רגע. בהמשך נבנה את הסרטון לפי מה שבחרת.
            </p>
          )}
        </div>

        {/* ── Footer CTA ── */}
        <div style={footerStyle}>
          <button
            type="button"
            onClick={handleContinue}
            disabled={!canContinue}
            style={ctaButtonStyle(canContinue)}
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
  background: "linear-gradient(180deg, #f4f6fb 0%, #ffffff 40%, #f8fafc 100%)",
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
  paddingBottom: 20,
};

// ── Hero ──────────────────────────────────────────────────────────────────────

const heroStyle: React.CSSProperties = {
  textAlign: "right",
  marginBottom: 24,
  marginTop: 4,
};

const eyebrowStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: 12,
  fontWeight: 800,
  color: "#065f46",
  background: "#ecfdf5",
  border: "1px solid #a7f3d0",
  borderRadius: 999,
  padding: "5px 12px",
  marginBottom: 12,
  letterSpacing: "0.02em",
};

const eyebrowLoadingStyle: React.CSSProperties = {
  ...eyebrowStyle,
  color: "#1e40af",
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
};

const titleStyle: React.CSSProperties = {
  fontSize: "clamp(1.45rem, 5vw, 1.85rem)",
  fontWeight: 800,
  lineHeight: 1.25,
  color: "#0f172a",
  margin: 0,
  marginBottom: 10,
  letterSpacing: "-0.02em",
};

const titleLoadingStyle: React.CSSProperties = {
  ...titleStyle,
  color: "#94a3b8",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: "clamp(0.92rem, 3.5vw, 1rem)",
  lineHeight: 1.65,
  color: "#64748b",
  margin: 0,
};

// ── Loading ───────────────────────────────────────────────────────────────────

const loadingCardStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",
  borderRadius: 24,
  padding: "32px 24px 36px",
  border: "1px solid #e2e8f0",
  boxShadow: "0 8px 32px rgba(15,23,42,0.07)",
  textAlign: "center",
  maxWidth: 420,
  margin: "0 auto 24px",
};

const loadingSpinnerWrapStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "center",
  marginBottom: 22,
};

const loadingSpinnerStyle: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: "50%",
  border: "4px solid #e2e8f0",
  borderTopColor: "#0f172a",
  animation: "cpLoaderSpin 0.78s linear infinite",
};

const loadingTitleStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: "#0f172a",
  marginBottom: 8,
  lineHeight: 1.35,
  minHeight: "2.7em",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
};

const loadingBodyStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.65,
  color: "#64748b",
  maxWidth: 320,
  margin: "0 auto",
};

// ── Error ─────────────────────────────────────────────────────────────────────

const errorBoxStyle: React.CSSProperties = {
  background: "#fee2e2",
  border: "1px solid #fecaca",
  borderRadius: 16,
  padding: "14px 16px",
  marginBottom: 18,
};

const errorTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "#991b1b",
  marginBottom: 4,
};

const errorBodyStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: "#b91c1c",
};

// ── Recommendation strip ──────────────────────────────────────────────────────

const recommendationStripStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
  borderRadius: 18,
  padding: "14px 18px",
  marginBottom: 20,
  textAlign: "right",
};

const sparkStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#fbbf24",
  flexShrink: 0,
  marginTop: 2,
};

const recommendationTextStyle: React.CSSProperties = {
  fontSize: "clamp(0.8rem, 3vw, 0.88rem)",
  lineHeight: 1.6,
  color: "#e2e8f0",
  fontWeight: 600,
};

// ── Cards ─────────────────────────────────────────────────────────────────────

const cardsListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "clamp(14px, 3.5vw, 18px)",
};

const variantCardStyle = (
  selected: boolean,
  accent: ToneAccent,
  isPremium: boolean
): React.CSSProperties => ({
  position: "relative",
  width: "100%",
  borderRadius: 24,
  border: selected
    ? `2.5px solid ${accent.ring}`
    : `1.5px solid ${isPremium ? "#334155" : "#e2e8f0"}`,
  background: selected
    ? isPremium
      ? "#0f172a"
      : accent.bg
    : isPremium
      ? "#1e293b"
      : "#ffffff",
  padding: "clamp(20px, 5vw, 26px)",
  paddingTop: "clamp(28px, 6vw, 36px)",
  cursor: "pointer",
  textAlign: "right",
  display: "flex",
  flexDirection: "column",
  gap: 0,
  boxShadow: selected
    ? `0 16px 48px rgba(15,23,42,0.13), 0 0 0 1px ${accent.ring}22`
    : isPremium
      ? "0 8px 28px rgba(15,23,42,0.18)"
      : "0 4px 18px rgba(15,23,42,0.06)",
  transform: selected ? "scale(1.01)" : "scale(1)",
  transition:
    "border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease, background 0.2s ease",
  WebkitTapHighlightColor: "transparent",
});

const recommendedBadgeStyle: React.CSSProperties = {
  position: "absolute",
  top: 14,
  left: 14,
  fontSize: 11,
  fontWeight: 800,
  color: "#ffffff",
  background: "#0f172a",
  borderRadius: 999,
  padding: "5px 12px",
  letterSpacing: "0.03em",
  boxShadow: "0 4px 12px rgba(15,23,42,0.28)",
  pointerEvents: "none",
};

const cardHeaderRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row-reverse",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 10,
};

const selectionRingStyle = (
  selected: boolean,
  accent: ToneAccent,
  isPremium: boolean
): React.CSSProperties => ({
  flexShrink: 0,
  width: 22,
  height: 22,
  borderRadius: "50%",
  border: selected
    ? "none"
    : `2px solid ${isPremium ? "#475569" : "#cbd5e1"}`,
  background: selected ? accent.ring : "transparent",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "background 0.15s ease, border-color 0.15s ease",
});

const checkmarkStyle: React.CSSProperties = {
  color: "#ffffff",
  fontSize: 11,
  fontWeight: 900,
  lineHeight: 1,
};

const cardTitleStyle = (isPremium: boolean): React.CSSProperties => ({
  fontSize: "clamp(1.1rem, 4vw, 1.3rem)",
  fontWeight: 800,
  color: isPremium ? "#f1f5f9" : "#0f172a",
  lineHeight: 1.25,
  margin: 0,
  flex: 1,
  textAlign: "right",
});

const vibeLineStyle = (isPremium: boolean): React.CSSProperties => ({
  fontSize: "clamp(0.88rem, 3.2vw, 0.96rem)",
  color: isPremium ? "#94a3b8" : "#64748b",
  lineHeight: 1.55,
  margin: 0,
  marginBottom: 16,
});

const dividerStyle = (isPremium: boolean): React.CSSProperties => ({
  width: "100%",
  height: 1,
  background: isPremium ? "rgba(255,255,255,0.08)" : "#f1f5f9",
  marginBottom: 16,
  flexShrink: 0,
});

// ── Hook preview ──────────────────────────────────────────────────────────────

const hookWrapStyle = (isPremium: boolean): React.CSSProperties => ({
  borderRight: `3px solid ${isPremium ? "rgba(226,232,240,0.2)" : "#e2e8f0"}`,
  paddingRight: 12,
  marginBottom: 16,
});

const hookLabelStyle = (isPremium: boolean): React.CSSProperties => ({
  display: "block",
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: "0.06em",
  color: isPremium ? "#475569" : "#94a3b8",
  textTransform: "uppercase" as const,
  marginBottom: 5,
});

const hookTextStyle = (isPremium: boolean): React.CSSProperties => ({
  fontSize: "clamp(0.92rem, 3.3vw, 1rem)",
  lineHeight: 1.6,
  color: isPremium ? "#cbd5e1" : "#374151",
  fontStyle: "italic",
  margin: 0,
});

// ── Why it fits ───────────────────────────────────────────────────────────────

const whyItFitsStyle = (isPremium: boolean): React.CSSProperties => ({
  fontSize: "clamp(0.82rem, 3vw, 0.9rem)",
  lineHeight: 1.55,
  color: isPremium ? "#64748b" : "#94a3b8",
  margin: 0,
  marginBottom: 14,
});

const fitsLabelStyle = (isPremium: boolean): React.CSSProperties => ({
  fontWeight: 700,
  color: isPremium ? "#475569" : "#64748b",
});

// ── Mini tags ─────────────────────────────────────────────────────────────────

const miniTagsRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: 6,
  justifyContent: "flex-end",
};

const miniTagStyle = (isPremium: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  height: 26,
  paddingInline: 10,
  borderRadius: 999,
  fontSize: "clamp(0.72rem, 2.6vw, 0.78rem)",
  fontWeight: 700,
  background: isPremium ? "rgba(255,255,255,0.08)" : "#f1f5f9",
  color: isPremium ? "#64748b" : "#475569",
  border: `1px solid ${isPremium ? "rgba(255,255,255,0.1)" : "#e2e8f0"}`,
});

// ── Duration feel ─────────────────────────────────────────────────────────────

const durationFeelLineStyle = (isPremium: boolean): React.CSSProperties => ({
  fontSize: "clamp(0.8rem, 2.9vw, 0.86rem)",
  lineHeight: 1.5,
  color: isPremium ? "#475569" : "#94a3b8",
  margin: 0,
  marginBottom: 14,
  fontStyle: "italic",
});

const durationTagStyle = (isPremium: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  height: 26,
  paddingInline: 10,
  borderRadius: 999,
  fontSize: "clamp(0.72rem, 2.6vw, 0.78rem)",
  fontWeight: 700,
  background: isPremium ? "rgba(56,189,248,0.10)" : "#eff6ff",
  color: isPremium ? "#7dd3fc" : "#1d4ed8",
  border: `1px solid ${isPremium ? "rgba(56,189,248,0.20)" : "#bfdbfe"}`,
});

// ── Filming prep (inline) ─────────────────────────────────────────────────────

const filmingPrepStyle = (isPremium: boolean): React.CSSProperties => ({
  marginTop: 20,
  paddingTop: 18,
  borderTop: `1px solid ${isPremium ? "rgba(255,255,255,0.08)" : "#f1f5f9"}`,
  display: "flex",
  flexDirection: "column",
  gap: 16,
});

const prepSectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const prepSectionTitleStyle = (isPremium: boolean): React.CSSProperties => ({
  fontSize: 13,
  fontWeight: 800,
  color: isPremium ? "#94a3b8" : "#374151",
  textAlign: "right",
});

const shotRowStyle = (isPremium: boolean): React.CSSProperties => ({
  background: isPremium ? "rgba(255,255,255,0.05)" : "#f8fafc",
  borderRadius: 14,
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  textAlign: "right",
});

const shotIndexStyle = (isPremium: boolean): React.CSSProperties => ({
  fontSize: 12,
  fontWeight: 800,
  color: isPremium ? "#475569" : "#94a3b8",
});

const shotFieldStyle = (isPremium: boolean): React.CSSProperties => ({
  fontSize: 13,
  lineHeight: 1.7,
  color: isPremium ? "#94a3b8" : "#4b5563",
});

const assetsGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 10,
};

const assetGroupTitleStyle = (isPremium: boolean): React.CSSProperties => ({
  fontSize: 12,
  fontWeight: 800,
  color: isPremium ? "#475569" : "#6b7280",
  marginBottom: 6,
  textAlign: "right",
});

const assetItemStyle = (isPremium: boolean): React.CSSProperties => ({
  fontSize: 13,
  lineHeight: 1.7,
  color: isPremium ? "#64748b" : "#4b5563",
  textAlign: "right",
});

// ── Hint ──────────────────────────────────────────────────────────────────────

const aiHintStyle: React.CSSProperties = {
  fontSize: "clamp(0.78rem, 2.8vw, 0.84rem)",
  lineHeight: 1.65,
  color: "#94a3b8",
  textAlign: "right",
  marginTop: 16,
  marginBottom: 4,
  maxWidth: 480,
  marginInlineStart: "auto",
};

// ── Footer ────────────────────────────────────────────────────────────────────

const footerStyle: React.CSSProperties = {
  position: "sticky",
  bottom: 0,
  zIndex: 20,
  background: "linear-gradient(180deg, transparent 0%, #f8fafc 28%)",
  paddingTop: 16,
  paddingBottom: "calc(20px + env(safe-area-inset-bottom))",
  marginTop: "auto",
};

const ctaButtonStyle = (enabled: boolean): React.CSSProperties => ({
  width: "100%",
  maxWidth: 680,
  margin: "0 auto",
  display: "block",
  height: 54,
  borderRadius: 16,
  border: "none",
  background: enabled ? "#0f172a" : "#cbd5e1",
  color: "#ffffff",
  fontSize: 16,
  fontWeight: 800,
  cursor: enabled ? "pointer" : "not-allowed",
  boxShadow: enabled ? "0 12px 32px rgba(15,23,42,0.26)" : "none",
  transition: "background 0.15s ease, box-shadow 0.15s ease",
  letterSpacing: "-0.01em",
});
