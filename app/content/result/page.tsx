"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

type RenderOutput = {
  renderId?: string;
  status?: string;
  url?: string;
  snapshotUrl?: string | null;
};

type SelectedVariant = {
  id?: string;
  title?: string;
  description?: string;
  whyItFits?: string;
  score?: number;
  tone?: string;
  pace?: string;
  videoType?: "SHORT" | "MID" | "FULL";
  durationSeconds?: number;
  structure?: string[];
  script?: {
    title?: string;
    hook?: string;
    scriptText?: string;
    caption?: string;
    shots?: { visual: string; voice: string }[];
  };
  shotRequests?: {
    index: number;
    purpose: string;
    visualPrompt: string;
    shootingGuidance: string;
  }[];
  assetsPlan?: {
    requiredAssets: string[];
    optionalAssets: string[];
  };
};

type ContentResult = {
  selectedVariant?: SelectedVariant;
};

type SocialPlatform = "instagram" | "tiktok" | "facebook" | "other";

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function parseNonNegativeInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

function clipText(value: string, maxLen: number): string {
  const t = (value || "").trim();
  if (!t) return "";
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen).trim();
}

function getVideoTypeLabel(videoType?: SelectedVariant["videoType"]) {
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

export default function ResultPage() {
  const router = useRouter();

  const [renderOutput, setRenderOutput] = useState<RenderOutput | null>(null);
  const [contentResult, setContentResult] = useState<ContentResult | null>(null);
  const [defaultPlatform, setDefaultPlatform] = useState<SocialPlatform>("other");
  const [platform, setPlatform] = useState<SocialPlatform>("other");
  const [postUrl, setPostUrl] = useState("");
  const [savedPostUrl, setSavedPostUrl] = useState<string>("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [saveError, setSaveError] = useState("");
  const [perfDms, setPerfDms] = useState("0");
  const [perfLeads, setPerfLeads] = useState("0");
  const [perfSaves, setPerfSaves] = useState("0");
  const [perfShares, setPerfShares] = useState("0");
  const [perfProfileVisits, setPerfProfileVisits] = useState("0");
  const [perfViews, setPerfViews] = useState("0");
  const [perfNote, setPerfNote] = useState("");
  const [perfStatus, setPerfStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [perfError, setPerfError] = useState("");
  const [error, setError] = useState("");

  const selectedVariant = useMemo(() => {
    return contentResult?.selectedVariant ?? null;
  }, [contentResult]);

  useEffect(() => {
    const renderRaw = localStorage.getItem("content_render_output");
    const resultRaw = localStorage.getItem("content_result");

    if (!renderRaw) {
      router.replace("/content/render");
      return;
    }

    try {
      const parsedRender = JSON.parse(renderRaw) as RenderOutput;

      if (!parsedRender?.url) {
        router.replace("/content/render");
        return;
      }

      setRenderOutput(parsedRender);

      try {
        const flowRaw = localStorage.getItem("content_flow");
        if (flowRaw) {
          const parsedFlow = JSON.parse(flowRaw) as {
            selectedPlatform?: "instagram" | "tiktok" | "facebook";
          };
          const p = parsedFlow?.selectedPlatform;
          const resolved: SocialPlatform =
            p === "instagram" || p === "tiktok" || p === "facebook" ? p : "other";
          setDefaultPlatform(resolved);
          setPlatform(resolved);
        }
      } catch {
        // ignore flow parse issues; platform remains "other"
      }

      if (resultRaw) {
        const parsedResult = JSON.parse(resultRaw) as ContentResult;
        setContentResult(parsedResult);
      }
    } catch (err) {
      console.error(err);
      setError("לא הצלחנו לטעון את התוצאה");
    }
  }, [router]);

  async function handleSavePostLink() {
    if (saveStatus === "saving") return;

    setSaveError("");

    const renderId = renderOutput?.renderId?.trim() || "";
    const renderedVideoUrl = renderOutput?.url?.trim() || "";
    const selectedVariantId = selectedVariant?.id?.trim() || "";
    const cleanPostUrl = postUrl.trim();

    if (!renderId || !renderedVideoUrl || !selectedVariantId) {
      setSaveError("חסרים נתונים לשמירת הקישור (Render/Variant)");
      return;
    }

    if (!cleanPostUrl) {
      setSaveError("צריך להדביק קישור לפוסט");
      return;
    }

    if (!isValidHttpUrl(cleanPostUrl)) {
      setSaveError("קישור לא תקין — הדבק קישור שמתחיל ב־http/https");
      return;
    }

    const token = localStorage.getItem("token") || "";
    if (!token) {
      setSaveError("צריך להתחבר כדי לשמור קישור לפוסט");
      return;
    }

    try {
      setSaveStatus("saving");

      const res = await fetch("/api/content/social-post-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          contentArtifact: {
            selectedVariantId,
            structure: Array.isArray(selectedVariant?.structure)
              ? selectedVariant?.structure
              : undefined,
            videoType: selectedVariant?.videoType,
            durationSeconds: selectedVariant?.durationSeconds,
            pace:
              selectedVariant?.pace === "fast" ||
              selectedVariant?.pace === "medium" ||
              selectedVariant?.pace === "slow"
                ? selectedVariant.pace
                : undefined,
            script: {
              hook: clipText(selectedVariant?.script?.hook || "", 220),
              caption: clipText(selectedVariant?.script?.caption || "", 500),
              scriptText: clipText(selectedVariant?.script?.scriptText || "", 3500),
              shots: Array.isArray(selectedVariant?.script?.shots)
                ? selectedVariant!.script!.shots!.slice(0, 18).map((s) => ({
                    voice: clipText(String(s?.voice ?? ""), 360),
                    visual: clipText(String(s?.visual ?? ""), 360),
                  }))
                : undefined,
            },
          },
          executionArtifact: {
            renderId,
            renderedVideoUrl,
            snapshotUrl: renderOutput?.snapshotUrl || undefined,
          },
          publishedArtifact: {
            platform,
            postUrl: cleanPostUrl,
          },
        }),
      });

      if (!res.ok) {
        let msg = "שמירת הקישור נכשלה";
        try {
          const data = await res.json();
          if (typeof data?.error === "string" && data.error) {
            msg = data.error;
          }
        } catch {
          // ignore
        }
        throw new Error(msg);
      }

      setSaveStatus("saved");
      setSavedPostUrl(cleanPostUrl);
    } catch (err: any) {
      setSaveStatus("idle");
      setSaveError(err?.message || "שמירת הקישור נכשלה");
    }
  }

  async function handleSavePerformance() {
    if (perfStatus === "saving") return;

    setPerfError("");

    const renderId = renderOutput?.renderId?.trim() || "";
    const selectedVariantId = selectedVariant?.id?.trim() || "";

    const effectivePostUrl = (savedPostUrl || postUrl).trim();

    if (!renderId || !selectedVariantId) {
      setPerfError("חסרים נתונים לשמירת ביצועים (Render/Variant)");
      return;
    }

    if (!effectivePostUrl) {
      setPerfError("צריך להדביק קישור לפוסט לפני שמזינים ביצועים");
      return;
    }

    if (!isValidHttpUrl(effectivePostUrl)) {
      setPerfError("קישור לא תקין — הדבק קישור שמתחיל ב־http/https");
      return;
    }

    const dms = parseNonNegativeInt(perfDms);
    const leads = parseNonNegativeInt(perfLeads);
    const saves = parseNonNegativeInt(perfSaves);
    const shares = parseNonNegativeInt(perfShares);
    const profileVisits = parseNonNegativeInt(perfProfileVisits);
    const views = parseNonNegativeInt(perfViews);

    if (
      dms === null ||
      leads === null ||
      saves === null ||
      shares === null ||
      profileVisits === null ||
      views === null
    ) {
      setPerfError("כל המדדים חייבים להיות מספרים שלמים (0 ומעלה)");
      return;
    }

    const token = localStorage.getItem("token") || "";
    if (!token) {
      setPerfError("צריך להתחבר כדי לשמור ביצועים");
      return;
    }

    try {
      setPerfStatus("saving");

      const res = await fetch("/api/content/social-post-performance", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          renderId,
          selectedVariantId,
          platform,
          postUrl: effectivePostUrl,
          metrics: {
            dms,
            leads,
            saves,
            shares,
            profileVisits,
            views,
          },
          note: perfNote.trim() || undefined,
        }),
      });

      if (!res.ok) {
        let msg = "שמירת הביצועים נכשלה";
        try {
          const data = await res.json();
          if (typeof data?.error === "string" && data.error) {
            msg = data.error;
          }
        } catch {
          // ignore
        }
        throw new Error(msg);
      }

      setPerfStatus("saved");
    } catch (err: any) {
      setPerfStatus("idle");
      setPerfError(err?.message || "שמירת הביצועים נכשלה");
    }
  }

  function handleBackHome() {
    router.push("/");
  }

  function handleCreateAgain() {
    router.push("/content");
  }

  function handleBackToRender() {
    router.push("/content/render");
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <button
            type="button"
            onClick={handleBackToRender}
            style={backButtonStyle}
          >
            חזרה
          </button>

          <div style={topBarTitleStyle}>התוצאה שלך</div>

          <div style={topBarSpacerStyle} />
        </div>

        <Header title="התוצאה שלך" />
        <ProgressBar progress={100} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>שלב 9</div>
            <h1 style={titleStyle}>הווידאו שלך מוכן</h1>
            <p style={subtitleStyle}>
              זה התוכן שהמערכת יצרה עבורך לפי הכיוון, המבנה והחומרים שנבחרו.
            </p>
          </div>

          {error ? (
            <div style={errorBoxStyle}>
              <div style={errorTitleStyle}>לא ניתן להציג את התוצאה</div>
              <div style={errorTextStyle}>{error}</div>
            </div>
          ) : null}

          {renderOutput?.url ? (
            <div style={videoCardStyle}>
              <div style={videoWrapStyle}>
                <video
                  controls
                  playsInline
                  style={videoStyle}
                  src={renderOutput.url}
                  poster={renderOutput.snapshotUrl || undefined}
                />
              </div>

              <div style={videoMetaStyle}>
                <div style={videoMetaTitleStyle}>הווידאו מוכן לצפייה</div>
                <div style={videoMetaTextStyle}>
                  אפשר לצפות, לבדוק את הזרימה, ואז להחליט אם להמשיך לשיפור או
                  ליצור תוכן חדש.
                </div>
              </div>
            </div>
          ) : null}

          {renderOutput?.url && selectedVariant?.id ? (
            <div style={socialTraceCardStyle}>
              <div style={socialTraceTitleStyle}>פרסמת את הסרטון?</div>
              <div style={socialTraceSubtitleStyle}>
                הדבק כאן קישור לפוסט כדי שנשמור קשר בין הרנדר לפרסום הידני.
              </div>

              <div style={socialTraceRowStyle}>
                <div style={socialTraceFieldStyle}>
                  <div style={socialTraceLabelStyle}>פלטפורמה</div>
                  <select
                    value={platform}
                    onChange={(e) => {
                      setPlatform((e.target.value as SocialPlatform) || "other");
                      if (saveStatus === "saved") setSaveStatus("idle");
                      if (saveError) setSaveError("");
                    }}
                    style={socialTraceSelectStyle}
                  >
                    <option value="instagram">Instagram</option>
                    <option value="tiktok">TikTok</option>
                    <option value="facebook">Facebook</option>
                    <option value="other">אחר</option>
                  </select>
                </div>

                <div style={socialTraceFieldStyle}>
                  <div style={socialTraceLabelStyle}>קישור לפוסט</div>
                  <input
                    type="url"
                    placeholder="https://..."
                    value={postUrl}
                    onChange={(e) => {
                      setPostUrl(e.target.value);
                      setSavedPostUrl("");
                      if (saveStatus === "saved") setSaveStatus("idle");
                      if (saveError) setSaveError("");
                      if (perfStatus === "saved") setPerfStatus("idle");
                      if (perfError) setPerfError("");
                    }}
                    style={socialTraceInputStyle}
                  />
                </div>
              </div>

              {saveError ? (
                <div style={socialTraceErrorStyle}>{saveError}</div>
              ) : null}

              {saveStatus === "saved" ? (
                <div style={socialTraceSuccessStyle}>הקישור נשמר</div>
              ) : null}

              <div style={socialTraceActionsStyle}>
                <button
                  type="button"
                  onClick={handleSavePostLink}
                  disabled={saveStatus === "saving"}
                  style={socialTraceButtonStyle(saveStatus === "saving")}
                >
                  {saveStatus === "saving" ? "שומר..." : "שמור קישור לפוסט"}
                </button>

                {defaultPlatform !== "other" ? (
                  <div style={socialTraceHintStyle}>
                    פלטפורמה ברירת מחדל: {defaultPlatform}
                  </div>
                ) : null}
              </div>

              <div style={perfDividerStyle} />

              <div style={perfTitleStyle}>הזן ביצועים ידנית</div>
              <div style={perfSubtitleStyle}>
                אפשר להזין ביצועים ידנית כדי שנוכל לעקוב אחרי התוכן בהמשך.
              </div>

              <div style={perfGridStyle}>
                <PerfField
                  label="DMs / שיחות נכנסות"
                  value={perfDms}
                  onChange={(v) => {
                    setPerfDms(v);
                    if (perfStatus === "saved") setPerfStatus("idle");
                    if (perfError) setPerfError("");
                  }}
                />
                <PerfField
                  label="Leads / פניות"
                  value={perfLeads}
                  onChange={(v) => {
                    setPerfLeads(v);
                    if (perfStatus === "saved") setPerfStatus("idle");
                    if (perfError) setPerfError("");
                  }}
                />
                <PerfField
                  label="Saves"
                  value={perfSaves}
                  onChange={(v) => {
                    setPerfSaves(v);
                    if (perfStatus === "saved") setPerfStatus("idle");
                    if (perfError) setPerfError("");
                  }}
                />
                <PerfField
                  label="Shares"
                  value={perfShares}
                  onChange={(v) => {
                    setPerfShares(v);
                    if (perfStatus === "saved") setPerfStatus("idle");
                    if (perfError) setPerfError("");
                  }}
                />
                <PerfField
                  label="Profile visits"
                  value={perfProfileVisits}
                  onChange={(v) => {
                    setPerfProfileVisits(v);
                    if (perfStatus === "saved") setPerfStatus("idle");
                    if (perfError) setPerfError("");
                  }}
                />
                <PerfField
                  label="Views"
                  value={perfViews}
                  onChange={(v) => {
                    setPerfViews(v);
                    if (perfStatus === "saved") setPerfStatus("idle");
                    if (perfError) setPerfError("");
                  }}
                />
              </div>

              <div style={perfNoteWrapStyle}>
                <div style={socialTraceLabelStyle}>הערה (אופציונלי)</div>
                <textarea
                  value={perfNote}
                  onChange={(e) => {
                    setPerfNote(e.target.value);
                    if (perfStatus === "saved") setPerfStatus("idle");
                    if (perfError) setPerfError("");
                  }}
                  placeholder="מה קרה בפועל? למה זה עבד/לא עבד?"
                  style={perfNoteStyle}
                />
              </div>

              {perfError ? <div style={socialTraceErrorStyle}>{perfError}</div> : null}
              {perfStatus === "saved" ? (
                <div style={socialTraceSuccessStyle}>הביצועים נשמרו</div>
              ) : null}

              <div style={socialTraceActionsStyle}>
                <button
                  type="button"
                  onClick={handleSavePerformance}
                  disabled={perfStatus === "saving"}
                  style={socialTraceButtonStyle(perfStatus === "saving")}
                >
                  {perfStatus === "saving" ? "שומר..." : "שמור ביצועים"}
                </button>
              </div>
            </div>
          ) : null}

          {selectedVariant ? (
            <div style={detailsCardStyle}>
              <div style={detailsTitleStyle}>מה נבחר עבורך</div>

              <div style={summaryGridStyle}>
                <div style={summaryCardStyle}>
                  <div style={summaryLabelStyle}>שם הגרסה</div>
                  <div style={summaryValueStyle}>
                    {selectedVariant.title || "ללא שם"}
                  </div>
                </div>

                <div style={summaryCardStyle}>
                  <div style={summaryLabelStyle}>סוג הסרטון</div>
                  <div style={summaryValueStyle}>
                    {getVideoTypeLabel(selectedVariant.videoType)}
                  </div>
                </div>

                <div style={summaryCardStyle}>
                  <div style={summaryLabelStyle}>אורך</div>
                  <div style={summaryValueStyle}>
                    {selectedVariant.durationSeconds
                      ? `${selectedVariant.durationSeconds} שניות`
                      : "לא ידוע"}
                  </div>
                </div>

                <div style={summaryCardStyle}>
                  <div style={summaryLabelStyle}>ציון</div>
                  <div style={summaryValueStyle}>
                    {typeof selectedVariant.score === "number"
                      ? selectedVariant.score
                      : "—"}
                  </div>
                </div>
              </div>

              {selectedVariant.whyItFits ? (
                <div style={sectionStyle}>
                  <div style={sectionTitleStyle}>למה זה מתאים</div>
                  <div style={infoBoxStyle}>{selectedVariant.whyItFits}</div>
                </div>
              ) : null}

              {selectedVariant.structure?.length ? (
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
              ) : null}

              {selectedVariant.script?.hook ? (
                <div style={sectionStyle}>
                  <div style={sectionTitleStyle}>Hook</div>
                  <div style={hookBoxStyle}>{selectedVariant.script.hook}</div>
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
            </div>
          ) : null}
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            onClick={handleCreateAgain}
            style={secondaryButtonStyle}
          >
            יצירת תוכן חדש
          </button>

          <button
            type="button"
            onClick={handleBackHome}
            style={primaryButtonStyle}
          >
            חזרה לבית
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
  maxWidth: 700,
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

const videoCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 18,
  padding: 16,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
  marginBottom: 18,
};

const videoWrapStyle: React.CSSProperties = {
  width: "100%",
  borderRadius: 18,
  overflow: "hidden",
  background: "#000000",
  marginBottom: 14,
};

const videoStyle: React.CSSProperties = {
  width: "100%",
  display: "block",
  maxHeight: 720,
  background: "#000000",
};

const videoMetaStyle: React.CSSProperties = {
  display: "grid",
  gap: 6,
};

const videoMetaTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: "#111827",
};

const videoMetaTextStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.8,
  color: "#6b7280",
};

const socialTraceCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 18,
  padding: 16,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
  marginBottom: 18,
};

const socialTraceTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 6,
};

const socialTraceSubtitleStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.8,
  color: "#6b7280",
  marginBottom: 14,
};

const socialTraceRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "240px 1fr",
  gap: 12,
  alignItems: "end",
  marginBottom: 12,
};

const socialTraceFieldStyle: React.CSSProperties = {
  display: "grid",
  gap: 6,
};

const socialTraceLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: "#374151",
};

const socialTraceSelectStyle: React.CSSProperties = {
  height: 42,
  borderRadius: 12,
  border: "1px solid #e5e7eb",
  padding: "0 12px",
  background: "#ffffff",
  fontSize: 14,
  fontWeight: 700,
  color: "#111827",
};

const socialTraceInputStyle: React.CSSProperties = {
  height: 42,
  borderRadius: 12,
  border: "1px solid #e5e7eb",
  padding: "0 12px",
  background: "#ffffff",
  fontSize: 14,
  color: "#111827",
};

const socialTraceActionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  marginTop: 6,
};

const socialTraceButtonStyle = (disabled: boolean): React.CSSProperties => ({
  height: 42,
  borderRadius: 12,
  border: "none",
  padding: "0 14px",
  background: disabled ? "#d1d5db" : "#111827",
  color: "#ffffff",
  fontSize: 14,
  fontWeight: 800,
  cursor: disabled ? "not-allowed" : "pointer",
});

const socialTraceHintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#6b7280",
  fontWeight: 700,
};

const socialTraceErrorStyle: React.CSSProperties = {
  background: "#fff7ed",
  border: "1px solid #fed7aa",
  color: "#9a3412",
  borderRadius: 12,
  padding: 10,
  fontSize: 13,
  lineHeight: 1.7,
  marginBottom: 10,
};

const socialTraceSuccessStyle: React.CSSProperties = {
  background: "#ecfdf5",
  border: "1px solid #a7f3d0",
  color: "#065f46",
  borderRadius: 12,
  padding: 10,
  fontSize: 13,
  fontWeight: 800,
  marginBottom: 10,
};

function PerfField(props: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div style={socialTraceFieldStyle}>
      <div style={socialTraceLabelStyle}>{props.label}</div>
      <input
        inputMode="numeric"
        pattern="[0-9]*"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder="0"
        style={socialTraceInputStyle}
      />
    </div>
  );
}

const perfDividerStyle: React.CSSProperties = {
  height: 1,
  background: "#e5e7eb",
  margin: "16px 0 14px 0",
};

const perfTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 6,
};

const perfSubtitleStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: "#6b7280",
  marginBottom: 12,
};

const perfGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 12,
  marginBottom: 12,
};

const perfNoteWrapStyle: React.CSSProperties = {
  display: "grid",
  gap: 6,
  marginBottom: 10,
};

const perfNoteStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 84,
  borderRadius: 12,
  border: "1px solid #e5e7eb",
  padding: "10px 12px",
  background: "#ffffff",
  fontSize: 14,
  color: "#111827",
  resize: "vertical",
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

const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 12,
  marginBottom: 18,
};

const summaryCardStyle: React.CSSProperties = {
  background: "#f9fafb",
  borderRadius: 16,
  padding: 14,
  border: "1px solid #e5e7eb",
};

const summaryLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#6b7280",
  marginBottom: 4,
};

const summaryValueStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "#111827",
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

const infoBoxStyle: React.CSSProperties = {
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
  borderRadius: 14,
  padding: 14,
  fontSize: 14,
  lineHeight: 1.8,
  color: "#374151",
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

const captionBoxStyle: React.CSSProperties = {
  background: "#f3f4f6",
  border: "1px solid #e5e7eb",
  color: "#374151",
  borderRadius: 14,
  padding: 14,
  fontSize: 14,
  lineHeight: 1.8,
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
  justifyContent: "space-between",
  gap: 12,
};

const primaryButtonStyle: React.CSSProperties = {
  minWidth: 132,
  height: 48,
  borderRadius: 14,
  border: "none",
  background: "#111827",
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 800,
  cursor: "pointer",
  boxShadow: "0 10px 24px rgba(17,24,39,0.18)",
};

const secondaryButtonStyle: React.CSSProperties = {
  minWidth: 150,
  height: 48,
  borderRadius: 14,
  border: "1px solid #e5e7eb",
  background: "#ffffff",
  color: "#111827",
  fontSize: 15,
  fontWeight: 800,
  cursor: "pointer",
  boxShadow: "0 2px 10px rgba(0,0,0,0.04)",
};