"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { isValidProductLinkUrl } from "@/lib/inbox-view/product-link-capability";
import {
  BOT_BOUNDARY_OPTIONS,
  BOT_WORK_MODE_OPTIONS_ACTIVE,
  DEFAULT_BOT_BOUNDARIES,
  parseBotControlHandoffRules,
  resolveBotWorkMode,
  settingsPatchForWorkMode,
  type BotBoundaryPresets,
  type BotWorkMode,
} from "@/lib/features/conversation/bot-control";
import {
  FINAL_ACTION_OPTIONS as FINAL_ACTIONS,
  type FinalAction,
} from "@/lib/features/conversation/final-action";
import type { BotSettingsArea } from "./bot-settings-areas";
import {
  BUILDER_SHELL_MAX_WIDTH,
  AreaHeader,
  BuilderTextAreaField,
  BuilderTextField,
  ChoiceRow,
  GuardNote,
  Stepper,
  StickyActionBar,
  ToggleRow,
  areaPanelStyle,
} from "./bot-builder-area-ui";
import {
  ApproachFlagshipScreen,
  PersonalityFlagshipScreen,
  VoiceProfileScreen,
} from "./bot-profile-screens";
import { GoalsFlagshipScreen } from "./bot-goals-screen";

type FinalActionValue = FinalAction;

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

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

function questionsJsonToLines(questions: unknown): string {
  if (!questions || typeof questions !== "object") return "";
  const items = (questions as { items?: unknown }).items;
  if (!Array.isArray(items)) return "";
  return items.filter((item): item is string => typeof item === "string").join("\n");
}

function linesToQuestionsJson(text: string): { items: string[] } | null {
  const items = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (items.length === 0) return null;
  return { items };
}

function parseWebsiteUrl(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const raw = (payload as Record<string, unknown>).websiteUrl;
  return typeof raw === "string" ? raw : "";
}

function normalizeFinalAction(value: string | null): FinalActionValue {
  const allowed = new Set<string>(FINAL_ACTIONS.map((a) => a.value));
  if (value && allowed.has(value)) return value as FinalActionValue;
  return "LEAVE_MESSAGE";
}

function areaMeta(area: BotSettingsArea): { title: string; eyebrow: string } {
  switch (area) {
    case "goal":
      return { title: "המטרה שלו", eyebrow: "נגזר מהקיים" };
    case "personality":
      return { title: "האופי שלו", eyebrow: "בקרוב" };
    case "voice":
      return { title: "איך הוא מדבר", eyebrow: "הודעת פתיחה" };
    case "conversation":
      return { title: "איך השיחה עובדת", eyebrow: "שאלות legacy" };
    case "approach":
      return { title: "הגישה שלו", eyebrow: "בקרוב" };
    case "knowledge":
      return { title: "מה הוא יודע", eyebrow: "קישור קטלוג" };
    case "memory":
      return { title: "מה הוא זוכר על לקוחות", eyebrow: "בקרוב" };
    case "autonomy":
      return { title: "כמה עצמאות נתת לו", eyebrow: "draft-only" };
    case "allowed":
      return { title: "מה הוא רשאי לעשות", eyebrow: "סיום שיחה" };
    case "forbidden":
      return { title: "מה אסור לו", eyebrow: "גבולות" };
    case "handoff":
      return { title: "מתי מעביר אליי", eyebrow: "גבולות העברה" };
    case "learning":
      return { title: "איך הוא משתפר", eyebrow: "בקרוב" };
  }
}

function useBotSettingsEditorState() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [showDraftSuggestionsInInbox, setShowDraftSuggestionsInInbox] = useState(false);
  const [welcomeMessage, setWelcomeMessage] = useState("");
  const [questionsLines, setQuestionsLines] = useState("");
  const [finalAction, setFinalAction] = useState<FinalActionValue>("LEAVE_MESSAGE");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [productLinkEnabled, setProductLinkEnabled] = useState(false);
  const [productLinkUrl, setProductLinkUrl] = useState("");
  const [productLinkIntro, setProductLinkIntro] = useState("");
  const [workMode, setWorkMode] = useState<BotWorkMode>("SMART_DRAFTS");
  const [boundaries, setBoundaries] = useState<BotBoundaryPresets>({
    ...DEFAULT_BOT_BOUNDARIES,
  });

  const parsedQuestions = useMemo(() => {
    return questionsLines
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }, [questionsLines]);

  const finalActionLabels = useMemo(
    () => Object.fromEntries(FINAL_ACTIONS.map((a) => [a.value, a.label])),
    []
  );

  const finalActionPreviewText = useMemo(() => {
    switch (finalAction) {
      case "LEAVE_MESSAGE":
        return "תודה על הפנייה. נחזור אליך בהקדם.";
      case "COLLECT_DETAILS":
        return "כדי להמשיך, נא לשלוח את הפרטים הנדרשים.";
      case "SEND_LINK":
        return websiteUrl.trim()
          ? `הנה הקישור לפרטים נוספים: ${websiteUrl.trim()}`
          : "הנה הקישור לפרטים נוספים.";
      case "ESCALATE":
        return "מעבירים את הפנייה לנציג מהצוות שלנו שיחזור אליך.";
      default:
        return "תודה על הפנייה.";
    }
  }, [finalAction, websiteUrl]);

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

      setEnabled(!!s.enabled);
      setShowDraftSuggestionsInInbox(!!s.showDraftSuggestionsInInbox);
      const rules = parseBotControlHandoffRules(s.handoffRules);
      const resolved = resolveBotWorkMode({
        enabled: !!s.enabled,
        showDraftSuggestionsInInbox: !!s.showDraftSuggestionsInInbox,
        handoffRules: rules,
      });
      setWorkMode(resolved === "AUTO_OPENING_FUTURE" ? "SMART_DRAFTS" : resolved);
      setBoundaries(rules.boundaries ?? { ...DEFAULT_BOT_BOUNDARIES });
      setWelcomeMessage(s.welcomeMessage ?? "");
      setQuestionsLines(questionsJsonToLines(s.questions));
      setFinalAction(normalizeFinalAction(s.finalAction));
      setWebsiteUrl(parseWebsiteUrl(s.finalActionPayload));
      setProductLinkEnabled(!!s.productLinkEnabled);
      setProductLinkUrl((s.productLinkUrl ?? "").trim());
      setProductLinkIntro(s.productLinkIntro ?? "");
    } catch {
      setError("לא ניתן לטעון את הגדרות הבוט");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    if (welcomeMessage.length > 8000) {
      setError("הודעת הפתיחה ארוכה מדי");
      setSaving(false);
      return;
    }
    if (finalAction === "SEND_LINK") {
      const url = websiteUrl.trim();
      if (!url) {
        setError("בחרת שליחת קישור — נא למלא כתובת אתר");
        setSaving(false);
        return;
      }
    }

    if (productLinkEnabled) {
      const pl = productLinkUrl.trim();
      if (!isValidProductLinkUrl(pl)) {
        setError("כשמפעילים עזרה עם מוצרים — נא למלא קישור מלא ותקין (https://…)");
        setSaving(false);
        return;
      }
    }

    const questions = linesToQuestionsJson(questionsLines);

    const modePatch = settingsPatchForWorkMode(workMode, {
      version: 1,
      workMode,
      boundaries,
    });

    const payload: Record<string, unknown> = {
      enabled: modePatch.enabled,
      showDraftSuggestionsInInbox: modePatch.showDraftSuggestionsInInbox,
      handoffRules: modePatch.handoffRules,
      mode: "STARTER",
      channel: "WHATSAPP",
      welcomeMessage: welcomeMessage.trim() === "" ? null : welcomeMessage,
      questions,
      finalAction,
      finalActionPayload:
        finalAction === "SEND_LINK"
          ? { websiteUrl: websiteUrl.trim() }
          : null,
      productLinkEnabled,
      productLinkUrl: productLinkUrl.trim() === "" ? null : productLinkUrl.trim(),
      productLinkIntro: productLinkIntro.trim() === "" ? null : productLinkIntro.trim(),
    };

    try {
      const token = getAuthToken();
      const res = await fetch("/api/business/bot-settings", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let msg = "שמירה נכשלה";
        try {
          const j = await res.json();
          if (j?.error) msg = String(j.error);
        } catch {
          /* ignore */
        }
        setError(msg);
        return;
      }
      setSavedOk(true);
      window.setTimeout(() => setSavedOk(false), 2500);
      await load();
    } catch {
      setError("שגיאת רשת");
    } finally {
      setSaving(false);
    }
  }

  return {
    loading,
    saving,
    error,
    savedOk,
    enabled,
    setEnabled,
    showDraftSuggestionsInInbox,
    setShowDraftSuggestionsInInbox,
    welcomeMessage,
    setWelcomeMessage,
    questionsLines,
    setQuestionsLines,
    finalAction,
    setFinalAction,
    websiteUrl,
    setWebsiteUrl,
    productLinkEnabled,
    setProductLinkEnabled,
    productLinkUrl,
    setProductLinkUrl,
    productLinkIntro,
    setProductLinkIntro,
    workMode,
    setWorkMode,
    boundaries,
    setBoundaries,
    parsedQuestions,
    finalActionLabels,
    finalActionPreviewText,
    handleSave,
  };
}

type EditorState = ReturnType<typeof useBotSettingsEditorState>;

const builderScreenStyle: CSSProperties = {
  maxWidth: BUILDER_SHELL_MAX_WIDTH,
  minHeight: "100dvh",
  margin: "0 auto",
  padding: "0",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
};

export function BotSettingsEditor({ area }: { area: BotSettingsArea }) {
  const state = useBotSettingsEditorState();
  const meta = areaMeta(area);

  const pageStyle: CSSProperties = {
    minHeight: "100dvh",
    background: TOKEN.surface.page,
  };

  const shellStyle: CSSProperties = {
    maxWidth: BUILDER_SHELL_MAX_WIDTH,
    margin: "0 auto",
    padding: "0 0 100px",
    boxSizing: "border-box",
  };

  const cardStyle: CSSProperties = {
    background: TOKEN.surface.card,
    border: `1px solid ${TOKEN.border.DEFAULT}`,
    borderRadius: TOKEN.radius.card,
    padding: TOKEN.space.lg,
    boxShadow: TOKEN.shadow.elevated,
    boxSizing: "border-box",
  };

  if (area === "handoff") {
    return <HandoffFlagshipScreen state={state} />;
  }
  if (area === "voice") {
    return (
      <VoiceProfileScreen
        welcomeMessage={state.welcomeMessage}
        onWelcomeChange={state.setWelcomeMessage}
        onSaveWelcome={state.handleSave}
      />
    );
  }
  if (area === "personality") {
    return <PersonalityFlagshipScreen />;
  }
  if (area === "approach") {
    return <ApproachFlagshipScreen />;
  }
  if (area === "goal") {
    return <GoalsFlagshipScreen />;
  }
  if (area === "conversation") {
    return <ConversationFlagshipScreen state={state} />;
  }
  if (area === "knowledge") {
    return <KnowledgeFlagshipScreen state={state} />;
  }
  if (area === "allowed") {
    return <AllowedFlagshipScreen state={state} />;
  }
  if (area === "autonomy") {
    return <AutonomyFlagshipScreen state={state} />;
  }
  if (area === "forbidden") {
    return <ForbiddenPlaceholderScreen />;
  }

  return (
    <div dir="rtl" style={pageStyle}>
      <main style={shellStyle}>
        <AreaHeader
          title={meta.title}
          subtitle={meta.eyebrow}
          backHref="/business/bot"
          backLabel="הבוט שלי"
        />
        {state.loading ? (
          <p style={{ margin: "18px", color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>טוען...</p>
        ) : (
          <div style={{ display: "grid", gap: TOKEN.space.lg, padding: "14px 18px 0" }}>
            {renderArea(area, state, cardStyle)}
            {isSavableArea(area) ? <SavePanel state={state} /> : null}
          </div>
        )}
      </main>
    </div>
  );
}

function isSavableArea(area: BotSettingsArea): boolean {
  // personality/approach/voice are handled by their own profile-backed screens
  // (early-returned before this generic path). Only memory/learning remain
  // backend-less placeholders with no save panel.
  return !["memory", "learning"].includes(area);
}

function renderArea(area: BotSettingsArea, state: EditorState, cardStyle: CSSProperties) {
  switch (area) {
    case "goal":
      return <GoalSection state={state} cardStyle={cardStyle} />;
    case "voice":
      return <WelcomeSection state={state} cardStyle={cardStyle} />;
    case "conversation":
      return <QuestionsSection state={state} cardStyle={cardStyle} />;
    case "knowledge":
      return <ProductLinkSection state={state} cardStyle={cardStyle} />;
    case "autonomy":
      return <AutonomySection state={state} cardStyle={cardStyle} />;
    case "allowed":
      return <FinalActionSection state={state} cardStyle={cardStyle} />;
    case "handoff":
      return <HandoffSection state={state} cardStyle={cardStyle} />;
    case "personality":
      return <SoonSection cardStyle={cardStyle} title="האופי שלו" body="אופי, traits וטון אישיות עדיין לא מחוברים לבוט החי." />;
    case "approach":
      return <SoonSection cardStyle={cardStyle} title="הגישה שלו" body="מכירה עדינה, יוזמה והתנגדויות ידרשו config ו-runtime נפרדים." />;
    case "memory":
      return <SoonSection cardStyle={cardStyle} title="מה הוא זוכר על לקוחות" body="אין זיכרון לקוח פעיל בשיחות בשלב הזה." />;
    case "learning":
      return <SoonSection cardStyle={cardStyle} title="איך הוא משתפר" body="אין מנוע המלצות או למידה מאישורים בשלב 1." />;
  }
}

function SavePanel({ state }: { state: EditorState }) {
  return (
    <section style={{ display: "grid", gap: 10 }}>
      {state.error ? (
        <div role="alert" style={{ background: TOKEN.semantic.urgent.bgSoft, color: TOKEN.semantic.urgent.ink, padding: "12px 14px", borderRadius: TOKEN.radius.input, fontSize: TOKEN.font.body }}>
          {state.error}
        </div>
      ) : null}
      {state.savedOk ? (
        <div style={{ fontSize: TOKEN.font.body, color: TOKEN.semantic.success.ink, fontWeight: TOKEN.weight.semibold }}>
          נשמר בהצלחה
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => void state.handleSave()}
        disabled={state.saving}
        style={{
          width: "100%",
          padding: "16px 20px",
          borderRadius: TOKEN.radius.card,
          border: TOKEN.action.primary.border,
          background: state.saving ? TOKEN.ink.meta : TOKEN.action.primary.background,
          boxShadow: state.saving ? TOKEN.shadow.none : TOKEN.action.primary.shadowSoft,
          color: TOKEN.ink.inverse,
          fontSize: TOKEN.font.title,
          fontWeight: TOKEN.weight.bold,
          cursor: state.saving ? "not-allowed" : "pointer",
          minHeight: 52,
        }}
      >
        {state.saving ? "שומר..." : "שמור שינויים"}
      </button>
    </section>
  );
}

function GoalSection({ state, cardStyle }: { state: EditorState; cardStyle: CSSProperties }) {
  return (
    <section style={cardStyle}>
      <h2 style={sectionTitle}>מטרה בשלב 1</h2>
      <p style={sectionHint}>
        אין Goal Library חי. כרגע המטרה נגזרת ממצב העבודה, שאלות השיחה, ופעולת הסיום הקיימת.
      </p>
      <WorkModeControls state={state} />
    </section>
  );
}

function WelcomeSection({ state, cardStyle }: { state: EditorState; cardStyle: CSSProperties }) {
  return (
    <section style={cardStyle}>
      <h2 style={sectionTitle}>איך הבוט מקבל לקוחות</h2>
      <p style={sectionHint}>זה המשפט הראשון שהלקוח רואה — קצר, חם וברור.</p>
      <label style={labelWrap}>
        <span style={labelStyle}>הודעת פתיחה</span>
        <textarea
          value={state.welcomeMessage}
          onChange={(e) => state.setWelcomeMessage(e.target.value)}
          rows={5}
          placeholder="לדוגמה: היי! איך אפשר לעזור היום?"
          style={{ ...inputStyle, resize: "vertical", minHeight: 120 }}
        />
      </label>
    </section>
  );
}

function QuestionsSection({ state, cardStyle }: { state: EditorState; cardStyle: CSSProperties }) {
  return (
    <section style={cardStyle}>
      <h2 style={sectionTitle}>מה הבוט שואל</h2>
      <p style={sectionHint}>
        שורה אחת לכל שאלה. זה נשאר מנגנון legacy {"{items}"}; אין חיבור חי ל-Structured Fields v2 בשלב הזה.
      </p>
      <label style={labelWrap}>
        <span style={labelStyle}>שאלות legacy</span>
        <textarea
          value={state.questionsLines}
          onChange={(e) => state.setQuestionsLines(e.target.value)}
          rows={7}
          placeholder={"לדוגמה:\nמה השם שלך?\nמתי נוח לך?"}
          style={{ ...inputStyle, resize: "vertical", minHeight: 160 }}
        />
      </label>
    </section>
  );
}

function FinalActionSection({ state, cardStyle }: { state: EditorState; cardStyle: CSSProperties }) {
  return (
    <section style={cardStyle}>
      <h2 style={sectionTitle}>מה קורה אחרי שהפרטים נאספו</h2>
      <p style={sectionHint}>בוחרים מה הבוט עושה ברגע שמסיים את השאלות.</p>
      <div style={{ display: "grid", gap: 14 }}>
        <label style={labelWrap}>
          <span style={labelStyle}>פעולה לאחר השאלות</span>
          <select
            value={state.finalAction}
            onChange={(e) => state.setFinalAction(e.target.value as FinalActionValue)}
            style={{ ...inputStyle, minHeight: 44 }}
          >
            {FINAL_ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </label>
        {state.finalAction === "SEND_LINK" ? (
          <label style={labelWrap}>
            <span style={labelStyle}>כתובת קישור (URL)</span>
            <input
              type="url"
              inputMode="url"
              dir="ltr"
              value={state.websiteUrl}
              onChange={(e) => state.setWebsiteUrl(e.target.value)}
              placeholder="https://..."
              style={{ ...inputStyle, minHeight: 44 }}
            />
          </label>
        ) : null}
        <p style={{ margin: 0, fontSize: TOKEN.font.meta, color: TOKEN.ink.meta }}>
          הבוט יפעל לפי: <strong style={{ color: TOKEN.ink.secondary }}>{state.finalActionLabels[state.finalAction] ?? state.finalAction}</strong>
        </p>
      </div>
    </section>
  );
}

function ProductLinkSection({ state, cardStyle }: { state: EditorState; cardStyle: CSSProperties }) {
  return (
    <section style={cardStyle}>
      <h2 style={sectionTitle}>קישור מהיר לקטלוג</h2>
      <p style={sectionHint}>
        כשלקוח מבקש לראות מוצרים — chip באינבוקס ימלא את ההודעה עם הקישור שלך. אתה בודק ושולח בלחיצה אחת.
      </p>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 12, fontSize: TOKEN.font.body, color: TOKEN.ink.primary, cursor: "pointer", lineHeight: 1.45, marginBottom: 16 }}>
        <input
          type="checkbox"
          checked={state.productLinkEnabled}
          onChange={(e) => state.setProductLinkEnabled(e.target.checked)}
          style={{ width: 20, height: 20, marginTop: 2, flexShrink: 0 }}
        />
        <span>הצע קישור לקטלוג באינבוקס</span>
      </label>
      <label style={{ ...labelWrap, marginBottom: 14 }}>
        <span style={labelStyle}>כתובת דף (URL)</span>
        <input
          type="url"
          inputMode="url"
          dir="ltr"
          value={state.productLinkUrl}
          onChange={(e) => state.setProductLinkUrl(e.target.value)}
          placeholder="https://..."
          style={{ ...inputStyle, minHeight: 44 }}
        />
      </label>
      <label style={labelWrap}>
        <span style={labelStyle}>משפט קצר לפני הקישור (אופציונלי)</span>
        <textarea
          value={state.productLinkIntro}
          onChange={(e) => state.setProductLinkIntro(e.target.value)}
          rows={2}
          placeholder="לדוגמה: הנה הקישור לקטלוג שלנו"
          style={{ ...inputStyle, resize: "vertical", minHeight: 72 }}
        />
      </label>
    </section>
  );
}

function ConversationFlagshipScreen({ state }: { state: EditorState }) {
  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={builderScreenStyle}>
        <AreaHeader
          title="איך השיחה עובדת"
          subtitle="השאלות שהבוט מכין לפי סדר, במנגנון legacy הקיים."
          backHref="/business/bot"
          backLabel="הבוט שלי"
        />
        {state.loading ? (
          <p style={{ margin: "18px", color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>טוען...</p>
        ) : (
          <>
            <section style={{ ...areaPanelStyle, padding: "16px 0" }}>
              <BuilderTextAreaField
                label="שאלות legacy"
                hint="שורה אחת לכל שאלה. נשמר באותו מבנה {items} שקיים היום."
                value={state.questionsLines}
                onChange={state.setQuestionsLines}
                rows={7}
                placeholder={"לדוגמה:\nמה השם שלך?\nמתי נוח לך?"}
              />
            </section>
            <GuardNote>
              Structured Fields v2 לא מחובר כמקור חי במסך הזה. השמירה נשארת על שאלות legacy בלבד.
            </GuardNote>
            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void state.handleSave()}
              saving={state.saving}
              saved={state.savedOk}
              error={state.error}
              saveLabel="שמור"
            />
          </>
        )}
      </main>
    </div>
  );
}

function KnowledgeFlagshipScreen({ state }: { state: EditorState }) {
  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={builderScreenStyle}>
        <AreaHeader
          title="מה הוא יודע"
          subtitle="בשלב הזה הידע הפעיל הוא קישור קטלוג/דף אחד לשימוש באינבוקס."
          backHref="/business/bot"
          backLabel="הבוט שלי"
        />
        {state.loading ? (
          <p style={{ margin: "18px", color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>טוען...</p>
        ) : (
          <>
            <section style={areaPanelStyle}>
              <ToggleRow
                label="הצע קישור לקטלוג באינבוקס"
                hint="כשלקוח מבקש לראות מוצרים, האינבוקס יוכל למלא הודעה עם הקישור."
                checked={state.productLinkEnabled}
                onChange={state.setProductLinkEnabled}
              />
              <div style={{ display: "grid", gap: 16, padding: "16px 0" }}>
                <BuilderTextField
                  label="כתובת דף (URL)"
                  value={state.productLinkUrl}
                  onChange={state.setProductLinkUrl}
                  placeholder="https://..."
                  type="url"
                  inputMode="url"
                  dir="ltr"
                />
                <BuilderTextAreaField
                  label="משפט קצר לפני הקישור"
                  hint="אופציונלי. יופיע לפני הקישור בהודעה המוצעת."
                  value={state.productLinkIntro}
                  onChange={state.setProductLinkIntro}
                  rows={2}
                  placeholder="לדוגמה: הנה הקישור לקטלוג שלנו"
                />
              </div>
            </section>
            <GuardNote>
              זה לא קטלוג חי ולא מקור ידע חדש. הבוט משתמש רק בקישור שהוגדר כאן.
            </GuardNote>
            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void state.handleSave()}
              saving={state.saving}
              saved={state.savedOk}
              error={state.error}
              saveLabel="שמור"
            />
          </>
        )}
      </main>
    </div>
  );
}

function AllowedFlagshipScreen({ state }: { state: EditorState }) {
  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={builderScreenStyle}>
        <AreaHeader
          title="מה הוא רשאי לעשות"
          subtitle="בוחרים את פעולת הסיום הקיימת אחרי שהפרטים נאספו."
          backHref="/business/bot"
          backLabel="הבוט שלי"
        />
        {state.loading ? (
          <p style={{ margin: "18px", color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>טוען...</p>
        ) : (
          <>
            <section style={areaPanelStyle}>
              {FINAL_ACTIONS.map((action) => (
                <ChoiceRow
                  key={action.value}
                  label={action.label}
                  hint={finalActionHint(action.value)}
                  selected={state.finalAction === action.value}
                  onSelect={() => state.setFinalAction(action.value)}
                />
              ))}
              {state.finalAction === "SEND_LINK" ? (
                <div style={{ padding: "16px 0" }}>
                  <BuilderTextField
                    label="כתובת קישור (URL)"
                    value={state.websiteUrl}
                    onChange={state.setWebsiteUrl}
                    placeholder="https://..."
                    type="url"
                    inputMode="url"
                    dir="ltr"
                  />
                </div>
              ) : null}
            </section>
            <GuardNote>
              הערך שנשמר נשאר אותה פעולת סיום קיימת. אין כאן Action Catalog חדש.
            </GuardNote>
            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void state.handleSave()}
              saving={state.saving}
              saved={state.savedOk}
              error={state.error}
              saveLabel="שמור"
            />
          </>
        )}
      </main>
    </div>
  );
}

function AutonomyFlagshipScreen({ state }: { state: EditorState }) {
  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={builderScreenStyle}>
        <AreaHeader
          title="כמה עצמאות נתת לו"
          subtitle="המצב האמיתי בקוד הוא draft-only: רמות 1-2 בלבד."
          backHref="/business/bot"
          backLabel="הבוט שלי"
        />
        {state.loading ? (
          <p style={{ margin: "18px", color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>טוען...</p>
        ) : (
          <>
            <section style={{ ...areaPanelStyle, padding: "16px 0" }}>
              <div style={{ margin: "0 18px 14px" }}>
                <h2 style={sectionTitle}>מצב עבודה</h2>
                <p style={{ ...sectionHint, marginBottom: 0 }}>
                  בחר אם הבוט כבוי, או מכין טיוטות שאתה מאשר ושולח.
                </p>
              </div>
              <div style={{ margin: "0 18px" }}>
                <WorkModeControls state={state} />
              </div>
              <div style={{ display: "grid", gap: 10, margin: "16px 18px 0" }}>
                {[
                  { n: "1", title: "ידני — אני עונה בעצמי", active: state.workMode === "MANUAL", soon: false },
                  { n: "2", title: "טיוטות חכמות — הבוט מכין, אני שולח", active: state.workMode !== "MANUAL", soon: false },
                  { n: "3", title: "מבצע אחרי אישור", active: false, soon: true },
                  { n: "4", title: "מבצע לבד", active: false, soon: true },
                ].map((level) => (
                  <div key={level.n} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: TOKEN.radius.input, border: "1px solid " + (level.active ? TOKEN.brand.softBorder : TOKEN.border.DEFAULT), background: level.active ? TOKEN.brand.soft : TOKEN.surface.card, opacity: level.soon ? 0.72 : 1 }}>
                    <span style={{ fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>{level.n}</span>
                    <span style={{ flex: 1, fontSize: TOKEN.font.body, color: TOKEN.ink.secondary }}>{level.title}</span>
                    <span style={chipStyle(level.active ? "ready" : level.soon ? "soon" : "edit")}>{level.soon ? "בקרוב" : level.active ? "פעיל" : "זמין"}</span>
                  </div>
                ))}
              </div>
            </section>
            <GuardNote>
              רמות ביצוע אחרי אישור וביצוע לבד אינן פעילות בשלב הזה.
            </GuardNote>
            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void state.handleSave()}
              saving={state.saving}
              saved={state.savedOk}
              error={state.error}
              saveLabel="שמור"
            />
          </>
        )}
      </main>
    </div>
  );
}

function ForbiddenPlaceholderScreen() {
  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={builderScreenStyle}>
        <AreaHeader
          title="מה אסור לו"
          subtitle="גבולות אסור נפרדים עדיין לא מחוברים לבוט החי."
          backHref="/business/bot"
          backLabel="הבוט שלי"
        />
        <section style={{ ...areaPanelStyle, padding: "16px 0" }}>
          <div style={{ margin: "0 18px" }}>
            <span style={chipStyle("soon")}>בקרוב</span>
            <h2 style={{ ...sectionTitle, marginTop: 12 }}>אין טופס פעיל בשלב הזה</h2>
            <p style={{ ...sectionHint, marginBottom: 0 }}>
              מדיניות ה-draft-only וה-guardrails ממשיכים לפעול ברקע, אבל אין כאן state נפרד לעריכת איסורים.
            </p>
          </div>
        </section>
        <GuardNote>
          Dubiz לא נותן לבוט להמציא מידע או להתחייב מעבר למה שמוגדר, גם בלי מסך איסורים פעיל.
        </GuardNote>
      </main>
    </div>
  );
}

function finalActionHint(action: FinalActionValue): string {
  switch (action) {
    case "LEAVE_MESSAGE":
      return "הבוט מסיים בהשארת הודעה רגועה.";
    case "COLLECT_DETAILS":
      return "הבוט מבקש את הפרטים הדרושים להמשך טיפול.";
    case "SEND_LINK":
      return "הבוט מציע קישור שהוגדר כאן, בלי לשלוח לבד.";
    case "ESCALATE":
      return "הבוט מסמן שהשיחה עוברת לנציג/בעל העסק.";
  }
}
function HandoffFlagshipScreen({ state }: { state: EditorState }) {
  function setBoundary(key: keyof BotBoundaryPresets, checked: boolean) {
    state.setBoundaries((b) => ({ ...b, [key]: checked }));
  }

  function setThreshold(value: number) {
    state.setBoundaries((b) => ({
      ...b,
      afterMessageCountThreshold: Math.min(30, Math.max(3, value)),
    }));
  }

  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main
        style={{
          maxWidth: BUILDER_SHELL_MAX_WIDTH,
          minHeight: "100dvh",
          margin: "0 auto",
          padding: "0 0 0",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <AreaHeader
          title="מתי מעביר אליי"
          subtitle="כאן קובעים מתי הבוט מפסיק להכין טיוטות ומעביר את השיחה אליך."
          backHref="/business/bot"
          backLabel="הבוט שלי"
        />

        {state.loading ? (
          <p style={{ margin: "18px", color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>טוען...</p>
        ) : (
          <>
            <section style={areaPanelStyle}>
              {BOT_BOUNDARY_OPTIONS.map((opt) => {
                const checked = state.boundaries[opt.key] === true;
                return (
                  <ToggleRow
                    key={opt.key}
                    label={opt.label}
                    hint={opt.hint}
                    checked={checked}
                    onChange={(next) => setBoundary(opt.key, next)}
                  >
                    {opt.isThreshold && checked ? (
                      <Stepper
                        value={state.boundaries.afterMessageCountThreshold}
                        min={3}
                        max={30}
                        label="הודעות מהלקוח"
                        onChange={setThreshold}
                      />
                    ) : null}
                  </ToggleRow>
                );
              })}
            </section>

            <GuardNote>
              גם בלי הגדרה — כשהבוט לא בטוח, הוא יעדיף להעביר אליך מאשר לנחש.
            </GuardNote>

            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void state.handleSave()}
              saving={state.saving}
              saved={state.savedOk}
              error={state.error}
              saveLabel="שמור"
            />
          </>
        )}
      </main>
    </div>
  );
}
function HandoffSection({ state, cardStyle }: { state: EditorState; cardStyle: CSSProperties }) {
  return (
    <section style={cardStyle}>
      <h2 style={sectionTitle}>מתי הבוט מעביר אליך את השיחה</h2>
      <p style={sectionHint}>
        כשהגבול מופעל — הבוט לא יכין עוד טיוטות פתיחה לשיחה הזו, ותמשיך אתה מהאינבוקס.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {BOT_BOUNDARY_OPTIONS.map((opt) => (
          <label key={opt.key} style={{ display: "flex", alignItems: "flex-start", gap: 12, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={opt.key === "afterMessageCountThreshold" ? state.boundaries.afterMessageCount : state.boundaries[opt.key as keyof BotBoundaryPresets] === true}
              onChange={(e) => {
                if (opt.key === "afterMessageCountThreshold") {
                  state.setBoundaries((b) => ({ ...b, afterMessageCount: e.target.checked }));
                  return;
                }
                state.setBoundaries((b) => ({ ...b, [opt.key]: e.target.checked }));
              }}
              style={{ width: 18, height: 18, marginTop: 3, flexShrink: 0 }}
            />
            <span>
              <span style={{ display: "block", fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.body }}>{opt.label}</span>
              <span style={{ display: "block", fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, marginTop: 2 }}>{opt.hint}</span>
              {opt.isThreshold && state.boundaries.afterMessageCount ? (
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="number"
                    min={3}
                    max={30}
                    value={state.boundaries.afterMessageCountThreshold}
                    onChange={(e) => state.setBoundaries((b) => ({ ...b, afterMessageCountThreshold: Number(e.target.value) || b.afterMessageCountThreshold }))}
                    style={{ width: 56, padding: "6px 8px", borderRadius: TOKEN.radius.input, border: `1px solid ${TOKEN.border.hover}`, fontSize: TOKEN.font.body }}
                  />
                  <span style={{ fontSize: TOKEN.font.meta, color: TOKEN.ink.secondary }}>הודעות מהלקוח</span>
                </div>
              ) : null}
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

function AutonomySection({ state, cardStyle }: { state: EditorState; cardStyle: CSSProperties }) {
  return (
    <section style={{ ...cardStyle, background: TOKEN.surface.inset, borderStyle: "dashed", borderColor: TOKEN.border.hover }}>
      <h2 style={sectionTitle}>המצב האמיתי: draft-only</h2>
      <p style={sectionHint}>
        הרמה הפעילה בקוד היא 1-2 בלבד. ביצוע אחרי אישור וביצוע לבד מוצגים כעתידיים ולא פעילים.
      </p>
      <WorkModeControls state={state} />
      <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
        {[
          { n: "1", title: "ידני — אני עונה בעצמי", active: state.workMode === "MANUAL", soon: false },
          { n: "2", title: "טיוטות חכמות — הבוט מכין, אני שולח", active: state.workMode !== "MANUAL", soon: false },
          { n: "3", title: "מבצע אחרי אישור", active: false, soon: true },
          { n: "4", title: "מבצע לבד", active: false, soon: true },
        ].map((level) => (
          <div key={level.n} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: TOKEN.radius.input, border: "1px solid " + (level.active ? TOKEN.brand.softBorder : TOKEN.border.DEFAULT), background: level.active ? TOKEN.brand.soft : TOKEN.surface.card, opacity: level.soon ? 0.72 : 1 }}>
            <span style={{ fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>{level.n}</span>
            <span style={{ flex: 1, fontSize: TOKEN.font.body, color: TOKEN.ink.secondary }}>{level.title}</span>
            <span style={chipStyle(level.active ? "ready" : level.soon ? "soon" : "edit")}>{level.soon ? "בקרוב" : level.active ? "פעיל" : "זמין"}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkModeControls({ state }: { state: EditorState }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {BOT_WORK_MODE_OPTIONS_ACTIVE.map((opt) => {
        const selected = state.workMode === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => {
              state.setWorkMode(opt.id);
              const patch = settingsPatchForWorkMode(opt.id, {
                version: 1,
                workMode: opt.id,
                boundaries: state.boundaries,
              });
              state.setEnabled(patch.enabled);
              state.setShowDraftSuggestionsInInbox(patch.showDraftSuggestionsInInbox);
            }}
            style={{
              textAlign: "right",
              width: "100%",
              border: selected ? `2px solid ${TOKEN.brand.mid}` : `1px solid ${TOKEN.border.DEFAULT}`,
              borderRadius: TOKEN.radius.card,
              padding: "14px 16px",
              background: selected ? TOKEN.brand.soft : TOKEN.surface.card,
              cursor: "pointer",
            }}
          >
            <div style={{ fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.body, color: TOKEN.ink.primary }}>{opt.title}</div>
            <div style={{ fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, marginTop: 4, lineHeight: 1.45 }}>{opt.description}</div>
            <div style={{ fontSize: TOKEN.font.meta, color: selected ? TOKEN.brand.mid : TOKEN.ink.meta, marginTop: 6, fontWeight: TOKEN.weight.semibold }}>{opt.trustLine}</div>
          </button>
        );
      })}
    </div>
  );
}

function SoonSection({ cardStyle, title, body }: { cardStyle: CSSProperties; title: string; body: string }) {
  return (
    <section style={{ ...cardStyle, background: TOKEN.surface.inset, borderStyle: "dashed", borderColor: TOKEN.border.hover }}>
      <span style={chipStyle("soon")}>בקרוב</span>
      <h2 style={{ ...sectionTitle, marginTop: 12 }}>{title}</h2>
      <p style={{ ...sectionHint, marginBottom: 0 }}>{body}</p>
      <p style={{ margin: "12px 0 0", fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, lineHeight: 1.45 }}>
        אין טופס פעיל, אין backend חדש, ואין השפעה על הבוט החי.
      </p>
    </section>
  );
}

const labelWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const labelStyle: CSSProperties = {
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
  color: TOKEN.ink.secondary,
};

const inputStyle: CSSProperties = {
  padding: "8px 10px",
  borderRadius: TOKEN.radius.input,
  border: `1px solid ${TOKEN.border.hover}`,
  fontSize: TOKEN.font.body,
  fontFamily: "inherit",
};

const sectionTitle: CSSProperties = {
  margin: "0 0 6px",
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
  color: TOKEN.ink.primary,
  lineHeight: 1.3,
};

const sectionHint: CSSProperties = {
  margin: "0 0 16px",
  fontSize: TOKEN.font.meta,
  color: TOKEN.ink.muted,
  lineHeight: 1.55,
};

function chipStyle(tone: "ready" | "edit" | "soon"): CSSProperties {
  return {
    display: "inline-flex",
    border: "1px solid",
    borderRadius: TOKEN.radius.pill,
    padding: "4px 9px",
    fontSize: TOKEN.font.caption,
    fontWeight: TOKEN.weight.semibold,
    color: tone === "ready" ? TOKEN.semantic.success.ink : tone === "edit" ? TOKEN.brand.mid : TOKEN.ink.muted,
    background: tone === "ready" ? TOKEN.semantic.success.bgSoft : tone === "edit" ? TOKEN.brand.soft : TOKEN.surface.card,
    borderColor: tone === "ready" ? TOKEN.semantic.success.border : tone === "edit" ? TOKEN.brand.softBorder : TOKEN.border.DEFAULT,
  };
}
