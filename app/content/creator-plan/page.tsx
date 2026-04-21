"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

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

type ContentFlow = {
  mode?: Mode;
  goal?: Goal;
  intent?: string;
  audienceTypes?: string[];
  contentAngle?: ContentAngle;
  contentGoalPrompt?: string;
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

function getPlatformLabel(platform?: SelectedPlatform) {
  switch (platform) {
    case "instagram":
      return "Instagram";
    case "tiktok":
      return "TikTok";
    case "facebook":
      return "Facebook";
    default:
      return "לא נבחרה פלטפורמה";
  }
}

function getFormatLabel(format?: SelectedFormat) {
  switch (format) {
    case "reel":
      return "Reel";
    case "video":
      return "Video";
    case "image":
      return "Image";
    case "post":
      return "Post";
    default:
      return "לא נבחר פורמט";
  }
}

function getVideoTypeLabel(videoType?: VideoType) {
  switch (videoType) {
    case "SHORT":
      return "קצר";
    case "MID":
      return "בינוני";
    case "FULL":
      return "מלא";
    default:
      return "לא ידוע";
  }
}

function getStructureLabel(part: string) {
  switch (part) {
    case "hook":
      return "Hook";
    case "pain":
      return "כאב";
    case "explanation":
      return "הסבר";
    case "solution":
      return "פתרון";
    case "proof":
      return "הוכחה";
    case "cta":
      return "קריאה לפעולה";
    case "value":
      return "ערך";
    case "context":
      return "הקשר";
    default:
      return part;
  }
}

export default function CreatorPlanPage() {
  const router = useRouter();

  const [flow, setFlow] = useState<ContentFlow | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [selectedVariantId, setSelectedVariantId] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  const selectedVariant = useMemo(() => {
    return variants.find((variant) => variant.id === selectedVariantId) || null;
  }, [variants, selectedVariantId]);

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
        router.replace("/content/direction");
        return;
      }

      if (parsedFlow.mode === "ai") {
        router.replace("/content/ai-brief");
        return;
      }

      setFlow(parsedFlow);
    } catch (err) {
      console.error(err);
      router.replace("/content");
    }
  }, [router]);

    useEffect(() => {
    if (!flow) return;

    const currentFlow = flow;
    let cancelled = false;

    async function loadPlan() {
      try {
        setIsLoading(true);
        setError("");

        const res = await fetch("/api/video/plan", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
              body: JSON.stringify({
            mode: currentFlow.mode,
            goal: currentFlow.goal,
            intent: currentFlow.intent,
            audienceTypes: currentFlow.audienceTypes ?? [],
            contentAngle: currentFlow.contentAngle,
            contentGoalPrompt: currentFlow.contentGoalPrompt ?? "",
            selectedDirection: currentFlow.selectedDirection,
            selectedFormat: currentFlow.selectedFormat,
            selectedPlatform: currentFlow.selectedPlatform,
          }),
        });

        const data = (await res.json()) as ApiResponse;

        if (!res.ok) {
          throw new Error(
            typeof (data as any)?.error === "string"
              ? (data as any).error
              : "failed_to_build_plan"
          );
        }

        const nextVariants = Array.isArray(data.variants) ? data.variants : [];

        if (!nextVariants.length) {
          throw new Error("no_variants_returned");
        }

        if (cancelled) return;

        setVariants(nextVariants);
        setSelectedVariantId(nextVariants[0].id);
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setError("לא הצלחנו לבנות תכנון תוכן כרגע");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadPlan();

    return () => {
      cancelled = true;
    };
  }, [flow]);

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
        JSON.stringify({
          selectedVariant,
          variants,
        })
      );

      router.push("/content/assets-upload");
    } catch (err) {
      console.error(err);
      setError("לא הצלחנו לשמור את הבחירה שלך");
      setIsSaving(false);
    }
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <button type="button" onClick={handleBack} style={backButtonStyle}>
            חזרה
          </button>

          <div style={topBarTitleStyle}>תכנון הצילום</div>

          <div style={topBarSpacerStyle} />
        </div>

        <Header title="תכנון הצילום" />
        <ProgressBar progress={68} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>שלב 6</div>
            <h1 style={titleStyle}>בחר את גרסת התוכן שהכי מתאימה לך</h1>
            <p style={subtitleStyle}>
              המערכת בנתה עבורך כמה גרסאות לפי המטרה, הפורמט והפלטפורמה שנבחרו.
              עכשיו בוחרים גרסה אחת וממשיכים לאיסוף חומרים.
            </p>
          </div>

          {flow ? (
            <div style={summaryGridStyle}>
              <div style={summaryCardStyle}>
                <div style={summaryLabelStyle}>פלטפורמה</div>
                <div style={summaryValueStyle}>
                  {getPlatformLabel(flow.selectedPlatform)}
                </div>
              </div>

              <div style={summaryCardStyle}>
                <div style={summaryLabelStyle}>פורמט</div>
                <div style={summaryValueStyle}>
                  {getFormatLabel(flow.selectedFormat)}
                </div>
              </div>

              <div style={summaryCardStyle}>
                <div style={summaryLabelStyle}>כיוון נבחר</div>
                <div style={summaryValueStyle}>
                  {flow.selectedDirection?.title || "לא נבחר"}
                </div>
              </div>
            </div>
          ) : null}

          {error ? (
            <div style={errorBoxStyle}>
              <div style={errorTitleStyle}>לא ניתן להמשיך כרגע</div>
              <div style={errorTextStyle}>{error}</div>
            </div>
          ) : null}

          {isLoading ? (
            <div style={loadingCardStyle}>
              <div style={loadingTitleStyle}>בונים לך את התכנון</div>
              <div style={loadingTextStyle}>
                המערכת מייצרת עכשיו וריאציות, מבנה, שוטים והנחיות צילום.
              </div>
            </div>
          ) : null}

          {!isLoading && !error ? (
            <>
              <div style={variantsWrapStyle}>
                {variants.map((variant) => {
                  const isSelected = variant.id === selectedVariantId;

                  return (
                    <button
                      key={variant.id}
                      type="button"
                      onClick={() => handleSelectVariant(variant.id)}
                      style={variantCardStyle(isSelected)}
                    >
                      <div style={variantHeaderStyle}>
                        <div>
                          <div style={variantTitleStyle}>{variant.title}</div>
                          <div style={variantDescriptionStyle}>
                            {variant.description}
                          </div>
                        </div>

                        <div style={scoreBadgeStyle}>
                          {variant.score}
                        </div>
                      </div>

                      <div style={chipsWrapStyle}>
                        <div style={chipStyle}>
                          {getVideoTypeLabel(variant.videoType)}
                        </div>
                        <div style={chipStyle}>{variant.durationSeconds} שנ׳</div>
                        <div style={chipStyle}>{variant.tone}</div>
                        <div style={chipStyle}>{variant.pace}</div>
                      </div>

                      <div style={whyItFitsBoxStyle}>
                        <div style={sectionMiniTitleStyle}>למה זה מתאים</div>
                        <div style={whyItFitsTextStyle}>{variant.whyItFits}</div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {selectedVariant ? (
                <div style={detailsCardStyle}>
                  <div style={detailsTitleStyle}>פירוט הגרסה שנבחרה</div>

                  <div style={sectionStyle}>
                    <div style={sectionTitleStyle}>מבנה הסרטון</div>
                    <div style={structureWrapStyle}>
                      {selectedVariant.structure.map((part, index) => (
                        <div key={`${part}-${index}`} style={structureStepStyle}>
                          <div style={structureIndexStyle}>{index + 1}</div>
                          <div style={structureTextStyle}>
                            {getStructureLabel(part)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {selectedVariant.script?.hook ? (
                    <div style={sectionStyle}>
                      <div style={sectionTitleStyle}>Hook</div>
                      <div style={hookBoxStyle}>{selectedVariant.script.hook}</div>
                    </div>
                  ) : null}

                  {selectedVariant.script?.scriptText ? (
                    <div style={sectionStyle}>
                      <div style={sectionTitleStyle}>תסריט מלא</div>
                      <div style={scriptBoxStyle}>
                        {selectedVariant.script.scriptText}
                      </div>
                    </div>
                  ) : null}

                  {selectedVariant.script?.caption ? (
                    <div style={sectionStyle}>
                      <div style={sectionTitleStyle}>Caption</div>
                      <div style={captionBoxStyle}>
                        {selectedVariant.script.caption}
                      </div>
                    </div>
                  ) : null}

                  {selectedVariant.script?.shots?.length ? (
                    <div style={sectionStyle}>
                      <div style={sectionTitleStyle}>שוטים</div>
                      <div style={shotsWrapStyle}>
                        {selectedVariant.script.shots.map((shot, index) => (
                          <div key={index} style={shotCardStyle}>
                            <div style={shotIndexStyle}>שוט {index + 1}</div>

                            <div style={shotFieldStyle}>
                              <div style={shotFieldTitleStyle}>מה רואים</div>
                              <div style={shotFieldTextStyle}>{shot.visual}</div>
                            </div>

                            <div style={shotFieldStyle}>
                              <div style={shotFieldTitleStyle}>מה אומרים</div>
                              <div style={shotFieldTextStyle}>{shot.voice}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {selectedVariant.shotRequests?.length ? (
                    <div style={sectionStyle}>
                      <div style={sectionTitleStyle}>הנחיות צילום</div>
                      <div style={requestsWrapStyle}>
                        {selectedVariant.shotRequests.map((request) => (
                          <div
                            key={request.index}
                            style={requestCardStyle}
                          >
                            <div style={requestIndexStyle}>
                              שוט {request.index + 1}
                            </div>
                            <div style={requestTextStyle}>
                              <strong>מטרה:</strong> {request.purpose}
                            </div>
                            <div style={requestTextStyle}>
                              <strong>ויזואל:</strong> {request.visualPrompt}
                            </div>
                            <div style={requestTextStyle}>
                              <strong>הנחיה:</strong> {request.shootingGuidance}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {selectedVariant.assetsPlan ? (
                    <div style={sectionStyle}>
                      <div style={sectionTitleStyle}>תכנון חומרים</div>

                      <div style={assetsGridStyle}>
                        <div style={assetsBoxStyle}>
                          <div style={assetsTitleStyle}>חומרים נדרשים</div>
                          <div style={assetsListStyle}>
                            {selectedVariant.assetsPlan.requiredAssets.map(
                              (item, index) => (
                                <div key={index} style={assetItemStyle}>
                                  • {item}
                                </div>
                              )
                            )}
                          </div>
                        </div>

                        <div style={assetsBoxStyle}>
                          <div style={assetsTitleStyle}>חומרים אופציונליים</div>
                          <div style={assetsListStyle}>
                            {selectedVariant.assetsPlan.optionalAssets.map(
                              (item, index) => (
                                <div key={index} style={assetItemStyle}>
                                  • {item}
                                </div>
                              )
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            onClick={handleContinue}
            disabled={!selectedVariant || isLoading || Boolean(error) || isSaving}
            style={nextButtonStyle(
              Boolean(selectedVariant) &&
                !isLoading &&
                !error &&
                !isSaving
            )}
          >
            {isSaving ? "שומרים..." : "המשך לאיסוף חומרים"}
          </button>
        </div>
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  ...baseStyles.page,
  background:
    "linear-gradient(180deg, #f8fafc 0%, #ffffff 35%, #f8fafc 100%)",
};

const shellStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 980,
  margin: "0 auto",
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
};

const topBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 16px 8px 16px",
};

const topBarTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "#111827",
};

const topBarSpacerStyle: React.CSSProperties = {
  width: 68,
};

const backButtonStyle: React.CSSProperties = {
  minWidth: 68,
  height: 38,
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
  ...baseStyles.container,
  flex: 1,
  width: "100%",
};

const introWrapStyle: React.CSSProperties = {
  marginBottom: 24,
};

const eyebrowStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 800,
  color: "#065f46",
  background: "#ecfdf5",
  border: "1px solid #a7f3d0",
  borderRadius: 999,
  padding: "6px 10px",
  marginBottom: 12,
};

const titleStyle: React.CSSProperties = {
  fontSize: 30,
  fontWeight: 800,
  lineHeight: 1.15,
  color: "#111827",
  margin: 0,
  marginBottom: 10,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 15,
  color: "#6b7280",
  lineHeight: 1.7,
  margin: 0,
  maxWidth: 720,
};

const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 12,
  marginBottom: 16,
};

const summaryCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 18,
  padding: 16,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
};

const summaryLabelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#6b7280",
  marginBottom: 6,
};

const summaryValueStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: "#111827",
};

const errorBoxStyle: React.CSSProperties = {
  background: "#fee2e2",
  border: "1px solid #fecaca",
  color: "#991b1b",
  borderRadius: 14,
  padding: 12,
  marginBottom: 16,
};

const errorTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  marginBottom: 4,
};

const errorTextStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
};

const loadingCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 18,
  padding: 18,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
};

const loadingTitleStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 6,
};

const loadingTextStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  color: "#6b7280",
};

const variantsWrapStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: 14,
  marginBottom: 18,
};

const variantCardStyle = (selected: boolean): React.CSSProperties => ({
  textAlign: "right",
  background: selected ? "#f8fafc" : "#ffffff",
  borderRadius: 18,
  padding: 16,
  border: selected ? "2px solid #111827" : "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
  cursor: "pointer",
  transition: "all 0.18s ease",
});

const variantHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  marginBottom: 12,
};

const variantTitleStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 4,
};

const variantDescriptionStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: "#6b7280",
};

const scoreBadgeStyle: React.CSSProperties = {
  minWidth: 44,
  height: 32,
  borderRadius: 999,
  background: "#111827",
  color: "#ffffff",
  fontSize: 13,
  fontWeight: 800,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const chipsWrapStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginBottom: 12,
};

const chipStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#111827",
  background: "#f3f4f6",
  border: "1px solid #e5e7eb",
  borderRadius: 999,
  padding: "6px 10px",
};

const whyItFitsBoxStyle: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #eef2f7",
  borderRadius: 14,
  padding: 12,
};

const sectionMiniTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: "#6b7280",
  marginBottom: 6,
};

const whyItFitsTextStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: "#374151",
};

const detailsCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 18,
  padding: 18,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
  marginBottom: 20,
};

const detailsTitleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 18,
};

const sectionStyle: React.CSSProperties = {
  marginBottom: 18,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 10,
};

const structureWrapStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
};

const structureStepStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
  borderRadius: 999,
  padding: "8px 12px",
};

const structureIndexStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: "50%",
  background: "#111827",
  color: "#ffffff",
  fontSize: 12,
  fontWeight: 800,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const structureTextStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#111827",
};

const hookBoxStyle: React.CSSProperties = {
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  color: "#1e3a8a",
  borderRadius: 14,
  padding: 14,
  fontSize: 15,
  lineHeight: 1.7,
  fontWeight: 700,
};

const scriptBoxStyle: React.CSSProperties = {
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
  color: "#111827",
  borderRadius: 14,
  padding: 14,
  fontSize: 14,
  lineHeight: 1.9,
  whiteSpace: "pre-wrap",
};

const captionBoxStyle: React.CSSProperties = {
  background: "#f3f4f6",
  border: "1px solid #e5e7eb",
  color: "#374151",
  borderRadius: 14,
  padding: 14,
  fontSize: 14,
  lineHeight: 1.8,
};

const shotsWrapStyle: React.CSSProperties = {
  display: "grid",
  gap: 12,
};

const shotCardStyle: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 16,
  padding: 14,
};

const shotIndexStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "#6b7280",
  marginBottom: 10,
};

const shotFieldStyle: React.CSSProperties = {
  marginBottom: 10,
};

const shotFieldTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 4,
};

const shotFieldTextStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.8,
  color: "#4b5563",
};

const requestsWrapStyle: React.CSSProperties = {
  display: "grid",
  gap: 10,
};

const requestCardStyle: React.CSSProperties = {
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
  borderRadius: 16,
  padding: 14,
};

const requestIndexStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 8,
};

const requestTextStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.8,
  color: "#4b5563",
  marginBottom: 4,
};

const assetsGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 12,
};

const assetsBoxStyle: React.CSSProperties = {
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
  borderRadius: 16,
  padding: 14,
};

const assetsTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 8,
};

const assetsListStyle: React.CSSProperties = {
  display: "grid",
  gap: 6,
};

const assetItemStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  color: "#4b5563",
};

const footerStyle: React.CSSProperties = {
  position: "sticky",
  bottom: 0,
  zIndex: 20,
  background: "rgba(255,255,255,0.92)",
  backdropFilter: "blur(10px)",
  borderTop: "1px solid #e5e7eb",
  padding: "12px 16px calc(12px + env(safe-area-inset-bottom)) 16px",
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-start",
};

const nextButtonStyle = (enabled: boolean): React.CSSProperties => ({
  minWidth: 180,
  height: 48,
  borderRadius: 14,
  border: "none",
  background: enabled ? "#111827" : "#9ca3af",
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 800,
  cursor: enabled ? "pointer" : "not-allowed",
  boxShadow: enabled ? "0 10px 24px rgba(17,24,39,0.18)" : "none",
});