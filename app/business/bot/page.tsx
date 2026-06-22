"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import Link from "next/link";
import PageHeader from "@/components/ui/page-header";
import { TOKEN } from "@/lib/design/tokens";
import {
  computeProductCatalogEnabled,
  isValidProductLinkUrl,
} from "@/lib/inbox-view/product-link-capability";
import {
  BOT_WORK_MODE_OPTIONS,
  parseBotControlHandoffRules,
  resolveBotWorkMode,
} from "@/lib/features/conversation/bot-control";

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

type ApiSettings = {
  enabled: boolean;
  mode: string;
  channel: string;
  welcomeMessage: string | null;
  questions: unknown;
  finalAction: string | null;
  finalActionPayload: unknown;
  showDraftSuggestionsInInbox?: boolean;
  productLinkEnabled?: boolean;
  productLinkUrl?: string | null;
  productLinkIntro?: string | null;
  handoffRules?: unknown;
};

function questionsHaveContent(questions: unknown): boolean {
  if (!questions || typeof questions !== "object") return false;
  const items = (questions as { items?: unknown }).items;
  if (!Array.isArray(items)) return false;
  return items.some((i) => typeof i === "string" && i.trim().length > 0);
}

function parseWebsiteUrl(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const raw = (payload as Record<string, unknown>).websiteUrl;
  return typeof raw === "string" ? raw.trim() : "";
}

function isValidHttpsUrl(raw: string): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function finishStepComplete(s: ApiSettings): boolean {
  const action = s.finalAction ?? "";
  if (action === "SEND_LINK") {
    return isValidHttpsUrl(parseWebsiteUrl(s.finalActionPayload));
  }
  return action.length > 0;
}

export default function BusinessBotHubPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ApiSettings | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/business/bot-settings", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const s: ApiSettings = data?.settings ?? data;
      if (!s) throw new Error();
      setSettings(s);
    } catch {
      setError("לא ניתן לטעון את נתוני הבוט");
      setSettings(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const derived = useMemo(() => {
    if (!settings) {
      return {
        welcomeOk: false,
        questionsOk: false,
        finishOk: false,
        headline: "טוען…",
        subline: "",
        primaryLabel: "המשך הגדרה",
        needsSetupWork: true,
        workModeLabel: "",
      };
    }
    const welcomeOk = (settings.welcomeMessage ?? "").trim().length > 0;
    const questionsOk = questionsHaveContent(settings.questions);
    const finishOk = finishStepComplete(settings);
    const needsSetupWork =
      !settings.enabled || !welcomeOk || !questionsOk || !finishOk;

    const workMode = resolveBotWorkMode({
      enabled: settings.enabled,
      showDraftSuggestionsInInbox: !!settings.showDraftSuggestionsInInbox,
      handoffRules: parseBotControlHandoffRules(settings.handoffRules),
    });
    const workModeMeta = BOT_WORK_MODE_OPTIONS.find((o) => o.id === workMode);

    let headline: string;
    let subline: string;

    if (workMode === "MANUAL") {
      headline = "מצב ידני — אתם עונים";
      subline =
        "האינבוקס מסדר שיחות. אין טיוטות בוט — רק אתם שולחים ללקוח.";
    } else if (!settings.enabled) {
      headline = "טיוטות הבוט כבויות";
      subline =
        "כשתפעילו, הבוט יכין טקסטים באינבוקס. אתם תמיד לוחצים שלח — הלקוח לא מקבל כלום לבד.";
    } else if (!welcomeOk) {
      headline = "חסרה הודעת פתיחה";
      subline = "זה מה שיופיע בטיוטה הראשונה — אתם עורכים ושולחים מהאינבוקס.";
    } else if (!questionsOk) {
      headline = "חסרות שאלות לפני העברה";
      subline = "שאלה אחת לפחות — כך הטיוטות יאספו פרטים לפני שאתם ממשיכים.";
    } else if (!finishOk) {
      headline = "חסר סיום לסדרת הטיוטות";
      subline = "מה קורה אחרי השאלות. אם בחרתם קישור — צריך כתובת תקינה.";
    } else {
      headline = "טיוטות מוכנות — אתם שולחים";
      subline =
        "הבוט מכין טקסטים באינבוקס. הלקוח מקבל רק מה שאתם מאשרים ושולחים.";
    }

    const primaryLabel = needsSetupWork ? "המשך הגדרה" : "עריכת הבוט";

    return {
      welcomeOk,
      questionsOk,
      finishOk,
      headline,
      subline,
      primaryLabel,
      needsSetupWork,
      workModeLabel: workModeMeta?.trustLine ?? "",
    };
  }, [settings]);

  const cardStyle: CSSProperties = {
    background: TOKEN.surface.card,
    border: `1px solid ${TOKEN.border.DEFAULT}`,
    borderRadius: TOKEN.radius.modal,
    padding: TOKEN.space.lg,
    boxSizing: "border-box",
  };

  const primaryBtnStyle: CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "center",
    padding: "14px 18px",
    borderRadius: TOKEN.radius.input,
    border: "none",
    background: TOKEN.ink.primary,
    color: TOKEN.ink.inverse,
    fontSize: TOKEN.font.title,
    fontWeight: TOKEN.weight.bold,
    textDecoration: "none",
    boxSizing: "border-box",
  };

  const secondaryBtnStyle: CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "center",
    padding: "12px 16px",
    borderRadius: TOKEN.radius.input,
    border: `1px solid ${TOKEN.border.hover}`,
    background: TOKEN.surface.inset,
    color: TOKEN.ink.primary,
    fontSize: TOKEN.font.body,
    fontWeight: TOKEN.weight.semibold,
    textDecoration: "none",
    boxSizing: "border-box",
  };

  const stepRow = (done: boolean, label: string): ReactNode => (
    <div
      key={label}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: TOKEN.font.body,
        color: done ? TOKEN.semantic.success.ink : TOKEN.ink.muted,
        marginBottom: 8,
      }}
    >
      <span style={{ fontSize: 18, lineHeight: 1 }}>{done ? "✓" : "○"}</span>
      <span>{label}</span>
    </div>
  );

  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <PageHeader
        title="בוט לשיחות"
        backHref="/tools"
        backLabel="כל הכלים"
        showBack
      />
      <main
        style={{
          maxWidth: 560,
          margin: "0 auto",
          padding: "20px 16px 96px",
          boxSizing: "border-box",
        }}
      >
        {loading ? (
          <p style={{ margin: 0, color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>טוען…</p>
        ) : error ? (
          <p style={{ margin: 0, color: TOKEN.semantic.urgent.ink, fontSize: TOKEN.font.body }}>{error}</p>
        ) : settings ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <section style={cardStyle}>
              <p
                style={{
                  margin: "0 0 8px",
                  fontSize: TOKEN.font.meta,
                  fontWeight: TOKEN.weight.bold,
                  color: TOKEN.ink.muted,
                  letterSpacing: 0.2,
                }}
              >
                מצב
              </p>
              <h1
                style={{
                  margin: "0 0 10px",
                  fontSize: TOKEN.font.hero,
                  fontWeight: TOKEN.weight.bold,
                  color: TOKEN.ink.primary,
                  lineHeight: 1.25,
                }}
              >
                {derived.headline}
              </h1>
              <p style={{ margin: 0, fontSize: TOKEN.font.body, color: TOKEN.ink.secondary, lineHeight: 1.55 }}>
                {derived.subline}
              </p>
              {derived.workModeLabel ? (
                <p
                  style={{
                    margin: "10px 0 0",
                    fontSize: TOKEN.font.meta,
                    color: TOKEN.brand.mid,
                    fontWeight: TOKEN.weight.semibold,
                  }}
                >
                  {derived.workModeLabel}
                </p>
              ) : null}
            </section>

            <section
              style={{
                ...cardStyle,
                background: TOKEN.surface.inset,
                borderColor: TOKEN.border.DEFAULT,
              }}
            >
              <p style={{ margin: "0 0 8px", fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.secondary }}>
                אמון ושליטה
              </p>
              <ul
                style={{
                  margin: 0,
                  paddingRight: 18,
                  fontSize: TOKEN.font.body,
                  color: TOKEN.ink.muted,
                  lineHeight: 1.6,
                }}
              >
                <li>הבוט מכין — אתם שולחים</li>
                <li>הלקוח לא מקבל הודעות מהבוט לבד</li>
                <li>בכל שיחה: &quot;אני מטפל מכאן&quot; עוצר טיוטות חדשות</li>
                <li>
                  <Link href="/inbox" style={{ color: TOKEN.brand.mid, fontWeight: TOKEN.weight.semibold }}>
                    מעבר לאינבוקס
                  </Link>{" "}
                  — אותה מערכת, לא כלי נפרד
                </li>
              </ul>
            </section>

            <section style={cardStyle}>
              <p
                style={{
                  margin: "0 0 12px",
                  fontSize: TOKEN.font.meta,
                  fontWeight: TOKEN.weight.bold,
                  color: TOKEN.ink.muted,
                }}
              >
                התקדמות קצרה
              </p>
              {stepRow(derived.welcomeOk, "הודעת פתיחה")}
              {stepRow(derived.questionsOk, "שאלות לפני העברה אליך")}
              {stepRow(derived.finishOk, "מה קורה בסוף השיחה עם הבוט")}
            </section>

            {settings &&
            isValidProductLinkUrl((settings.productLinkUrl ?? "").trim()) ? (
              <section style={cardStyle}>
                <p
                  style={{
                    margin: "0 0 8px",
                    fontSize: TOKEN.font.meta,
                    fontWeight: TOKEN.weight.bold,
                    color: TOKEN.semantic.success.ink,
                  }}
                >
                  קישור מוצרים
                </p>
                <p style={{ margin: "0 0 10px", fontSize: TOKEN.font.body, color: TOKEN.ink.secondary, lineHeight: 1.55 }}>
                  chip באינבוקס ימלא את ההודעה — אתם שולחים בלחיצה.
                </p>
                {!computeProductCatalogEnabled({
                  productLinkEnabled: !!settings.productLinkEnabled,
                  productLinkUrl: settings.productLinkUrl ?? null,
                }) ? (
                  <p style={{ margin: "0 0 10px", fontSize: TOKEN.font.meta, color: TOKEN.semantic.attention.ink, lineHeight: 1.45 }}>
                    כדי שהמערכת תוכל להציע את זה בשיחות, הפעילו את המצב בעריכת הבוט תחת
                    &quot;עזרה עם מוצרים&quot;.
                  </p>
                ) : null}
                {(settings.productLinkIntro ?? "").trim() ? (
                  <div
                    style={{
                      marginBottom: 8,
                      padding: "10px 12px",
                      borderRadius: TOKEN.radius.input,
                      background: TOKEN.surface.inset,
                      border: `1px solid ${TOKEN.border.DEFAULT}`,
                      fontSize: TOKEN.font.body,
                      color: TOKEN.ink.primary,
                    }}
                  >
                    {(settings.productLinkIntro ?? "").trim()}
                  </div>
                ) : null}
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: TOKEN.radius.input,
                    background: TOKEN.semantic.success.bgSoft,
                    border: `1px solid ${TOKEN.semantic.success.border}`,
                    fontFamily: "ui-monospace, monospace",
                    fontSize: TOKEN.font.meta,
                    wordBreak: "break-all",
                    color: TOKEN.semantic.success.ink,
                  }}
                >
                  {(settings.productLinkUrl ?? "").trim()}
                </div>
              </section>
            ) : null}

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <Link href="/business/bot-settings" style={primaryBtnStyle}>
                {derived.primaryLabel}
              </Link>
              <Link href="/inbox" style={secondaryBtnStyle}>
                לעבור לשיחות
              </Link>
            </div>

            <section style={{ ...cardStyle, background: TOKEN.surface.inset }}>
              <p
                style={{
                  margin: "0 0 10px",
                  fontSize: TOKEN.font.meta,
                  fontWeight: TOKEN.weight.bold,
                  color: TOKEN.ink.muted,
                }}
              >
                מה הבוט יודע לעשות כרגע
              </p>
              <ul
                style={{
                  margin: 0,
                  paddingInlineStart: 20,
                  fontSize: TOKEN.font.body,
                  color: TOKEN.ink.secondary,
                  lineHeight: 1.65,
                }}
              >
                <li>לענות להודעות פתיחה</li>
                <li>לאסוף פרטים</li>
                <li>להעביר אליך שיחות</li>
                <li>להציע טיוטות — לפי מה שמופעל בהגדרות</li>
              </ul>
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}
