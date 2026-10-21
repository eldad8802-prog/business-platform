"use client";

import { useEffect, useMemo, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { useRouter } from "next/navigation";
import ProgressBar from "@/components/ProgressBar";
import BackButton from "@/components/ui/back-button";
import { baseStyles } from "@/lib/styles/baseStyles";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";

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
function beatDisplayLabel(t: Translator, part: string | undefined): string {
  switch (part) {
    case "hook":
      return t("content.studio.shotDirection.beats.hook");
    case "pain":
      return t("content.studio.shotDirection.beats.pain");
    case "explanation":
      return t("content.studio.shotDirection.beats.explanation");
    case "solution":
      return t("content.studio.shotDirection.beats.solution");
    case "proof":
      return t("content.studio.shotDirection.beats.proof");
    case "cta":
      return t("content.studio.shotDirection.beats.cta");
    case "value":
      return t("content.studio.shotDirection.beats.value");
    case "context":
      return t("content.studio.shotDirection.beats.context");
    default:
      // A non-technical label from the plan is generated content — shown as-is.
      return /^[a-z_]+$/i.test(part || "")
        ? t("content.studio.shotDirection.beats.storyPart")
        : (part || "").trim() || t("content.studio.shotDirection.beats.storyPart");
  }
}

function momentTitle(
  t: Translator,
  index: number,
  total: number,
  structure?: string[]
): string {
  if (total <= 0) return t("content.studio.shotDirection.moment.single");
  if (structure && structure.length === total) {
    return beatDisplayLabel(t, structure[index]);
  }
  if (index === 0) return t("content.studio.shotDirection.beats.hook");
  if (index === total - 1) return t("content.studio.shotDirection.beats.cta");
  if (total === 3 && index === 1) return t("content.studio.shotDirection.moment.heart");
  return t("content.studio.shotDirection.moment.numbered", { n: index + 1 });
}

function whyThisMattersLine(t: Translator, index: number, total: number, structure?: string[]): string {
  const beat = structure?.[index];
  if (index === 0 || beat === "hook") {
    return t("content.studio.shotDirection.why.hook");
  }
  if (index === total - 1 || beat === "cta") {
    return t("content.studio.shotDirection.why.cta");
  }
  if (beat === "pain") return t("content.studio.shotDirection.why.pain");
  if (beat === "proof") return t("content.studio.shotDirection.why.proof");
  if (beat === "solution") return t("content.studio.shotDirection.why.solution");
  return t("content.studio.shotDirection.why.default");
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
  const { t } = useI18n();
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
    const tail = t("content.studio.shotDirection.subtitleTail");
    return context ? t("content.studio.shotDirection.subtitleWithContext", { context, tail }) : tail;
  }, [flow?.selectedDirection?.title, variant?.title, t]);

  function handleContinue() {
    router.push("/content/assets-upload");
  }

  if (!flow || !variant || shots.length === 0) {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <div style={contentAreaStyle}>
            <p style={loadingTextStyle}>{t("content.studio.shotDirection.loading")}</p>
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
          <BackButton />
          <div style={topBarTitleStyle}>{t("content.studio.shotDirection.topBarTitle")}</div>
          <div style={topBarSpacerStyle} />
        </div>

        <ProgressBar progress={78} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>{t("content.studio.shotDirection.eyebrow")}</div>
            <h1 style={titleStyle}>{t("content.studio.shotDirection.title")}</h1>
            <p style={subtitleStyle}>{subtitle}</p>
          </div>

          {variant.whyItFits ? (
            <div style={whyCardStyle}>
              <div style={whyLabelStyle}>{t("content.studio.shotDirection.whyLabel")}</div>
              <div style={whyTextStyle}>{variant.whyItFits}</div>
            </div>
          ) : null}

          {variant.script?.hook ? (
            <div style={hookReminderStyle}>
              <div style={hookLabelStyle}>{t("content.studio.shotDirection.hookLabel")}</div>
              <div style={hookTextStyle}>{variant.script.hook}</div>
              <div style={hookSubtextStyle}>{t("content.studio.shotDirection.hookSubtext")}</div>
            </div>
          ) : null}

          {(required.length > 0 || optional.length > 0) && (
            <div style={checklistCardStyle}>
              <div style={checklistTitleStyle}>{t("content.studio.shotDirection.checklistTitle")}</div>
              {required.map((item, i) => (
                <div key={`r-${i}`} style={checklistRowStyle}>
                  <span style={checklistBulletRequiredStyle}>✓</span>
                  <span style={checklistItemTextStyle}>{humanizeProductionCopy(item)}</span>
                </div>
              ))}
              {optional.length > 0 ? (
                <>
                  <div style={checklistSectionLabelOptionalStyle}>
                    {t("content.studio.shotDirection.optionalLabel")}
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
                {t("content.studio.shotDirection.checklistFootnote")}
              </div>
            </div>
          )}

          <div style={shotsIntroStyle}>{t("content.studio.shotDirection.shotsIntro")}</div>

          {shots.map((shot, index) => {
            const req = requestByIndex.get(index);
            const guidance = req?.shootingGuidance?.trim() || "";
            const title = momentTitle(t, index, shots.length, structure);

            return (
              <div key={index} style={momentCardStyle}>
                <div style={momentHeaderStyle}>
                  <div style={momentTitleStyle}>{title}</div>
                  <div style={momentIndexStyle}>{t("content.studio.shotDirection.moment.index", { n: index + 1, total: shots.length })}</div>
                </div>

                <div style={blockStyle}>
                  <div style={blockLabelStyle}>{t("content.studio.shotDirection.blockVisual")}</div>
                  <div style={blockBodyStyle}>{shot.visual}</div>
                </div>

                <div style={blockStyle}>
                  <div style={blockLabelStyle}>{t("content.studio.shotDirection.blockVoice")}</div>
                  <div style={blockBodyStyle}>{shot.voice}</div>
                </div>

                {guidance ? (
                  <div style={blockStyle}>
                    <div style={blockLabelStyle}>{t("content.studio.shotDirection.blockGuidance")}</div>
                    <div style={blockBodyStyle}>{humanizeProductionCopy(guidance)}</div>
                  </div>
                ) : null}

                <div style={tinyHelperStyle}>{whyThisMattersLine(t, index, shots.length, structure)}</div>
              </div>
            );
          })}
        </div>

        <div style={footerStyle}>
          <button type="button" onClick={handleContinue} style={primaryButtonStyle}>
            {t("content.studio.shotDirection.continue")}
          </button>
        </div>
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  ...baseStyles.page,
  background:
    "linear-gradient(180deg, var(--dz-surface-muted) 0%, var(--dz-surface-flat) 35%, var(--dz-surface-muted) 100%)",
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
  color: "var(--dz-text-primary)",
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
  color: "var(--dz-text-muted)",
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
  color: "var(--dz-success)",
  background: "var(--dz-success-bg-soft)",
  border: "1px solid var(--dz-success-border)",
  borderRadius: 999,
  padding: "6px 10px",
  marginBottom: 12,
};

const titleStyle: React.CSSProperties = {
  fontSize: 30,
  fontWeight: 800,
  lineHeight: 1.15,
  color: "var(--dz-text-primary)",
  margin: 0,
  marginBottom: 10,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 15,
  color: "var(--dz-text-muted)",
  lineHeight: 1.7,
  margin: 0,
  maxWidth: 640,
};

const whyCardStyle: React.CSSProperties = {
  background: "var(--dz-surface)",
  borderRadius: 18,
  padding: 16,
  border: "1px solid var(--dz-border)",
  boxShadow: "0 4px 14px rgba(52, 60, 50, 0.04)",
  marginBottom: 14,
};

const whyLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: "var(--dz-text-muted)",
  marginBottom: 8,
};

const whyTextStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.75,
  color: "var(--dz-text-secondary)",
};

const hookReminderStyle: React.CSSProperties = {
  ...whyCardStyle,
  background: "var(--dz-info-bg-soft)",
  borderColor: "var(--dz-info-border)",
};

const hookLabelStyle: React.CSSProperties = {
  ...whyLabelStyle,
  color: "var(--dz-info)",
};

const hookTextStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.75,
  color: "var(--dz-info)",
  fontWeight: 600,
};

const hookSubtextStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  color: "var(--dz-info-accent)",
  fontWeight: 600,
};

const checklistCardStyle: React.CSSProperties = {
  background: "var(--dz-surface)",
  borderRadius: 18,
  padding: 16,
  border: "1px solid var(--dz-border)",
  boxShadow: "0 4px 14px rgba(52, 60, 50, 0.04)",
  marginBottom: 18,
};

const checklistTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: "var(--dz-text-primary)",
  marginBottom: 12,
};

const checklistSectionLabelOptionalStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "var(--dz-text-muted)",
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
  background: "var(--dz-success-bg-soft)",
  border: "1px solid var(--dz-success-border)",
  color: "var(--dz-success)",
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
  background: "var(--dz-surface-muted)",
  border: "1px solid var(--dz-border)",
  color: "var(--dz-text-muted)",
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
  color: "var(--dz-text-secondary)",
};

const checklistItemOptionalTextStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.65,
  color: "var(--dz-text-muted)",
};

const checklistFootnoteStyle: React.CSSProperties = {
  marginTop: 14,
  fontSize: 13,
  lineHeight: 1.65,
  color: "var(--dz-text-muted)",
  fontStyle: "italic",
};

const shotsIntroStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: "var(--dz-text-primary)",
  marginBottom: 12,
};

const momentCardStyle: React.CSSProperties = {
  background: "var(--dz-surface)",
  borderRadius: 18,
  padding: 16,
  border: "1px solid var(--dz-border)",
  boxShadow: "0 4px 14px rgba(52, 60, 50, 0.04)",
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
  color: "var(--dz-text-primary)",
};

const momentIndexStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: "var(--dz-text-muted)",
  flexShrink: 0,
};

const blockStyle: React.CSSProperties = {
  marginBottom: 12,
};

const blockLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: "var(--dz-success)",
  marginBottom: 4,
};

const blockBodyStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.75,
  color: "var(--dz-text-secondary)",
};

const tinyHelperStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.6,
  color: "var(--dz-text-muted)",
  marginTop: 4,
  paddingTop: 10,
  borderTop: "1px solid var(--dz-border-subtle)",
};

const footerStyle: React.CSSProperties = {
  position: "sticky",
  bottom: 0,
  zIndex: 20,
  background: "rgba(255,255,255,0.92)",
  backdropFilter: "blur(10px)",
  borderTop: "1px solid var(--dz-border)",
  padding: "12px 16px calc(12px + env(safe-area-inset-bottom)) 16px",
};

const primaryButtonStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  height: 50,
  borderRadius: 14,
  border: "none",
  background: TOKEN.action.primary.background,
  color: "var(--dz-text-on-brand)",
  fontSize: 15,
  fontWeight: 800,
  cursor: "pointer",
  boxShadow: TOKEN.action.primary.shadow,
};
