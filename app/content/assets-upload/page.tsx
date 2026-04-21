"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
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
        router.replace("/content/result");
        return;
      }

      setShots(selected.script.shots);

      if (rawAssets) {
        const parsedAssets: UploadedAssetMap = JSON.parse(rawAssets);
        setFiles(parsedAssets);
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

  function handleBack() {
    router.back();
  }

  async function handleFileChange(index: number, file: File | null) {
    if (!file) return;

    console.log("FILE SELECTED:", file);

    setError("");
    setUploadingIndex(index);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/content/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok || !data?.url) {
        throw new Error("שגיאה בהעלאת הקובץ");
      }

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
      setError(err?.message || "העלאת הקובץ נכשלה");
    } finally {
      setUploadingIndex(null);
    }
  }

  function handleContinue() {
    if (!canContinue) {
      setError("צריך להעלות לפחות קובץ אחד");
      return;
    }

    localStorage.setItem("content_assets", JSON.stringify(files));
    router.push("/content/render");
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <button type="button" onClick={handleBack} style={backButtonStyle}>
            חזרה
          </button>

          <div style={topBarTitleStyle}>העלאת חומרים</div>

          <div style={topBarSpacerStyle} />
        </div>

        <Header title="העלאת חומרים" />
        <ProgressBar progress={90} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>שלב 7</div>
            <h1 style={titleStyle}>העלה חומרים לכל שוט</h1>
            <p style={subtitleStyle}>
              המערכת כבר בנתה עבורך שוטים ברורים. עכשיו העלה לכל שוט תמונה או
              סרטון מתאימים, כדי שנוכל לעבור לשלב ההפקה והרנדר.
            </p>
          </div>

          <div style={summaryCardStyle}>
            <div style={summaryTitleStyle}>התקדמות ההעלאה</div>
            <div style={summaryTextStyle}>
              הועלו {uploadedCount} מתוך {shots.length} שוטים
            </div>
          </div>

          <div style={shotsWrapStyle}>
            {shots.map((shot, index) => {
              const uploadedUrl = files[index];
              const isUploading = uploadingIndex === index;

              return (
                <div key={index} style={shotCardStyle}>
                  <div style={shotHeaderRowStyle}>
                    <div style={sectionTitleStyle}>שוט {index + 1}</div>

                    {uploadedUrl ? (
                      <div style={uploadedBadgeStyle}>הועלה</div>
                    ) : (
                      <div style={pendingBadgeStyle}>ממתין</div>
                    )}
                  </div>

                  <div style={fieldGroupStyle}>
                    <div style={fieldLabelStyle}>מה צריך לצלם</div>
                    <div style={fieldTextStyle}>{shot.visual}</div>
                  </div>

                  <div style={fieldGroupStyle}>
                    <div style={fieldLabelStyle}>מה להגיד בשוט</div>
                    <div style={fieldTextStyle}>{shot.voice}</div>
                  </div>

                  <div style={uploadAreaStyle}>
                    <label style={uploadBoxStyle}>
                      <div style={uploadBoxTitleStyle}>לחץ להעלאת קובץ</div>
                      <div style={uploadBoxTextStyle}>
                        אפשר להעלות תמונה או סרטון, בהתאם למה שמתאים לשוט הזה
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
                      <div style={uploadingTextStyle}>מעלה קובץ...</div>
                    ) : null}

                    {uploadedUrl ? (
                      <div style={uploadedTextStyle}>
                        ✔ הקובץ נשמר בהצלחה ומוכן לשלב הבא
                      </div>
                    ) : (
                      <div style={helperTextStyle}>
                        עדיין לא הועלה קובץ לשוט הזה
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {error ? (
            <div style={errorBoxStyle}>
              <div style={errorTitleStyle}>יש בעיה שצריך לטפל בה</div>
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
            הבא
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
  background: enabled ? "#111827" : "#9ca3af",
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 800,
  cursor: enabled ? "pointer" : "not-allowed",
  boxShadow: enabled ? "0 10px 24px rgba(17,24,39,0.18)" : "none",
});