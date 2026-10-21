"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import PageHeader from "@/components/ui/page-header";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import { TOKEN } from "@/lib/design/bot-theme";
import { LAYOUT } from "@/lib/design/tokens";
import { useMediaQuery } from "@/lib/ui/use-breakpoint";
import desk from "./bot-desk.module.css";
import { useI18n } from "@/components/i18n/I18nProvider";
import { botOptionLabel, localizeKeyOptions, localizeWorkModes } from "./_components/bot-i18n";

/** The shell's desktop tier — where its navigation becomes a sidebar. */
const SHELL_DESKTOP_MIN = `(min-width: ${LAYOUT.bp.expanded}px)`;
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

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

// FINAL_ACTIONS now sourced from the canonical FinalAction SoT (imported above
// as the { value, label } option list). Same values, labels, and order.
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

function questionsJsonToLines(questions: unknown): string {
  if (!questions || typeof questions !== "object") return "";
  const items = (questions as { items?: unknown }).items;
  if (!Array.isArray(items)) return "";
  return items
    .filter((item): item is string => typeof item === "string")
    .join("\n");
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
  if (value && allowed.has(value)) {
    return value as FinalActionValue;
  }
  return "LEAVE_MESSAGE";
}

export default function BusinessBotSettingsPage() {
  const { t, dir } = useI18n();
  // Focused bot builder with its own sticky action bars — hide the app's fixed
  // bottom nav so it never overlaps the save controls. From the shell's desktop
  // tier the navigation is a sidebar, which cannot overlap them, so it stays —
  // the same rule the bot hub uses.
  const isDesktop = useMediaQuery(SHELL_DESKTOP_MIN);
  useHideShellChrome(!isDesktop);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [showDraftSuggestionsInInbox, setShowDraftSuggestionsInInbox] =
    useState(false);
  const [welcomeMessage, setWelcomeMessage] = useState("");
  const [questionsLines, setQuestionsLines] = useState("");
  const [finalAction, setFinalAction] =
    useState<FinalActionValue>("LEAVE_MESSAGE");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [productLinkEnabled, setProductLinkEnabled] = useState(false);
  const [productLinkUrl, setProductLinkUrl] = useState("");
  const [productLinkIntro, setProductLinkIntro] = useState("");
  const [workMode, setWorkMode] = useState<BotWorkMode>("SMART_DRAFTS");
  const [boundaries, setBoundaries] = useState<BotBoundaryPresets>({
    ...DEFAULT_BOT_BOUNDARIES,
  });

  const finalActionLabels = useMemo(
    () => Object.fromEntries(FINAL_ACTIONS.map((a) => [a.value, botOptionLabel(t, "finalAction", a.value, a.label)])),
    [t]
  );

  const firstQuestionLine = useMemo(() => {
    for (const raw of questionsLines.split("\n")) {
      const line = raw.trim();
      if (line.length > 0) return line;
    }
    return null;
  }, [questionsLines]);

  const parsedQuestions = useMemo(() => {
    return questionsLines
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }, [questionsLines]);

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
      setWorkMode(
        resolved === "AUTO_OPENING_FUTURE" ? "SMART_DRAFTS" : resolved
      );
      setBoundaries(rules.boundaries ?? { ...DEFAULT_BOT_BOUNDARIES });
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
    void load();
  }, [load]);

  function focusField(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    (el as HTMLElement).focus();
  }

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

  const inputStyle: CSSProperties = {
    padding: "8px 10px",
    borderRadius: TOKEN.radius.input,
    border: `1px solid ${TOKEN.border.hover}`,
    fontSize: TOKEN.font.body,
    fontFamily: "inherit",
  };

  const labelStyle: CSSProperties = {
    fontSize: TOKEN.font.meta,
    fontWeight: TOKEN.weight.semibold,
    color: TOKEN.ink.secondary,
  };

  const cardStyle: CSSProperties = {
    background: TOKEN.surface.card,
    border: `1px solid ${TOKEN.border.DEFAULT}`,
    borderRadius: TOKEN.radius.modal,
    padding: TOKEN.space.lg,
    boxSizing: "border-box",
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

  const previewBubble: CSSProperties = {
    background: TOKEN.surface.card,
    border: `1px solid ${TOKEN.border.DEFAULT}`,
    borderRadius: TOKEN.radius.card,
    padding: "12px 14px",
    fontSize: TOKEN.font.body,
    color: TOKEN.ink.primary,
    lineHeight: 1.5,
    maxWidth: "100%",
  };

  // ─── Simulated WhatsApp chat preview ────────────────────────────────────
  // The bubble FILLS below are intentionally literal WhatsApp brand colors
  // (#e5ddd5 chat canvas, #dcf8c6 outgoing bubble, #ffffff incoming bubble) —
  // they represent WhatsApp itself inside this mock, so they stay off-token.
  // Only the text/structure around them uses design tokens.
  const waChatBg: CSSProperties = {
    background: "#e5ddd5",
    borderRadius: TOKEN.radius.input,
    padding: "14px 10px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    boxSizing: "border-box",
  };

  const waBotBubble: CSSProperties = {
    background: "#dcf8c6",
    borderRadius: TOKEN.radius.input,
    padding: "8px 12px",
    fontSize: TOKEN.font.body,
    color: TOKEN.ink.primary,
    lineHeight: 1.55,
    wordBreak: "break-word",
    boxShadow: "0 1px 2px rgba(52, 60, 50, 0.1)",
  };

  const waCustomerBubble: CSSProperties = {
    background: "var(--dz-surface)",
    borderRadius: TOKEN.radius.input,
    padding: "8px 12px",
    fontSize: TOKEN.font.body,
    color: TOKEN.ink.muted,
    lineHeight: 1.55,
    boxShadow: "0 1px 2px rgba(52, 60, 50, 0.08)",
    alignSelf: "flex-end",
    maxWidth: "65%",
  };

  const waEditBtn: CSSProperties = {
    background: "none",
    border: "none",
    padding: 0,
    fontSize: TOKEN.font.caption,
    color: TOKEN.ink.secondary,
    cursor: "pointer",
    fontFamily: "inherit",
    textDecoration: "underline",
    textUnderlineOffset: 2,
    textAlign: "start",
  };

  return (
    <div style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <PageHeader
        title={t("content.bot.desk.title")}
        backHref="/business/bot"
        backLabel={t("content.bot.desk.backLabel")}
        showBack
      />
      <main className={desk.main}>
        <p style={{ fontSize: TOKEN.font.body, color: TOKEN.ink.secondary, marginTop: 0, lineHeight: 1.55 }}>
          {t("content.bot.desk.intro")}
        </p>

        {loading ? (
          <div style={{ marginTop: 28, color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>{t("content.bot.common.loadingEllipsis")}</div>
        ) : (
          <div className={desk.stack}>
            <section style={cardStyle}>
              <h2 style={sectionTitle}>{t("content.bot.desk.workTitle")}</h2>
              <p style={sectionHint}>
                {t("content.bot.desk.workHint")}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {localizeWorkModes(t, BOT_WORK_MODE_OPTIONS_ACTIVE).map((opt) => {
                  const selected = workMode === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setWorkMode(opt.id);
                        const patch = settingsPatchForWorkMode(opt.id, {
                          version: 1,
                          workMode: opt.id,
                          boundaries,
                        });
                        setEnabled(patch.enabled);
                        setShowDraftSuggestionsInInbox(patch.showDraftSuggestionsInInbox);
                      }}
                      style={{
                        textAlign: "start",
                        width: "100%",
                        border: selected
                          ? `2px solid ${TOKEN.brand.mid}`
                          : `1px solid ${TOKEN.border.DEFAULT}`,
                        borderRadius: TOKEN.radius.card,
                        padding: "14px 16px",
                        background: selected ? TOKEN.brand.soft : TOKEN.surface.card,
                        cursor: "pointer",
                        opacity: 1,
                      }}
                    >
                      <div style={{ fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.body, color: TOKEN.ink.primary }}>
                        {opt.title}
                      </div>
                      <div
                        style={{
                          fontSize: TOKEN.font.meta,
                          color: TOKEN.ink.muted,
                          marginTop: 4,
                          lineHeight: 1.45,
                        }}
                      >
                        {opt.description}
                      </div>
                      <div
                        style={{
                          fontSize: TOKEN.font.meta,
                          color: selected ? TOKEN.brand.mid : TOKEN.ink.meta,
                          marginTop: 6,
                          fontWeight: TOKEN.weight.semibold,
                        }}
                      >
                        {opt.trustLine}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            <section style={cardStyle}>
              <h2 style={sectionTitle}>{t("content.bot.desk.handoffTitle")}</h2>
              <p style={sectionHint}>
                {t("content.bot.desk.handoffHint")}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {localizeKeyOptions(t, "boundary", BOT_BOUNDARY_OPTIONS).map((opt) => (
                  <label
                    key={opt.key}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 12,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={
                        opt.key === "afterMessageCountThreshold"
                          ? boundaries.afterMessageCount
                          : boundaries[opt.key as keyof BotBoundaryPresets] === true
                      }
                      onChange={(e) => {
                        if (opt.key === "afterMessageCountThreshold") {
                          setBoundaries((b) => ({
                            ...b,
                            afterMessageCount: e.target.checked,
                          }));
                          return;
                        }
                        setBoundaries((b) => ({
                          ...b,
                          [opt.key]: e.target.checked,
                        }));
                      }}
                      style={{ width: 18, height: 18, marginTop: 3, flexShrink: 0 }}
                    />
                    <span>
                      <span style={{ display: "block", fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.body }}>
                        {opt.label}
                      </span>
                      <span
                        style={{
                          display: "block",
                          fontSize: TOKEN.font.meta,
                          color: TOKEN.ink.muted,
                          marginTop: 2,
                        }}
                      >
                        {opt.hint}
                      </span>
                      {opt.isThreshold && boundaries.afterMessageCount ? (
                        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: TOKEN.font.meta, color: TOKEN.ink.secondary }}>{t("content.bot.desk.after")}</span>
                          <input
                            type="number"
                            min={3}
                            max={30}
                            value={boundaries.afterMessageCountThreshold}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              setBoundaries((b) => ({
                                ...b,
                                afterMessageCountThreshold: Number.isFinite(n)
                                  ? Math.min(30, Math.max(3, n))
                                  : 8,
                              }));
                            }}
                            style={{
                              width: 56,
                              padding: "6px 8px",
                              borderRadius: TOKEN.radius.input,
                              border: `1px solid ${TOKEN.border.hover}`,
                              fontSize: TOKEN.font.body,
                            }}
                          />
                          <span style={{ fontSize: TOKEN.font.meta, color: TOKEN.ink.secondary }}>
                            {t("content.bot.common.messagesFromCustomer")}
                          </span>
                        </div>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            </section>

            <section style={cardStyle}>
              <h2 style={sectionTitle}>{t("content.bot.common.welcomeTitle")}</h2>
              <p style={sectionHint}>{t("content.bot.common.welcomeHint")}</p>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={labelStyle}>{t("content.bot.common.welcomeMessage")}</span>
                <textarea
                  id="bot-welcome-input"
                  value={welcomeMessage}
                  onChange={(e) => setWelcomeMessage(e.target.value)}
                  rows={4}
                  placeholder="לדוגמה: היי! איך אפשר לעזור היום?"
                  style={{ ...inputStyle, resize: "vertical", minHeight: 100, fontSize: TOKEN.font.body }}
                />
              </label>
            </section>

            <section style={cardStyle}>
              <h2 style={sectionTitle}>{t("content.bot.common.questionsTitle")}</h2>
              <p style={sectionHint}>
                {t("content.bot.desk.questionsHint")}
              </p>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={labelStyle}>{t("content.bot.desk.questionsLabel")}</span>
                <textarea
                  id="bot-questions-input"
                  value={questionsLines}
                  onChange={(e) => setQuestionsLines(e.target.value)}
                  rows={5}
                  placeholder={"לדוגמה:\nמה השם שלך?\nמתי נוח לך?"}
                  style={{ ...inputStyle, resize: "vertical", minHeight: 120, fontSize: TOKEN.font.body }}
                />
              </label>
            </section>

            <section className={desk.preview} style={{ ...cardStyle, background: TOKEN.semantic.success.bgSoft, borderColor: TOKEN.semantic.success.border }}>
              <h2 style={{ ...sectionTitle, fontSize: TOKEN.font.title }}>{t("content.bot.desk.previewTitle")}</h2>
              <p style={{ ...sectionHint, marginBottom: 14 }}>
                {t("content.bot.desk.previewHint")}
              </p>

              {/* Simulated customer-facing chat — keeps the Hebrew RTL rendering the customer sees. */}
              <div dir="rtl" style={waChatBg}>
                {/* Bot: welcome message */}
                <div style={{ alignSelf: "flex-start", maxWidth: "84%", display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={waBotBubble}>
                    {welcomeMessage.trim() ? (
                      welcomeMessage.trim()
                    ) : (
                      <span dir={dir} style={{ color: TOKEN.ink.meta, fontStyle: "italic" }}>
                        {t("content.bot.desk.welcomeSlot")}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => focusField("bot-welcome-input")}
                    dir={dir}
                    style={waEditBtn}
                  >
                    {t("content.bot.desk.editWelcome")}
                  </button>
                </div>

                {/* Customer placeholder */}
                <div style={waCustomerBubble}>...</div>

                {/* Bot: question 1, or placeholder if no questions yet */}
                <div style={{ alignSelf: "flex-start", maxWidth: "84%", display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={waBotBubble}>
                    {parsedQuestions.length > 0 ? (
                      parsedQuestions[0]
                    ) : (
                      <span dir={dir} style={{ color: TOKEN.ink.meta, fontStyle: "italic" }}>
                        {t("content.bot.desk.firstQuestionSlot")}
                      </span>
                    )}
                  </div>
                  {parsedQuestions.length === 0 && (
                    <button
                      type="button"
                      onClick={() => focusField("bot-questions-input")}
                      dir={dir}
                    style={waEditBtn}
                    >
                      {t("content.bot.desk.addQuestions")}
                    </button>
                  )}
                </div>

                {/* If questions exist: customer placeholder + question 2 or final action */}
                {parsedQuestions.length > 0 && (
                  <>
                    <div style={waCustomerBubble}>...</div>
                    <div style={{ alignSelf: "flex-start", maxWidth: "84%" }}>
                      <div style={waBotBubble}>
                        {parsedQuestions[1] ? (
                          parsedQuestions[1]
                        ) : (
                          <span style={{ color: TOKEN.ink.secondary }}>{finalActionPreviewText}</span>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>

              <p style={{ margin: "12px 0 0", fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, lineHeight: 1.55 }}>
                {t("content.bot.desk.previewFooter")}
              </p>
            </section>

            <section style={cardStyle}>
              <h2 style={sectionTitle}>{t("content.bot.common.finalActionTitle")}</h2>
              <p style={sectionHint}>{t("content.bot.common.finalActionHint")}</p>
              <div style={{ display: "grid", gap: 14 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={labelStyle}>{t("content.bot.common.finalActionSelect")}</span>
                  <select
                    value={finalAction}
                    onChange={(e) =>
                      setFinalAction(e.target.value as FinalActionValue)
                    }
                    style={{ ...inputStyle, fontSize: TOKEN.font.body, minHeight: 44 }}
                  >
                    {FINAL_ACTIONS.map((a) => (
                      <option key={a.value} value={a.value}>
                        {botOptionLabel(t, "finalAction", a.value, a.label)}
                      </option>
                    ))}
                  </select>
                </label>
                {finalAction === "SEND_LINK" ? (
                  <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={labelStyle}>{t("content.bot.common.linkUrl")}</span>
                    <input
                      type="url"
                      inputMode="url"
                      dir="ltr"
                      value={websiteUrl}
                      onChange={(e) => setWebsiteUrl(e.target.value)}
                      placeholder="https://…"
                      style={{ ...inputStyle, fontSize: TOKEN.font.body, minHeight: 44 }}
                    />
                  </label>
                ) : null}
                <p style={{ margin: 0, fontSize: TOKEN.font.meta, color: TOKEN.ink.meta }}>
                  {t("content.bot.common.botActsBy")}{" "}
                  <strong style={{ color: TOKEN.ink.secondary }}>
                    {finalActionLabels[finalAction] ?? finalAction}
                  </strong>
                </p>
              </div>
            </section>

            <section style={cardStyle}>
              <h2 style={sectionTitle}>{t("content.bot.common.catalogLinkTitle")}</h2>
              <p style={sectionHint}>
                {t("content.bot.common.catalogLinkHint")}
              </p>
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  fontSize: TOKEN.font.body,
                  color: TOKEN.ink.primary,
                  cursor: "pointer",
                  lineHeight: 1.45,
                  marginBottom: 16,
                }}
              >
                <input
                  type="checkbox"
                  checked={productLinkEnabled}
                  onChange={(e) => setProductLinkEnabled(e.target.checked)}
                  style={{ width: 20, height: 20, marginTop: 2, flexShrink: 0 }}
                />
                <span>{t("content.bot.common.offerCatalogLink")}</span>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                <span style={labelStyle}>{t("content.bot.common.pageUrl")}</span>
                <input
                  type="url"
                  inputMode="url"
                  dir="ltr"
                  value={productLinkUrl}
                  onChange={(e) => setProductLinkUrl(e.target.value)}
                  placeholder="https://…"
                  style={{ ...inputStyle, fontSize: TOKEN.font.body, minHeight: 44 }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={labelStyle}>{t("content.bot.common.linkIntroOptional")}</span>
                <textarea
                  value={productLinkIntro}
                  onChange={(e) => setProductLinkIntro(e.target.value)}
                  rows={2}
                  placeholder="לדוגמה: הנה הקישור לקטלוג שלנו"
                  style={{ ...inputStyle, resize: "vertical", minHeight: 72, fontSize: TOKEN.font.body }}
                />
              </label>
              {isValidProductLinkUrl(productLinkUrl.trim()) ? (
                <div
                  style={{
                    marginTop: 16,
                    padding: "12px 14px",
                    borderRadius: TOKEN.radius.input,
                    background: TOKEN.semantic.success.bgSoft,
                    border: `1px solid ${TOKEN.semantic.success.border}`,
                  }}
                >
                  <p style={{ margin: "0 0 8px", fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, color: TOKEN.semantic.success.ink }}>
                    {t("content.bot.desk.linkPreviewTitle")}
                  </p>
                  <p style={{ margin: "0 0 8px", fontSize: TOKEN.font.meta, color: TOKEN.semantic.success.ink, lineHeight: 1.5 }}>
                    {t("content.bot.desk.linkPreviewHint")}
                  </p>
                  {productLinkIntro.trim() ? (
                    <div dir="rtl" style={{ ...previewBubble, marginBottom: 8 }}>{productLinkIntro.trim()}</div>
                  ) : null}
                  <div
                    style={{
                      ...previewBubble,
                      fontFamily: "ui-monospace, monospace",
                      fontSize: TOKEN.font.meta,
                      wordBreak: "break-all",
                    }}
                  >
                    {productLinkUrl.trim()}
                  </div>
                </div>
              ) : null}
            </section>

            <section
              style={{
                ...cardStyle,
                background: TOKEN.surface.inset,
                borderStyle: "dashed",
                borderColor: TOKEN.border.hover,
              }}
            >
              <h2 style={{ ...sectionTitle, fontSize: TOKEN.font.title }}>{t("content.bot.desk.advancedTitle")}</h2>
              <p style={{ ...sectionHint }}>
                {t("content.bot.desk.advancedHint")}
              </p>
              <p style={{ margin: "0 0 12px", fontSize: TOKEN.font.body, color: TOKEN.ink.muted, lineHeight: 1.5 }}>
                {workMode === "SMART_DRAFTS"
                  ? t("content.bot.desk.advancedSmart")
                  : workMode === "MANUAL"
                    ? t("content.bot.desk.advancedManual")
                    : t("content.bot.desk.advancedFuture")}
              </p>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  marginTop: 16,
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    fontSize: TOKEN.font.meta,
                    padding: "6px 12px",
                    borderRadius: TOKEN.radius.pill,
                    background: TOKEN.border.DEFAULT,
                    color: TOKEN.ink.secondary,
                    fontWeight: TOKEN.weight.semibold,
                  }}
                >
                  {t("content.bot.desk.modeStarter")}
                </span>
                <span
                  style={{
                    fontSize: TOKEN.font.meta,
                    padding: "6px 12px",
                    borderRadius: TOKEN.radius.pill,
                    background: TOKEN.border.DEFAULT,
                    color: TOKEN.ink.secondary,
                    fontWeight: TOKEN.weight.semibold,
                  }}
                >
                  {t("content.bot.desk.channelWhatsApp")}
                </span>
              </div>
              <p style={{ margin: "10px 0 0", fontSize: TOKEN.font.meta, color: TOKEN.ink.meta, lineHeight: 1.45 }}>
                {t("content.bot.desk.advancedFootnote")}
              </p>
            </section>

            {error ? (
              <div
                role="alert"
                style={{
                  background: TOKEN.semantic.urgent.bgSoft,
                  color: TOKEN.semantic.urgent.ink,
                  padding: "12px 14px",
                  borderRadius: TOKEN.radius.input,
                  fontSize: TOKEN.font.body,
                }}
              >
                {error}
              </div>
            ) : null}
            {savedOk ? (
              <div style={{ fontSize: TOKEN.font.body, color: TOKEN.semantic.success.ink, fontWeight: TOKEN.weight.semibold }}>{t("content.bot.common.savedSuccess")}</div>
            ) : null}

            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              style={{
                width: "100%",
                padding: "16px 20px",
                borderRadius: TOKEN.radius.card,
                border: "none",
                background: saving ? TOKEN.ink.meta : TOKEN.ink.primary,
                color: TOKEN.ink.inverse,
                fontSize: TOKEN.font.title,
                fontWeight: TOKEN.weight.bold,
                cursor: saving ? "not-allowed" : "pointer",
                minHeight: 52,
              }}
            >
              {saving ? t("content.bot.common.savingEllipsis") : t("content.bot.common.saveChanges")}
            </button>

            <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 8 }}>
              <Link
                href="/business/bot"
                style={{
                  fontSize: TOKEN.font.body,
                  fontWeight: TOKEN.weight.semibold,
                  color: TOKEN.brand.mid,
                  textDecoration: "none",
                  textAlign: "center",
                  padding: "10px 0",
                }}
              >
                {t("content.bot.desk.backToBot")}
              </Link>
              <Link
                href="/inbox"
                style={{
                  fontSize: TOKEN.font.body,
                  fontWeight: TOKEN.weight.semibold,
                  color: TOKEN.ink.secondary,
                  textDecoration: "none",
                  textAlign: "center",
                  padding: "8px 0",
                }}
              >
                {t("content.bot.desk.toConversations")}
              </Link>
              <Link
                href="/business"
                style={{
                  fontSize: TOKEN.font.body,
                  fontWeight: TOKEN.weight.medium,
                  color: TOKEN.ink.muted,
                  textDecoration: "none",
                  textAlign: "center",
                }}
              >
                {t("content.bot.desk.invoiceIdentity")}
              </Link>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
