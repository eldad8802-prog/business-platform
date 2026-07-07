"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import ProgressBar from "@/components/ProgressBar";
import BackButton from "@/components/ui/back-button";
import { baseStyles } from "@/lib/styles/baseStyles";
import { TOKEN } from "@/lib/design/tokens";

type Mode = "ai" | "camera" | "voice";
type CreationEntryMode =
  | "ai_full_video"
  | "reel_from_assets"
  | "talking_head"
  | "post_or_carousel"
  | "system_recommended";

type ContentFlow = {
  mode?: Mode;
  creationEntryMode?: CreationEntryMode;
  selectedDirection?: {
    title?: string;
    description?: string;
  };
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

type SelectedVariant = {
  title?: string;
  description?: string;
  whyItFits?: string;
  structure?: string[];
  script?: {
    hook?: string;
    shots?: Shot[];
  };
  shotRequests?: ShotRequest[];
  assetsPlan?: AssetsPlan;
};

type ContentResult = {
  selectedVariant?: SelectedVariant;
};

function isFilmingEntryFlow(flow: ContentFlow): boolean {
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

/** מיפוי פנימי של מפתחות מהפלן — רק לתוויות בעברית, בלי להציג מונחים טכניים */
function beatDisplayLabel(part: string | undefined): string {
  switch (part) {
    case "hook":
      return "פתיחה";
    case "pain":
      return "נקודה שמחדדת את הצורך";
    case "explanation":
      return "הסבר";
    case "solution":
      return "הפתרון";
    case "proof":
      return "הוכחה";
    case "cta":
      return "סיום";
    case "value":
      return "הערך";
    case "context":
      return "הקשר";
    default:
      return /^[a-z_]+$/i.test(part || "") ? "חלק בסיפור" : (part || "").trim() || "חלק בסיפור";
  }
}

function momentTitle(
  index: number,
  total: number,
  structure?: string[]
): string {
  if (total <= 0) return "רגע";
  if (structure && structure.length === total) {
    return beatDisplayLabel(structure[index]);
  }
  if (index === 0) return "פתיחה";
  if (index === total - 1) return "סיום";
  if (total === 3 && index === 1) return "לב הסיפור";
  return `רגע ${index + 1} בדרך`;
}

function whyThisMattersLine(index: number, total: number, structure?: string[]): string {
  const beat = structure?.[index];
  if (index === 0 || beat === "hook") {
    return "הרגע הראשון הוא שיחליט אם ממשיכים לצפות.";
  }
  if (index === total - 1 || beat === "cta") {
    return "כאן אומרים בבירור מה כדאי לעשות אחרי שצפו.";
  }
  if (beat === "pain") return "הרגע הזה הוא שגורם לצופה להרגיש שהוא מדבר אליו.";
  if (beat === "proof") return "ראייה פשוטה כאן יכולה לשנות את כל תחושת האמת של הסרטון.";
  if (beat === "solution") return "הסבר קצר וברור כאן שווה יותר מהרבה מילים.";
  return "כאן מחברים בין מה שאמרתם לבין למה זה רלוונטי.";
}

/** תצוגה בלבד — הופך ניסוחי פלן פנימיים לשפה פשוטה, בלי לשנות נתונים */
function humanizeProductionCopy(raw: string): string {
  let s = (raw || "").trim();
  if (!s) return s;

  const pairs: Array<[string, string]> = [
    ["צילום אנכי 9:16", "לצלם לאורך (כמו סטורי או רילס)"],
    ["שוט פתיחה חזק ל־Hook", "פתיחה קצרה שתופסת את העין ישר"],
    ["שוט פתיחה חזק ל-Hook", "פתיחה קצרה שתופסת את העין ישר"],
    ["שוט פתיחה חזק ל-hook", "פתיחה קצרה שתופסת את העין ישר"],
    ["שוטי B-roll קצרים שתומכים במסר", "רגעים קצרים שמראים את מה שאתם מדברים עליו"],
    ["שוט סיום ברור ל־CTA", "משפט סיום ברור שאומר מה עושים עכשיו"],
    ["שוט סיום ברור ל-CTA", "משפט סיום ברור שאומר מה עושים עכשיו"],
    [
      "שוטי דיבור ישיר למצלמה — בגובה העיניים, תאורה טובה",
      "כמה קטעים שלכם מדברים טבעי למצלמה, במקום מואר",
    ],
    [
      "תוצאה ויזואלית ברורה או המחשה חזקה",
      "משהו שממחיש את התוצאה או מראה את זה בפועל",
    ],
    ["המלצה, חוות דעת או דוגמה אמיתית", "לקוח מרוצה, המלצה או דוגמה אמיתית"],
    ["הוכחת תוצאה או תהליך אמין", "משהו שמראה שהתהליך באמת עובד"],
    ["Before / After", "לפני ואחרי"],
    [
      "שוטי תמיכה נוספים להחזיק קצב לאורך הסרטון",
      "עוד רגעים קצרים שאפשר לשלב לאורך הסרטון",
    ],
    ["לוגו לשימוש רק בסיום אם צריך", "לוגו (אם תרצו שנוסיף בסוף)"],
    ["צילום מקום / תהליך / שירות / מוצר", "תמונות או סרטונים של המקום, השירות או המוצר"],
    [
      "שוט פתיחה מפתיע — זווית, תנועה, או מסר חזק",
      "פתיחה קצת מפתיעה — זווית, תנועה, או מסר חזק",
    ],
    [
      "שוט פתיחה שבו אתם שואלים שאלה ישירה למצלמה",
      "בתחילה שאלו שאלה ישרה למצלמה",
    ],
  ];

  for (const [from, to] of pairs) {
    if (s.includes(from)) {
      s = s.split(from).join(to);
    }
  }

  if (/מוזיקת רקע\s*:/.test(s)) {
    s = "אם יש מוזיקה שאתם אוהבים — אפשר לצרף";
  }

  return s
    .replace(/\bHook\b/gi, "פתיחה")
    .replace(/\bB-roll\b/gi, "רגעי ליווי קצרים")
    .replace(/\bCTA\b/gi, "סיום ברור")
    .replace(/\bAssets?\b/gi, "חומרים")
    .replace(/\bUpload\b/gi, "לשלוח מהטלפון")
    .replace(/\bShot(s)?\b/gi, "רגעים")
    .replace(/\b9:16\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export default function ShotDirectionPage() {
  const router = useRouter();
  const [flow, setFlow] = useState<ContentFlow | null>(null);
  const [variant, setVariant] = useState<SelectedVariant | null>(null);

  useEffect(() => {
    const rawFlow = localStorage.getItem("content_flow");
    const rawResult = localStorage.getItem("content_result");

    if (!rawFlow || !rawResult) {
      router.replace("/content");
      return;
    }

    try {
      const parsedFlow = JSON.parse(rawFlow) as ContentFlow;
      const parsedResult = JSON.parse(rawResult) as ContentResult;
      const selected = parsedResult.selectedVariant;

      if (!isFilmingEntryFlow(parsedFlow)) {
        router.replace("/content/creator-plan");
        return;
      }

      if (!selected?.script?.shots || selected.script.shots.length === 0) {
        router.replace("/content/creator-plan");
        return;
      }

      setFlow(parsedFlow);
      setVariant(selected);
    } catch (err) {
      console.error(err);
      router.replace("/content");
    }
  }, [router]);

  const shots = variant?.script?.shots ?? [];
  const shotRequests = variant?.shotRequests ?? [];
  const structure = variant?.structure;

  const requestByIndex = useMemo(() => {
    const map = new Map<number, ShotRequest>();
    for (const req of shotRequests) {
      map.set(req.index, req);
    }
    return map;
  }, [shotRequests]);

  const subtitle = useMemo(() => {
    const context =
      flow?.selectedDirection?.title?.trim() ||
      variant?.title?.trim() ||
      "";
    const tail =
      "הנה איך לתפוס את הרגעים שיעשו את הסרטון הזה הרבה יותר טוב.";
    return context ? `${context} — ${tail}` : tail;
  }, [flow?.selectedDirection?.title, variant?.title]);

  function handleContinue() {
    router.push("/content/assets-upload");
  }

  if (!flow || !variant || shots.length === 0) {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <div style={contentAreaStyle}>
            <p style={loadingTextStyle}>רגע אחד…</p>
          </div>
        </div>
      </div>
    );
  }

  const plan = variant.assetsPlan;
  const required = plan?.requiredAssets ?? [];
  const optional = plan?.optionalAssets ?? [];

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <BackButton href="/content/creator-plan" />
          <div style={topBarTitleStyle}>כיוון לפני הצילום</div>
          <div style={topBarSpacerStyle} />
        </div>

        <ProgressBar progress={78} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>מכוונים אתכם</div>
            <h1 style={titleStyle}>בוא נצלם את זה נכון</h1>
            <p style={subtitleStyle}>{subtitle}</p>
          </div>

          {variant.whyItFits ? (
            <div style={whyCardStyle}>
              <div style={whyLabelStyle}>למה זה הכיוון הנכון לתוכן הזה</div>
              <div style={whyTextStyle}>{variant.whyItFits}</div>
            </div>
          ) : null}

          {variant.script?.hook ? (
            <div style={hookReminderStyle}>
              <div style={hookLabelStyle}>הפתיחה שנבחרה</div>
              <div style={hookTextStyle}>{variant.script.hook}</div>
              <div style={hookSubtextStyle}>אפשר לשמור לצורך הצילום</div>
            </div>
          ) : null}

          {(required.length > 0 || optional.length > 0) && (
            <div style={checklistCardStyle}>
              <div style={checklistTitleStyle}>מה כדאי לצלם</div>
              {required.map((item, i) => (
                <div key={`r-${i}`} style={checklistRowStyle}>
                  <span style={checklistBulletRequiredStyle}>✓</span>
                  <span style={checklistItemTextStyle}>{humanizeProductionCopy(item)}</span>
                </div>
              ))}
              {optional.length > 0 ? (
                <>
                  <div style={checklistSectionLabelOptionalStyle}>
                    אם יש — זה יכול להוסיף
                  </div>
                  {optional.map((item, i) => (
                    <div key={`o-${i}`} style={checklistRowStyle}>
                      <span style={checklistBulletOptionalStyle}>◦</span>
                      <span style={checklistItemOptionalTextStyle}>{humanizeProductionCopy(item)}</span>
                    </div>
                  ))}
                </>
              ) : null}
              <div style={checklistFootnoteStyle}>
                לא חייב מושלם — העיקר שירגיש אמיתי.
              </div>
            </div>
          )}

          <div style={shotsIntroStyle}>עוברים רגע־רגע</div>

          {shots.map((shot, index) => {
            const req = requestByIndex.get(index);
            const guidance = req?.shootingGuidance?.trim() || "";
            const title = momentTitle(index, shots.length, structure);

            return (
              <div key={index} style={momentCardStyle}>
                <div style={momentHeaderStyle}>
                  <div style={momentTitleStyle}>{title}</div>
                  <div style={momentIndexStyle}>{index + 1}/{shots.length}</div>
                </div>

                <div style={blockStyle}>
                  <div style={blockLabelStyle}>מה לצלם</div>
                  <div style={blockBodyStyle}>{shot.visual}</div>
                </div>

                <div style={blockStyle}>
                  <div style={blockLabelStyle}>מה להגיד</div>
                  <div style={blockBodyStyle}>{shot.voice}</div>
                </div>

                {guidance ? (
                  <div style={blockStyle}>
                    <div style={blockLabelStyle}>איך לתפוס את הרגע</div>
                    <div style={blockBodyStyle}>{humanizeProductionCopy(guidance)}</div>
                  </div>
                ) : null}

                <div style={tinyHelperStyle}>{whyThisMattersLine(index, shots.length, structure)}</div>
              </div>
            );
          })}
        </div>

        <div style={footerStyle}>
          <button type="button" onClick={handleContinue} style={primaryButtonStyle}>
            המשך — מעלים את החומרים
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

const loadingTextStyle: React.CSSProperties = {
  fontSize: 15,
  color: "#6b7280",
  textAlign: "center",
  padding: 40,
};

const introWrapStyle: React.CSSProperties = {
  marginBottom: 22,
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

const whyCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 18,
  padding: 16,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
  marginBottom: 14,
};

const whyLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: "#6b7280",
  marginBottom: 8,
};

const whyTextStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.75,
  color: "#374151",
};

const hookReminderStyle: React.CSSProperties = {
  ...whyCardStyle,
  background: "#eff6ff",
  borderColor: "#bfdbfe",
};

const hookLabelStyle: React.CSSProperties = {
  ...whyLabelStyle,
  color: "#1e40af",
};

const hookTextStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.75,
  color: "#1e3a8a",
  fontWeight: 600,
};

const hookSubtextStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  color: "#3b82f6",
  fontWeight: 600,
};

const checklistCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 18,
  padding: 16,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
  marginBottom: 18,
};

const checklistTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 12,
};

const checklistSectionLabelOptionalStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "#6b7280",
  marginTop: 14,
  marginBottom: 8,
};

const checklistRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  marginBottom: 10,
};

const checklistBulletRequiredStyle: React.CSSProperties = {
  flexShrink: 0,
  width: 22,
  height: 22,
  borderRadius: "50%",
  background: "#ecfdf5",
  border: "1px solid #a7f3d0",
  color: "#065f46",
  fontSize: 11,
  fontWeight: 900,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  marginTop: 1,
};

const checklistBulletOptionalStyle: React.CSSProperties = {
  flexShrink: 0,
  width: 22,
  height: 22,
  borderRadius: "50%",
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
  color: "#9ca3af",
  fontSize: 14,
  fontWeight: 900,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  marginTop: 1,
};

const checklistItemTextStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.65,
  color: "#374151",
};

const checklistItemOptionalTextStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.65,
  color: "#6b7280",
};

const checklistFootnoteStyle: React.CSSProperties = {
  marginTop: 14,
  fontSize: 13,
  lineHeight: 1.65,
  color: "#6b7280",
  fontStyle: "italic",
};

const shotsIntroStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 12,
};

const momentCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 18,
  padding: 16,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
  marginBottom: 12,
};

const momentHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 14,
};

const momentTitleStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: "#111827",
};

const momentIndexStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: "#9ca3af",
  flexShrink: 0,
};

const blockStyle: React.CSSProperties = {
  marginBottom: 12,
};

const blockLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: "#065f46",
  marginBottom: 4,
};

const blockBodyStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.75,
  color: "#374151",
};

const tinyHelperStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.6,
  color: "#9ca3af",
  marginTop: 4,
  paddingTop: 10,
  borderTop: "1px solid #f3f4f6",
};

const footerStyle: React.CSSProperties = {
  position: "sticky",
  bottom: 0,
  zIndex: 20,
  background: "rgba(255,255,255,0.92)",
  backdropFilter: "blur(10px)",
  borderTop: "1px solid #e5e7eb",
  padding: "12px 16px calc(12px + env(safe-area-inset-bottom)) 16px",
};

const primaryButtonStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  height: 50,
  borderRadius: 14,
  border: "none",
  background: "#111827",
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 800,
  cursor: "pointer",
  boxShadow: "0 10px 24px rgba(17,24,39,0.18)",
};
