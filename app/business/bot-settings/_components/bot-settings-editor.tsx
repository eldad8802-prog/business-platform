"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { TOKEN } from "@/lib/design/bot-theme";
import { isValidProductLinkUrl } from "@/lib/inbox-view/product-link-capability";
import {
  BOT_BOUNDARY_OPTIONS,
  BOT_WORK_MODE_OPTIONS_ACTIVE,
  DEFAULT_BOT_BOUNDARIES,
  DEFAULT_BOT_FORBIDDEN,
  parseBotControlHandoffRules,
  resolveBotWorkMode,
  settingsPatchForWorkMode,
  type BotBoundaryPresets,
  type BotForbiddenPresets,
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
import { KnowledgeProfileScreen } from "./bot-knowledge-screen";
import { MemoryPolicyScreen } from "./bot-memory-screen";
import { LearningScreen } from "./bot-learning-screen";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";
import { botOptionLabel, localizeKeyOptions, localizeWorkModes } from "./bot-i18n";

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

function areaMeta(area: BotSettingsArea, t: Translator): { title: string; eyebrow: string } {
  switch (area) {
    case "goal":
      return { title: t("content.bot.editor.meta.goal.title"), eyebrow: t("content.bot.editor.meta.goal.eyebrow") };
    case "personality":
      return { title: t("content.bot.editor.meta.personality.title"), eyebrow: t("content.bot.editor.meta.personality.eyebrow") };
    case "voice":
      return { title: t("content.bot.editor.meta.voice.title"), eyebrow: t("content.bot.editor.meta.voice.eyebrow") };
    case "conversation":
      return { title: t("content.bot.editor.meta.conversation.title"), eyebrow: t("content.bot.editor.meta.conversation.eyebrow") };
    case "approach":
      return { title: t("content.bot.editor.meta.approach.title"), eyebrow: t("content.bot.editor.meta.approach.eyebrow") };
    case "knowledge":
      return { title: t("content.bot.editor.meta.knowledge.title"), eyebrow: t("content.bot.editor.meta.knowledge.eyebrow") };
    case "memory":
      return { title: t("content.bot.editor.meta.memory.title"), eyebrow: t("content.bot.editor.meta.memory.eyebrow") };
    case "autonomy":
      return { title: t("content.bot.editor.meta.autonomy.title"), eyebrow: t("content.bot.editor.meta.autonomy.eyebrow") };
    case "allowed":
      return { title: t("content.bot.editor.meta.allowed.title"), eyebrow: t("content.bot.editor.meta.allowed.eyebrow") };
    case "forbidden":
      return { title: t("content.bot.editor.meta.forbidden.title"), eyebrow: t("content.bot.editor.meta.forbidden.eyebrow") };
    case "handoff":
      return { title: t("content.bot.editor.meta.handoff.title"), eyebrow: t("content.bot.editor.meta.handoff.eyebrow") };
    case "learning":
      return { title: t("content.bot.editor.meta.learning.title"), eyebrow: t("content.bot.editor.meta.learning.eyebrow") };
  }
}

export function useBotSettingsEditorState() {
  const { t } = useI18n();
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
  const [forbidden, setForbidden] = useState<BotForbiddenPresets>({
    ...DEFAULT_BOT_FORBIDDEN,
  });

  const parsedQuestions = useMemo(() => {
    return questionsLines
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }, [questionsLines]);

  const finalActionLabels = useMemo(
    () => Object.fromEntries(FINAL_ACTIONS.map((a) => [a.value, botOptionLabel(t, "finalAction", a.value, a.label)])),
    [t]
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
      setForbidden(rules.forbidden ?? { ...DEFAULT_BOT_FORBIDDEN });
      setWelcomeMessage(s.welcomeMessage ?? "");
      setQuestionsLines(questionsJsonToLines(s.questions));
      setFinalAction(normalizeFinalAction(s.finalAction));
      setWebsiteUrl(parseWebsiteUrl(s.finalActionPayload));
      setProductLinkEnabled(!!s.productLinkEnabled);
      setProductLinkUrl((s.productLinkUrl ?? "").trim());
      setProductLinkIntro(s.productLinkIntro ?? "");
    } catch {
      setError(t("content.bot.common.errors.loadSettings"));
    } finally {
      setLoading(false);
    }
  }, [t]);

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
      setError(t("content.bot.common.errors.welcomeTooLong"));
      setSaving(false);
      return;
    }
    if (finalAction === "SEND_LINK") {
      const url = websiteUrl.trim();
      if (!url) {
        setError(t("content.bot.common.errors.sendLinkMissingUrl"));
        setSaving(false);
        return;
      }
    }

    if (productLinkEnabled) {
      const pl = productLinkUrl.trim();
      if (!isValidProductLinkUrl(pl)) {
        setError(t("content.bot.common.errors.productLinkInvalid"));
        setSaving(false);
        return;
      }
    }

    const questions = linesToQuestionsJson(questionsLines);

    const modePatch = settingsPatchForWorkMode(workMode, {
      version: 1,
      workMode,
      boundaries,
      forbidden,
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
        let msg = t("content.bot.common.saveFailed");
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
      setError(t("content.bot.common.networkError"));
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
    forbidden,
    setForbidden,
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
  const { t } = useI18n();
  const state = useBotSettingsEditorState();
  const meta = areaMeta(area, t);

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
    return (
      <KnowledgeProfileScreen
        productLinkEnabled={state.productLinkEnabled}
        setProductLinkEnabled={state.setProductLinkEnabled}
        productLinkUrl={state.productLinkUrl}
        setProductLinkUrl={state.setProductLinkUrl}
        productLinkIntro={state.productLinkIntro}
        setProductLinkIntro={state.setProductLinkIntro}
        onSaveSettings={state.handleSave}
      />
    );
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
  if (area === "memory") {
    return <MemoryPolicyScreen />;
  }
  if (area === "learning") {
    return <LearningScreen />;
  }

  return (
    <div style={pageStyle}>
      <main style={shellStyle}>
        <AreaHeader
          title={meta.title}
          subtitle={meta.eyebrow}
          backHref="/business/bot"
          backLabel={t("content.bot.common.myBot")}
        />
        {state.loading ? (
          <p style={{ margin: "18px", color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>{t("content.bot.common.loading")}</p>
        ) : (
          <div style={{ display: "grid", gap: TOKEN.space.lg, padding: "14px 18px 0" }}>
            {renderArea(area, state, cardStyle, t)}
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

function renderArea(area: BotSettingsArea, state: EditorState, cardStyle: CSSProperties, t: Translator) {
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
      return <SoonSection cardStyle={cardStyle} title={t("content.bot.editor.meta.personality.title")} body={t("content.bot.editor.soon.personality")} />;
    case "approach":
      return <SoonSection cardStyle={cardStyle} title={t("content.bot.editor.meta.approach.title")} body={t("content.bot.editor.soon.approach")} />;
    case "memory":
      return <SoonSection cardStyle={cardStyle} title={t("content.bot.editor.meta.memory.title")} body={t("content.bot.editor.soon.memory")} />;
    case "learning":
      return <SoonSection cardStyle={cardStyle} title={t("content.bot.editor.meta.learning.title")} body={t("content.bot.editor.soon.learning")} />;
  }
}

function SavePanel({ state }: { state: EditorState }) {
  const { t } = useI18n();
  return (
    <section style={{ display: "grid", gap: 10 }}>
      {state.error ? (
        <div role="alert" style={{ background: TOKEN.semantic.urgent.bgSoft, color: TOKEN.semantic.urgent.ink, padding: "12px 14px", borderRadius: TOKEN.radius.input, fontSize: TOKEN.font.body }}>
          {state.error}
        </div>
      ) : null}
      {state.savedOk ? (
        <div style={{ fontSize: TOKEN.font.body, color: TOKEN.semantic.success.ink, fontWeight: TOKEN.weight.semibold }}>
          {t("content.bot.common.savedSuccess")}
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
        {state.saving ? t("content.bot.common.saving") : t("content.bot.common.saveChanges")}
      </button>
    </section>
  );
}

function GoalSection({ state, cardStyle }: { state: EditorState; cardStyle: CSSProperties }) {
  const { t } = useI18n();
  return (
    <section style={cardStyle}>
      <h2 style={sectionTitle}>{t("content.bot.editor.goalTitle")}</h2>
      <p style={sectionHint}>
        {t("content.bot.editor.goalHint")}
      </p>
      <WorkModeControls state={state} />
    </section>
  );
}

function WelcomeSection({ state, cardStyle }: { state: EditorState; cardStyle: CSSProperties }) {
  const { t } = useI18n();
  return (
    <section style={cardStyle}>
      <h2 style={sectionTitle}>{t("content.bot.common.welcomeTitle")}</h2>
      <p style={sectionHint}>{t("content.bot.common.welcomeHint")}</p>
      <label style={labelWrap}>
        <span style={labelStyle}>{t("content.bot.common.welcomeMessage")}</span>
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
  const { t } = useI18n();
  return (
    <section style={cardStyle}>
      <h2 style={sectionTitle}>{t("content.bot.common.questionsTitle")}</h2>
      <p style={sectionHint}>
        {t("content.bot.editor.questionsLegacyHint")}
      </p>
      <label style={labelWrap}>
        <span style={labelStyle}>{t("content.bot.editor.questionsLegacy")}</span>
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
  const { t } = useI18n();
  return (
    <section style={cardStyle}>
      <h2 style={sectionTitle}>{t("content.bot.common.finalActionTitle")}</h2>
      <p style={sectionHint}>{t("content.bot.common.finalActionHint")}</p>
      <div style={{ display: "grid", gap: 14 }}>
        <label style={labelWrap}>
          <span style={labelStyle}>{t("content.bot.common.finalActionSelect")}</span>
          <select
            value={state.finalAction}
            onChange={(e) => state.setFinalAction(e.target.value as FinalActionValue)}
            style={{ ...inputStyle, minHeight: 44 }}
          >
            {FINAL_ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>{botOptionLabel(t, "finalAction", a.value, a.label)}</option>
            ))}
          </select>
        </label>
        {state.finalAction === "SEND_LINK" ? (
          <label style={labelWrap}>
            <span style={labelStyle}>{t("content.bot.common.linkUrl")}</span>
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
          {t("content.bot.common.botActsBy")} <strong style={{ color: TOKEN.ink.secondary }}>{state.finalActionLabels[state.finalAction] ?? state.finalAction}</strong>
        </p>
      </div>
    </section>
  );
}

function ProductLinkSection({ state, cardStyle }: { state: EditorState; cardStyle: CSSProperties }) {
  const { t } = useI18n();
  return (
    <section style={cardStyle}>
      <h2 style={sectionTitle}>{t("content.bot.common.catalogLinkTitle")}</h2>
      <p style={sectionHint}>
        {t("content.bot.common.catalogLinkHint")}
      </p>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 12, fontSize: TOKEN.font.body, color: TOKEN.ink.primary, cursor: "pointer", lineHeight: 1.45, marginBottom: 16 }}>
        <input
          type="checkbox"
          checked={state.productLinkEnabled}
          onChange={(e) => state.setProductLinkEnabled(e.target.checked)}
          style={{ width: 20, height: 20, marginTop: 2, flexShrink: 0 }}
        />
        <span>{t("content.bot.common.offerCatalogLink")}</span>
      </label>
      <label style={{ ...labelWrap, marginBottom: 14 }}>
        <span style={labelStyle}>{t("content.bot.common.pageUrl")}</span>
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
        <span style={labelStyle}>{t("content.bot.common.linkIntroOptional")}</span>
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
  const { t } = useI18n();
  return (
    <div style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={builderScreenStyle}>
        <AreaHeader
          title={t("content.bot.editor.meta.conversation.title")}
          subtitle={t("content.bot.editor.conversation.subtitle")}
          backHref="/business/bot"
          backLabel={t("content.bot.common.myBot")}
        />
        {state.loading ? (
          <p style={{ margin: "18px", color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>{t("content.bot.common.loading")}</p>
        ) : (
          <>
            <section style={{ ...areaPanelStyle, padding: "16px 0" }}>
              <BuilderTextAreaField
                label={t("content.bot.editor.questionsLegacy")}
                hint={t("content.bot.editor.conversation.fieldHint")}
                value={state.questionsLines}
                onChange={state.setQuestionsLines}
                rows={7}
                placeholder={"לדוגמה:\nמה השם שלך?\nמתי נוח לך?"}
              />
            </section>
            <GuardNote>
              {t("content.bot.editor.conversation.guard")}
            </GuardNote>
            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void state.handleSave()}
              saving={state.saving}
              saved={state.savedOk}
              error={state.error}
              saveLabel={t("content.bot.common.save")}
            />
          </>
        )}
      </main>
    </div>
  );
}

function AllowedFlagshipScreen({ state }: { state: EditorState }) {
  const { t } = useI18n();
  return (
    <div style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={builderScreenStyle}>
        <AreaHeader
          title={t("content.bot.editor.meta.allowed.title")}
          subtitle={t("content.bot.editor.allowed.subtitle")}
          backHref="/business/bot"
          backLabel={t("content.bot.common.myBot")}
        />
        {state.loading ? (
          <p style={{ margin: "18px", color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>{t("content.bot.common.loading")}</p>
        ) : (
          <>
            <section style={areaPanelStyle}>
              {FINAL_ACTIONS.map((action) => (
                <ChoiceRow
                  key={action.value}
                  label={botOptionLabel(t, "finalAction", action.value, action.label)}
                  hint={finalActionHint(action.value, t)}
                  selected={state.finalAction === action.value}
                  onSelect={() => state.setFinalAction(action.value)}
                />
              ))}
              {state.finalAction === "SEND_LINK" ? (
                <div style={{ padding: "16px 0" }}>
                  <BuilderTextField
                    label={t("content.bot.common.linkUrl")}
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
              {t("content.bot.editor.allowed.guard")}
            </GuardNote>
            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void state.handleSave()}
              saving={state.saving}
              saved={state.savedOk}
              error={state.error}
              saveLabel={t("content.bot.common.save")}
            />
          </>
        )}
      </main>
    </div>
  );
}

function AutonomyFlagshipScreen({ state }: { state: EditorState }) {
  const { t } = useI18n();
  return (
    <div style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={builderScreenStyle}>
        <AreaHeader
          title={t("content.bot.editor.meta.autonomy.title")}
          subtitle={t("content.bot.editor.autonomy.subtitle")}
          backHref="/business/bot"
          backLabel={t("content.bot.common.myBot")}
        />
        {state.loading ? (
          <p style={{ margin: "18px", color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>{t("content.bot.common.loading")}</p>
        ) : (
          <>
            <section style={{ ...areaPanelStyle, padding: "16px 0" }}>
              <div style={{ margin: "0 18px 14px" }}>
                <h2 style={sectionTitle}>{t("content.bot.common.workModeTitle")}</h2>
                <p style={{ ...sectionHint, marginBottom: 0 }}>
                  {t("content.bot.common.workModeHint")}
                </p>
              </div>
              <div style={{ margin: "0 18px" }}>
                <WorkModeControls state={state} />
              </div>
              <div style={{ display: "grid", gap: 10, margin: "16px 18px 0" }}>
                {[
                  { n: "1", title: t("content.bot.levels.manual"), active: state.workMode === "MANUAL", soon: false },
                  { n: "2", title: t("content.bot.levels.smart"), active: state.workMode !== "MANUAL", soon: false },
                  { n: "3", title: t("content.bot.levels.afterApproval"), active: false, soon: true },
                  { n: "4", title: t("content.bot.levels.alone"), active: false, soon: true },
                ].map((level) => (
                  <div key={level.n} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: TOKEN.radius.input, border: "1px solid " + (level.active ? TOKEN.brand.softBorder : TOKEN.border.DEFAULT), background: level.active ? TOKEN.brand.soft : TOKEN.surface.card, opacity: level.soon ? 0.72 : 1 }}>
                    <span style={{ fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>{level.n}</span>
                    <span style={{ flex: 1, fontSize: TOKEN.font.body, color: TOKEN.ink.secondary }}>{level.title}</span>
                    <span style={chipStyle(level.active ? "ready" : level.soon ? "soon" : "edit")}>{level.soon ? t("content.bot.common.soon") : level.active ? t("content.bot.common.active") : t("content.bot.common.available")}</span>
                  </div>
                ))}
              </div>
            </section>
            <GuardNote>
              {t("content.bot.editor.autonomy.guard")}
            </GuardNote>
            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void state.handleSave()}
              saving={state.saving}
              saved={state.savedOk}
              error={state.error}
              saveLabel={t("content.bot.common.save")}
            />
          </>
        )}
      </main>
    </div>
  );
}

function ForbiddenPlaceholderScreen() {
  const { t } = useI18n();
  return (
    <div style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={builderScreenStyle}>
        <AreaHeader
          title={t("content.bot.editor.meta.forbidden.title")}
          subtitle={t("content.bot.editor.forbidden.subtitle")}
          backHref="/business/bot"
          backLabel={t("content.bot.common.myBot")}
        />
        <section style={{ ...areaPanelStyle, padding: "16px 0" }}>
          <div style={{ margin: "0 18px" }}>
            <span style={chipStyle("soon")}>{t("content.bot.common.soon")}</span>
            <h2 style={{ ...sectionTitle, marginTop: 12 }}>{t("content.bot.editor.forbidden.noForm")}</h2>
            <p style={{ ...sectionHint, marginBottom: 0 }}>
              {t("content.bot.editor.forbidden.body")}
            </p>
          </div>
        </section>
        <GuardNote>
          {t("content.bot.editor.forbidden.guard")}
        </GuardNote>
      </main>
    </div>
  );
}

function finalActionHint(action: FinalActionValue, t: Translator): string {
  switch (action) {
    case "LEAVE_MESSAGE":
      return t("content.bot.editor.allowed.hints.LEAVE_MESSAGE");
    case "COLLECT_DETAILS":
      return t("content.bot.editor.allowed.hints.COLLECT_DETAILS");
    case "SEND_LINK":
      return t("content.bot.editor.allowed.hints.SEND_LINK");
    case "ESCALATE":
      return t("content.bot.editor.allowed.hints.ESCALATE");
  }
}
function HandoffFlagshipScreen({ state }: { state: EditorState }) {
  const { t } = useI18n();
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
    <div style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
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
          title={t("content.bot.editor.meta.handoff.title")}
          subtitle={t("content.bot.editor.handoff.subtitle")}
          backHref="/business/bot"
          backLabel={t("content.bot.common.myBot")}
        />

        {state.loading ? (
          <p style={{ margin: "18px", color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>{t("content.bot.common.loading")}</p>
        ) : (
          <>
            <section style={areaPanelStyle}>
              {localizeKeyOptions(t, "boundary", BOT_BOUNDARY_OPTIONS).map((opt) => {
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
                        label={t("content.bot.common.messagesFromCustomer")}
                        onChange={setThreshold}
                      />
                    ) : null}
                  </ToggleRow>
                );
              })}
            </section>

            <GuardNote>
              {t("content.bot.editor.handoff.guard")}
            </GuardNote>

            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void state.handleSave()}
              saving={state.saving}
              saved={state.savedOk}
              error={state.error}
              saveLabel={t("content.bot.common.save")}
            />
          </>
        )}
      </main>
    </div>
  );
}
function HandoffSection({ state, cardStyle }: { state: EditorState; cardStyle: CSSProperties }) {
  const { t } = useI18n();
  return (
    <section style={cardStyle}>
      <h2 style={sectionTitle}>{t("content.bot.desk.handoffTitle")}</h2>
      <p style={sectionHint}>
        {t("content.bot.editor.handoff.sectionHint")}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {localizeKeyOptions(t, "boundary", BOT_BOUNDARY_OPTIONS).map((opt) => (
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
                  <span style={{ fontSize: TOKEN.font.meta, color: TOKEN.ink.secondary }}>{t("content.bot.common.messagesFromCustomer")}</span>
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
  const { t } = useI18n();
  return (
    <section style={{ ...cardStyle, background: TOKEN.surface.inset, borderStyle: "dashed", borderColor: TOKEN.border.hover }}>
      <h2 style={sectionTitle}>{t("content.bot.editor.autonomy.realTitle")}</h2>
      <p style={sectionHint}>
        {t("content.bot.editor.autonomy.realHint")}
      </p>
      <WorkModeControls state={state} />
      <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
        {[
          { n: "1", title: t("content.bot.levels.manual"), active: state.workMode === "MANUAL", soon: false },
          { n: "2", title: t("content.bot.levels.smart"), active: state.workMode !== "MANUAL", soon: false },
          { n: "3", title: t("content.bot.levels.afterApproval"), active: false, soon: true },
          { n: "4", title: t("content.bot.levels.alone"), active: false, soon: true },
        ].map((level) => (
          <div key={level.n} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: TOKEN.radius.input, border: "1px solid " + (level.active ? TOKEN.brand.softBorder : TOKEN.border.DEFAULT), background: level.active ? TOKEN.brand.soft : TOKEN.surface.card, opacity: level.soon ? 0.72 : 1 }}>
            <span style={{ fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>{level.n}</span>
            <span style={{ flex: 1, fontSize: TOKEN.font.body, color: TOKEN.ink.secondary }}>{level.title}</span>
            <span style={chipStyle(level.active ? "ready" : level.soon ? "soon" : "edit")}>{level.soon ? t("content.bot.common.soon") : level.active ? t("content.bot.common.active") : t("content.bot.common.available")}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkModeControls({ state }: { state: EditorState }) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {localizeWorkModes(t, BOT_WORK_MODE_OPTIONS_ACTIVE).map((opt) => {
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
              textAlign: "start",
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
  const { t } = useI18n();
  return (
    <section style={{ ...cardStyle, background: TOKEN.surface.inset, borderStyle: "dashed", borderColor: TOKEN.border.hover }}>
      <span style={chipStyle("soon")}>{t("content.bot.common.soon")}</span>
      <h2 style={{ ...sectionTitle, marginTop: 12 }}>{title}</h2>
      <p style={{ ...sectionHint, marginBottom: 0 }}>{body}</p>
      <p style={{ margin: "12px 0 0", fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, lineHeight: 1.45 }}>
        {t("content.bot.editor.soon.footnote")}
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
