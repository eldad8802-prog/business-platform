"use client";

import { useEffect, useMemo, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { useRouter } from "next/navigation";
import ProgressBar from "@/components/ProgressBar";
import BackButton from "@/components/ui/back-button";
import { baseStyles } from "@/lib/styles/baseStyles";

type Shot = {
  visual: string;
  voice: string;
};

type UploadedAssetMap = Record<string, string>;

type SelectedVariant = {
  script?: {
    shots?: Shot[];
  };
};

type ContentResult = {
  selectedVariant?: SelectedVariant;
};

export default function AssetsUploadPage() {
  const router = useRouter();

  const [shots, setShots] = useState<Shot[]>([]);
  const [files, setFiles] = useState<UploadedAssetMap>({});
  const [fileTypes, setFileTypes] = useState<Record<string, boolean>>({});
  const [uploadingIndex, setUploadingIndex] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const rawResult = localStorage.getItem("content_result");
    const rawAssets = localStorage.getItem("content_assets");

    if (!rawResult) {
      router.replace("/content");
      return;
    }

    try {
      const parsed: ContentResult = JSON.parse(rawResult);
      const selected = parsed.selectedVariant;

      if (!selected?.script?.shots || selected.script.shots.length === 0) {
        router.replace("/content/creator-plan");
        return;
      }

      setShots(selected.script.shots);

      if (rawAssets) {
        const parsedAssets: UploadedAssetMap = JSON.parse(rawAssets);
        setFiles(parsedAssets);
        const restoredTypes: Record<string, boolean> = {};
        for (const key of Object.keys(parsedAssets)) {
          const url = parsedAssets[key] ?? "";
          restoredTypes[key] = /\.(mp4|mov|webm|avi|mkv)(\?|$)/i.test(url);
        }
        setFileTypes(restoredTypes);
      }
    } catch (err) {
      console.error(err);
      router.replace("/content");
    }
  }, [router]);

  const uploadedCount = useMemo(() => {
    return Object.keys(files).filter((key) => Boolean(files[key])).length;
  }, [files]);

  const canContinue = useMemo(() => {
    return uploadedCount > 0;
  }, [uploadedCount]);

  async function handleFileChange(index: number, file: File | null) {
    if (!file) return;

    setError("");
    setUploadingIndex(index);

    try {
      const token = localStorage.getItem("token");
      if (!token) {
        throw new Error("כדי להעלות חומר צריך להתחבר מחדש");
      }

      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/content/upload", {
        method: "POST",
        body: formData,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await res.json();

      if (!res.ok || !data?.url) {
        throw new Error("לא הצלחנו לשמור את הקובץ — נסו שוב");
      }

      const isVideo = file.type.startsWith("video/");
      setFileTypes((prev) => ({ ...prev, [index]: isVideo }));

      setFiles((prev) => {
        const updated = {
          ...prev,
          [index]: data.url as string,
        };

        localStorage.setItem("content_assets", JSON.stringify(updated));
        return updated;
      });
    } catch (err: any) {
      console.error(err);
      setError(err?.message || "לא הצלחנו לשמור את הקובץ");
    } finally {
      setUploadingIndex(null);
    }
  }

  function handleContinue() {
    if (!canContinue) {
      setError("בחרו לפחות רגע אחד עם חומר — ואפשר להמשיך");
      return;
    }

    localStorage.setItem("content_assets", JSON.stringify(files));
    router.push("/content/render");
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <BackButton href="/content/shot-direction" />

          <div style={topBarTitleStyle}>מחברים את מה שצילמתם</div>

          <div style={topBarSpacerStyle} />
        </div>

        <ProgressBar progress={90} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>עכשיו</div>
            <h1 style={titleStyle}>צלמו לפי הרגעים האלה</h1>
            <p style={subtitleStyle}>
              בוחרים מהגלריה לכל רגע — אנחנו נדאג לשאר.
            </p>
          </div>

          <div style={summaryCardStyle}>
            <div style={summaryTitleStyle}>איפה אתם נמצאים</div>
            <div style={summaryTextStyle}>
              יש חומר ל־{uploadedCount} מתוך {shots.length} רגעים
            </div>
          </div>

          <div style={shotsWrapStyle}>
            {shots.map((shot, index) => {
              const uploadedUrl = files[index];
              const isUploading = uploadingIndex === index;

              return (
                <div key={index} style={shotCardStyle}>
                  <div style={shotHeaderRowStyle}>
                    <div style={sectionTitleStyle}>רגע {index + 1}</div>

                    {uploadedUrl ? (
                      <div style={uploadedBadgeStyle}>יש כאן חומר</div>
                    ) : (
                      <div style={pendingBadgeStyle}>מחכים לצילום</div>
                    )}
                  </div>

                  <div style={fieldGroupStyle}>
                    <div style={fieldLabelStyle}>מה כדאי שייראה כאן</div>
                    <div style={fieldTextStyle}>{shot.visual}</div>
                  </div>

                  <div style={fieldGroupStyle}>
                    <div style={fieldLabelStyle}>מה לומר ברגע הזה</div>
                    <div style={fieldTextStyle}>{shot.voice}</div>
                  </div>

                  <div style={uploadAreaStyle}>
                    <label style={uploadBoxStyle}>
                      <div style={uploadBoxTitleStyle}>בוחרים תמונה או סרטון מהמכשיר</div>
                      <div style={uploadBoxTextStyle}>
                        לא חייב מושלם — העיקר שירגיש אמיתי ומתאים לרגע.
                      </div>

                      <input
                        type="file"
                        accept="image/*,video/*"
                        style={hiddenInputStyle}
                        onChange={(e) =>
                          handleFileChange(index, e.target.files?.[0] || null)
                        }
                      />
                    </label>

                    {isUploading ? (
                      <div style={uploadingTextStyle}>רגע אחד…</div>
                    ) : null}

                    {uploadedUrl ? (
                      <>
                        <div style={uploadedTextStyle}>
                          החומר נשמר — אפשר לעבור לרגע הבא
                        </div>
                        {fileTypes[index] ? (
                          <video
                            src={uploadedUrl}
                            style={previewMediaStyle}
                            preload="metadata"
                            muted
                            playsInline
                            controls
                          />
                        ) : (
                          <img
                            src={uploadedUrl}
                            alt={`רגע ${index + 1}`}
                            style={previewMediaStyle}
                          />
                        )}
                      </>
                    ) : (
                      <div style={helperTextStyle}>
                        עדיין אין כאן חומר — לחצו למעלה כדי לבחור מהגלריה
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {error ? (
            <div style={errorBoxStyle}>
              <div style={errorTitleStyle}>רגע, משהו נתקע</div>
              <div style={errorTextStyle}>{error}</div>
            </div>
          ) : null}
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            style={nextButtonStyle(canContinue)}
            onClick={handleContinue}
            disabled={!canContinue}
          >
            המשך — מרכיבים את הסרטון
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
  maxWidth: 640,
};

const summaryCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 18,
  padding: 16,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
  marginBottom: 14,
};

const summaryTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 4,
};

const summaryTextStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#6b7280",
  lineHeight: 1.6,
};

const shotsWrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const shotCardStyle: React.CSSProperties = {
  background: "#ffffff",
  padding: 16,
  borderRadius: 18,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
};

const shotHeaderRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 12,
};

const sectionTitleStyle: React.CSSProperties = {
  fontWeight: 800,
  fontSize: 16,
  color: "#111827",
};

const uploadedBadgeStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: "#065f46",
  background: "#ecfdf5",
  border: "1px solid #a7f3d0",
  borderRadius: 999,
  padding: "4px 8px",
  flexShrink: 0,
};

const pendingBadgeStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: "#92400e",
  background: "#fffbeb",
  border: "1px solid #fde68a",
  borderRadius: 999,
  padding: "4px 8px",
  flexShrink: 0,
};

const fieldGroupStyle: React.CSSProperties = {
  marginBottom: 10,
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 4,
};

const fieldTextStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  color: "#4b5563",
};

const uploadAreaStyle: React.CSSProperties = {
  marginTop: 12,
  background: "#f9fafb",
  border: "1px solid #eef2f7",
  borderRadius: 14,
  padding: 12,
};

const uploadBoxStyle: React.CSSProperties = {
  display: "block",
  border: "2px dashed #d1d5db",
  borderRadius: 14,
  padding: 18,
  textAlign: "center",
  cursor: "pointer",
  background: "#ffffff",
};

const uploadBoxTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 6,
};

const uploadBoxTextStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.6,
  color: "#6b7280",
};

const hiddenInputStyle: React.CSSProperties = {
  display: "none",
};

const uploadingTextStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 13,
  color: "#1d4ed8",
  lineHeight: 1.6,
};

const uploadedTextStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 13,
  color: "#065f46",
  lineHeight: 1.6,
};

const helperTextStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 13,
  color: "#6b7280",
  lineHeight: 1.6,
};

const previewMediaStyle: React.CSSProperties = {
  display: "block",
  marginTop: 10,
  width: "100%",
  maxHeight: 200,
  borderRadius: 10,
  objectFit: "cover",
  border: "1px solid #e5e7eb",
};

const errorBoxStyle: React.CSSProperties = {
  background: "#fee2e2",
  border: "1px solid #fecaca",
  color: "#991b1b",
  borderRadius: 14,
  padding: 12,
  fontSize: 13,
  lineHeight: 1.6,
  marginTop: 6,
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
  minWidth: 132,
  height: 48,
  borderRadius: 14,
  border: "none",
  background: enabled ? TOKEN.action.primary.background : "#9ca3af",
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 800,
  cursor: enabled ? "pointer" : "not-allowed",
  boxShadow: enabled ? TOKEN.action.primary.shadow : "none",
});
