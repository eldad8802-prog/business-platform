"use client";

import { useEffect, useMemo, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
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

function platformDisplayName(platform: SocialPlatform): string {
  switch (platform) {
    case "instagram":
      return "אינסטגרם";
    case "tiktok":
      return "טיקטוק";
    case "facebook":
      return "פייסבוק";
    default:
      return "אחר";
  }
}

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

function isTerminalRenderSuccess(status: unknown, url: unknown): boolean {
  const s = typeof status === "string" ? status.toLowerCase() : "";
  if (s !== "succeeded" && s !== "completed") return false;
  return typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

export default function ResultPage() {
  const router = useRouter();

  const [renderOutput, setRenderOutput] = useState<RenderOutput | null>(null);
  const [videoReady, setVideoReady] = useState(false);
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
    let cancelled = false;
    const resultRaw = localStorage.getItem("content_result");
    const token = localStorage.getItem("token") || "";

    function loadFlowAndResult() {
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
        try {
          const parsedResult = JSON.parse(resultRaw) as ContentResult;
          setContentResult(parsedResult);
        } catch {
          // ignore
        }
      }
    }

    async function resolveVideo() {
      setVideoReady(false);
      setError("");
      loadFlowAndResult();

      const renderRaw = localStorage.getItem("content_render_output");
      const jobRaw = localStorage.getItem("content_render_job");

      let renderId: string | undefined;
      let snapshot: RenderOutput | null = null;

      try {
        if (renderRaw) {
          snapshot = JSON.parse(renderRaw) as RenderOutput;
          renderId = snapshot.renderId?.trim() || undefined;
        }
        if (!renderId && jobRaw) {
          const job = JSON.parse(jobRaw) as { renderId?: string };
          renderId = job.renderId?.trim();
        }
      } catch (err) {
        console.error(err);
        setError("לא הצלחנו להציג את הסרטון");
        return;
      }

      if (!renderId) {
        router.replace("/content/render");
        return;
      }

      const persist = (out: RenderOutput) => {
        localStorage.setItem("content_render_output", JSON.stringify(out));
        if (!cancelled) setRenderOutput(out);
      };

      if (snapshot && isTerminalRenderSuccess(snapshot.status, snapshot.url)) {
        persist(snapshot);
        if (!cancelled) setVideoReady(true);
        return;
      }

      if (!token) {
        setError("כדי להציג את הסרטון צריך להתחבר מחדש.");
        return;
      }

      const maxAttempts = 90;

      for (let attempt = 0; attempt < maxAttempts && !cancelled; attempt++) {
        try {
          const res = await fetch(`/api/content/render/status/${renderId}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = await res.json();

          if (!res.ok) {
            throw new Error("status_failed");
          }

          if ((data.status || "").toLowerCase() === "failed") {
            setError(data.errorMessage || "לא הצלחנו לסיים את הסרטון");
            return;
          }

          if (isTerminalRenderSuccess(data.status, data.url)) {
            persist({
              renderId: data.id ?? renderId,
              status: data.status,
              url: data.url,
              snapshotUrl: data.snapshotUrl ?? null,
            });
            setVideoReady(true);
            return;
          }
        } catch (err) {
          console.error(err);
          setError("לא הצלחנו לטעון את הסרטון. אפשר לנסות לרענן.");
          return;
        }

        await new Promise((r) => setTimeout(r, 2000));
      }

      setError("הסרטון לוקח יותר מדי זמן — נסו לרענן עוד כמה רגעים.");
    }

    void resolveVideo();

    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleSavePostLink() {
    if (saveStatus === "saving") return;

    setSaveError("");

    const renderId = renderOutput?.renderId?.trim() || "";
    const renderedVideoUrl = renderOutput?.url?.trim() || "";
    const selectedVariantId = selectedVariant?.id?.trim() || "";
    const cleanPostUrl = postUrl.trim();

    if (!renderId || !renderedVideoUrl || !selectedVariantId) {
      setSaveError("חסר מידע כדי לשמור את הקישור — נסו לחזור צעד אחורה.");
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
      setPerfError("חסר מידע כדי לשמור ביצועים — נסו לחזור צעד אחורה.");
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
    router.push("/app");
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

          <div style={topBarTitleStyle}>הסרטון מוכן</div>

          <div style={topBarSpacerStyle} />
        </div>

        <Header title="הסרטון מוכן" />
        <ProgressBar progress={100} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>סיימנו</div>
            <h1 style={titleStyle}>הסרטון מוכן</h1>
            <p style={subtitleStyle}>
              צפו, בדקו שזה מרגיש נכון — ואחר כך אפשר לשתף ולפרסם.
            </p>
          </div>

          {error ? (
            <div style={errorBoxStyle}>
              <div style={errorTitleStyle}>לא הצלחנו להציג</div>
              <div style={errorTextStyle}>{error}</div>
            </div>
          ) : null}

          {!error && !videoReady ? (
            <div style={videoCardStyle}>
              <div style={videoMetaTitleStyle}>טוענים את הווידאו</div>
              <div style={videoMetaTextStyle}>
                לפעמים לוקח עוד רגע עד שהקובץ זמין לצפייה — לא צריך לרענן ידנית.
              </div>
            </div>
          ) : null}

          {videoReady && renderOutput?.url ? (
            <div style={videoCardStyle}>
              <div style={videoWrapStyle}>
                <video
                  key={renderOutput.url}
                  controls
                  playsInline
                  style={videoStyle}
                  src={renderOutput.url}
                  poster={renderOutput.snapshotUrl || undefined}
                />
              </div>

              <div style={videoMetaStyle}>
                <div style={videoMetaTitleStyle}>זה הזמן לבדוק איך זה יושב</div>
                <div style={videoMetaTextStyle}>
                  האם הזרימה ברורה? האם זה מרגיש כמו אתם? אחרי שתחליטו — אפשר לפרסם ישר.
                </div>
              </div>
            </div>
          ) : null}

          {/* Publish-ready card — hook + caption for easy copy when posting */}
          {videoReady &&
          renderOutput?.url &&
          (selectedVariant?.script?.hook || selectedVariant?.script?.caption) ? (
            <div style={publishReadyCardStyle}>
              <div style={publishReadyTitleStyle}>מוכן לפרסום</div>
              <div style={publishReadySubtitleStyle}>
                אפשר להעתיק מכאן ישר לפוסט.
              </div>

              {selectedVariant?.script?.hook ? (
                <div style={publishReadySectionStyle}>
                  <div style={publishReadyLabelStyle}>הפתיחה שנבחרה</div>
                  <div style={hookBoxStyle}>{selectedVariant.script.hook}</div>
                </div>
              ) : null}

              {selectedVariant?.script?.caption ? (
                <div style={publishReadySectionStyle}>
                  <div style={publishReadyLabelStyle}>טקסט לפוסט</div>
                  <div style={captionBoxStyle}>{selectedVariant.script.caption}</div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Social trace — publish link only */}
          {videoReady && renderOutput?.url && selectedVariant?.id ? (
            <div style={socialTraceCardStyle}>
              <div style={socialTraceTitleStyle}>כבר על האוויר?</div>
              <div style={socialTraceSubtitleStyle}>
                אם פרסמתם, הדביקו כאן קישור לפוסט — ככה נשמור קו בין הסרטון
                שיצא כאן לבין מה שעלה בפועל ברשת.
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
                  {saveStatus === "saving" ? "רגע אחד…" : "שמירת הקישור"}
                </button>

                {defaultPlatform !== "other" ? (
                  <div style={socialTraceHintStyle}>
                    פלטפורמה שסימנתם בזרימה: {platformDisplayName(defaultPlatform)}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Performance card — separate, clearly optional, below fold */}
          {videoReady && renderOutput?.url && selectedVariant?.id ? (
            <div style={perfCardStyle}>
              <div style={perfCardHeaderStyle}>
                <div style={perfTitleStyle}>מספרים מהפוסט</div>
                <div style={perfOptionalTagStyle}>אופציונלי — לאחרי שפרסמתם</div>
              </div>
              <div style={perfSubtitleStyle}>
                אם תרצו, אפשר למלא מספרים ידנית — זה עוזר לנו לזכור מה עבד בהמשך.
              </div>

              <div style={perfGridStyle}>
                <PerfField
                  label="הודעות פרטיות"
                  value={perfDms}
                  onChange={(v) => {
                    setPerfDms(v);
                    if (perfStatus === "saved") setPerfStatus("idle");
                    if (perfError) setPerfError("");
                  }}
                />
                <PerfField
                  label="פניות / לידים"
                  value={perfLeads}
                  onChange={(v) => {
                    setPerfLeads(v);
                    if (perfStatus === "saved") setPerfStatus("idle");
                    if (perfError) setPerfError("");
                  }}
                />
                <PerfField
                  label="שמירות"
                  value={perfSaves}
                  onChange={(v) => {
                    setPerfSaves(v);
                    if (perfStatus === "saved") setPerfStatus("idle");
                    if (perfError) setPerfError("");
                  }}
                />
                <PerfField
                  label="שיתופים"
                  value={perfShares}
                  onChange={(v) => {
                    setPerfShares(v);
                    if (perfStatus === "saved") setPerfStatus("idle");
                    if (perfError) setPerfError("");
                  }}
                />
                <PerfField
                  label="כניסות לפרופיל"
                  value={perfProfileVisits}
                  onChange={(v) => {
                    setPerfProfileVisits(v);
                    if (perfStatus === "saved") setPerfStatus("idle");
                    if (perfError) setPerfError("");
                  }}
                />
                <PerfField
                  label="צפיות"
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

              {perfError ? (
                <div style={socialTraceErrorStyle}>{perfError}</div>
              ) : null}
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
                  {perfStatus === "saving" ? "רגע אחד…" : "שמירת המספרים"}
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            onClick={handleCreateAgain}
            style={secondaryButtonStyle}
          >
            תוכן נוסף
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

// ── Styles ────────────────────────────────────────────────────────────────────

const pageStyle: React.CSSProperties = {
  ...baseStyles.page,
  background: "linear-gradient(180deg, #f8fafc 0%, #ffffff 35%, #f8fafc 100%)",
};

const shellStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 900,
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

// ── Publish-ready card ────────────────────────────────────────────────────────

const publishReadyCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 18,
  padding: 18,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
  marginBottom: 18,
};

const publishReadyTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 4,
};

const publishReadySubtitleStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#6b7280",
  lineHeight: 1.6,
  marginBottom: 16,
};

const publishReadySectionStyle: React.CSSProperties = {
  marginBottom: 14,
};

const publishReadyLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: "#374151",
  marginBottom: 6,
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

// ── Social trace card ─────────────────────────────────────────────────────────

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
  gridTemplateColumns: "1fr 1fr",
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

// ── Performance card ──────────────────────────────────────────────────────────

const perfCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 18,
  padding: 16,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
  marginBottom: 20,
};

const perfCardHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 6,
  flexWrap: "wrap",
};

const perfTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: "#111827",
};

const perfOptionalTagStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "#6b7280",
  background: "#f3f4f6",
  border: "1px solid #e5e7eb",
  borderRadius: 999,
  padding: "3px 8px",
  flexShrink: 0,
};

const perfSubtitleStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: "#6b7280",
  marginBottom: 12,
};

const perfGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
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
  boxSizing: "border-box",
};

// ── Footer ────────────────────────────────────────────────────────────────────

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
  background: TOKEN.action.primary.background,
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 800,
  cursor: "pointer",
  boxShadow: TOKEN.action.primary.shadow,
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
