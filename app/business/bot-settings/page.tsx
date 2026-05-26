"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import PageHeader from "@/components/ui/page-header";
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

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

const FINAL_ACTIONS = [
  { value: "LEAVE_MESSAGE", label: "השארת הודעה" },
  { value: "COLLECT_DETAILS", label: "איסוף פרטים" },
  { value: "SEND_LINK", label: "שליחת קישור" },
  { value: "ESCALATE", label: "העברה לנציג" },
] as const;

type FinalActionValue = (typeof FINAL_ACTIONS)[number]["value"];

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
    () => Object.fromEntries(FINAL_ACTIONS.map((a) => [a.value, a.label])),
    []
  );

  const firstQuestionLine = useMemo(() => {
    for (const raw of questionsLines.split("\n")) {
      const t = raw.trim();
      if (t.length > 0) return t;
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
      setError("לא ניתן לטעון את הגדרות הבוט");
    } finally {
      setLoading(false);
    }
  }, []);

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

  const inputStyle: CSSProperties = {
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid #cbd5e1",
    fontSize: 13,
    fontFamily: "inherit",
  };

  const labelStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: "#475569",
  };

  const cardStyle: CSSProperties = {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 16,
    padding: 18,
    boxSizing: "border-box",
  };

  const sectionTitle: CSSProperties = {
    margin: "0 0 6px",
    fontSize: 17,
    fontWeight: 800,
    color: "#0f172a",
    lineHeight: 1.3,
  };

  const sectionHint: CSSProperties = {
    margin: "0 0 16px",
    fontSize: 13,
    color: "#64748b",
    lineHeight: 1.55,
  };

  const previewBubble: CSSProperties = {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 14,
    padding: "12px 14px",
    fontSize: 14,
    color: "#0f172a",
    lineHeight: 1.5,
    maxWidth: "100%",
  };

  const waChatBg: CSSProperties = {
    background: "#e5ddd5",
    borderRadius: 12,
    padding: "14px 10px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    boxSizing: "border-box",
  };

  const waBotBubble: CSSProperties = {
    background: "#dcf8c6",
    borderRadius: 12,
    padding: "8px 12px",
    fontSize: 14,
    color: "#0f172a",
    lineHeight: 1.55,
    wordBreak: "break-word",
    boxShadow: "0 1px 2px rgba(0,0,0,0.10)",
  };

  const waCustomerBubble: CSSProperties = {
    background: "#ffffff",
    borderRadius: 12,
    padding: "8px 12px",
    fontSize: 14,
    color: "#64748b",
    lineHeight: 1.55,
    boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
    alignSelf: "flex-end",
    maxWidth: "65%",
  };

  const waEditBtn: CSSProperties = {
    background: "none",
    border: "none",
    padding: 0,
    fontSize: 11,
    color: "#475569",
    cursor: "pointer",
    fontFamily: "inherit",
    textDecoration: "underline",
    textUnderlineOffset: 2,
    textAlign: "start",
  };

  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: "#f1f5f9" }}>
      <PageHeader
        title="עריכת הבוט"
        backHref="/business/bot"
        backLabel="חזרה לבוט"
        showBack
      />
      <main
        style={{
          maxWidth: 560,
          margin: "0 auto",
          padding: "18px 16px 100px",
          boxSizing: "border-box",
        }}
      >
        <p style={{ fontSize: 14, color: "#475569", marginTop: 0, lineHeight: 1.55 }}>
          כאן מגדירים איך הבוט מכין טיוטות באינבוקס. אתה תמיד לוחץ שלח — הלקוח לא מקבל
          כלום מהבוט לבד. אפשר לעצור בכל שיחה עם &quot;אני מטפל מכאן&quot;.
        </p>

        {loading ? (
          <div style={{ marginTop: 28, color: "#94a3b8", fontSize: 15 }}>טוען…</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 22, marginTop: 22 }}>
            <section style={cardStyle}>
              <h2 style={sectionTitle}>איך הבוט עובד אצלך</h2>
              <p style={sectionHint}>
                בחרו מצב עבודה. ברירת המחדל: טיוטות חכמות — הבוט מכין, אתם שולחים.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {BOT_WORK_MODE_OPTIONS_ACTIVE.map((opt) => {
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
                        textAlign: "right",
                        width: "100%",
                        border: selected
                          ? "2px solid #6366f1"
                          : "1px solid #e2e8f0",
                        borderRadius: 14,
                        padding: "14px 16px",
                        background: selected ? "#eef2ff" : "#fff",
                        cursor: "pointer",
                        opacity: 1,
                      }}
                    >
                      <div style={{ fontWeight: 800, fontSize: 15, color: "#0f172a" }}>
                        {opt.title}
                      </div>
                      <div
                        style={{
                          fontSize: 13,
                          color: "#64748b",
                          marginTop: 4,
                          lineHeight: 1.45,
                        }}
                      >
                        {opt.description}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: selected ? "#4f46e5" : "#94a3b8",
                          marginTop: 6,
                          fontWeight: 600,
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
              <h2 style={sectionTitle}>מתי הבוט מעביר אליך את השיחה</h2>
              <p style={sectionHint}>
                כשמופעל — הבוט לא יכין עוד טיוטות פתיחה לשיחה הזו, ותמשיכו אתם מהאינבוקס.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {BOT_BOUNDARY_OPTIONS.map((opt) => (
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
                      <span style={{ display: "block", fontWeight: 700, fontSize: 14 }}>
                        {opt.label}
                      </span>
                      <span
                        style={{
                          display: "block",
                          fontSize: 12,
                          color: "#64748b",
                          marginTop: 2,
                        }}
                      >
                        {opt.hint}
                      </span>
                      {opt.isThreshold && boundaries.afterMessageCount ? (
                        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 13, color: "#475569" }}>אחרי</span>
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
                              borderRadius: 8,
                              border: "1px solid #cbd5e1",
                              fontSize: 14,
                            }}
                          />
                          <span style={{ fontSize: 13, color: "#475569" }}>
                            הודעות מהלקוח
                          </span>
                        </div>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            </section>

            <section style={cardStyle}>
              <h2 style={sectionTitle}>איך הבוט מקבל לקוחות</h2>
              <p style={sectionHint}>זה המשפט הראשון שהלקוח רואה — קצר, חם וברור.</p>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={labelStyle}>הודעת פתיחה</span>
                <textarea
                  id="bot-welcome-input"
                  value={welcomeMessage}
                  onChange={(e) => setWelcomeMessage(e.target.value)}
                  rows={4}
                  placeholder="לדוגמה: היי! איך אפשר לעזור היום?"
                  style={{ ...inputStyle, resize: "vertical", minHeight: 100, fontSize: 15 }}
                />
              </label>
            </section>

            <section style={cardStyle}>
              <h2 style={sectionTitle}>מה הבוט שואל</h2>
              <p style={sectionHint}>
                שורה אחת לכל שאלה. אפשר להתחיל בשני־שלושה משפטים פשוטים — אפשר לערוך בכל
                רגע.
              </p>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={labelStyle}>שאלות (שורה לכל שאלה)</span>
                <textarea
                  id="bot-questions-input"
                  value={questionsLines}
                  onChange={(e) => setQuestionsLines(e.target.value)}
                  rows={5}
                  placeholder={"לדוגמה:\nמה השם שלך?\nמתי נוח לך?"}
                  style={{ ...inputStyle, resize: "vertical", minHeight: 120, fontSize: 15 }}
                />
              </label>
            </section>

            <section style={{ ...cardStyle, background: "#f8fbf9", borderColor: "#c6f6d5" }}>
              <h2 style={{ ...sectionTitle, fontSize: 16 }}>כך יראה הלקוח שלך את הבוט</h2>
              <p style={{ ...sectionHint, marginBottom: 14 }}>
                תצוגה של תחילת השיחה — לא צ׳אט חי, רק הדגמה ויזואלית.
              </p>

              <div style={waChatBg}>
                {/* Bot: welcome message */}
                <div style={{ alignSelf: "flex-start", maxWidth: "84%", display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={waBotBubble}>
                    {welcomeMessage.trim() ? (
                      welcomeMessage.trim()
                    ) : (
                      <span style={{ color: "#94a3b8", fontStyle: "italic" }}>
                        [הודעת הפתיחה שלך תופיע כאן]
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => focusField("bot-welcome-input")}
                    style={waEditBtn}
                  >
                    ← ערוך הודעת פתיחה
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
                      <span style={{ color: "#94a3b8", fontStyle: "italic" }}>
                        [השאלה הראשונה שלך תופיע כאן]
                      </span>
                    )}
                  </div>
                  {parsedQuestions.length === 0 && (
                    <button
                      type="button"
                      onClick={() => focusField("bot-questions-input")}
                      style={waEditBtn}
                    >
                      ← הוסף שאלות
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
                          <span style={{ color: "#475569" }}>{finalActionPreviewText}</span>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>

              <p style={{ margin: "12px 0 0", fontSize: 12, color: "#64748b", lineHeight: 1.55 }}>
                אם הלקוח ישאל משהו שהבוט לא מכיר — השיחה תעבור אליך
              </p>
            </section>

            <section style={cardStyle}>
              <h2 style={sectionTitle}>מה קורה אחרי שהפרטים נאספו</h2>
              <p style={sectionHint}>בוחרים מה הבוט עושה ברגע שמסיים את השאלות.</p>
              <div style={{ display: "grid", gap: 14 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={labelStyle}>פעולה לאחר השאלות</span>
                  <select
                    value={finalAction}
                    onChange={(e) =>
                      setFinalAction(e.target.value as FinalActionValue)
                    }
                    style={{ ...inputStyle, fontSize: 15, minHeight: 44 }}
                  >
                    {FINAL_ACTIONS.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </label>
                {finalAction === "SEND_LINK" ? (
                  <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={labelStyle}>כתובת קישור (URL)</span>
                    <input
                      type="url"
                      inputMode="url"
                      dir="ltr"
                      value={websiteUrl}
                      onChange={(e) => setWebsiteUrl(e.target.value)}
                      placeholder="https://…"
                      style={{ ...inputStyle, fontSize: 15, minHeight: 44 }}
                    />
                  </label>
                ) : null}
                <p style={{ margin: 0, fontSize: 12, color: "#94a3b8" }}>
                  הבוט יפעל לפי:{" "}
                  <strong style={{ color: "#475569" }}>
                    {finalActionLabels[finalAction] ?? finalAction}
                  </strong>
                </p>
              </div>
            </section>

            <section style={cardStyle}>
              <h2 style={sectionTitle}>קישור מהיר לקטלוג</h2>
              <p style={sectionHint}>
                כשלקוח מבקש לראות מוצרים — chip באינבוקס ימלא את ההודעה עם הקישור שלך. אתה
                בודק ושולח בלחיצה אחת.
              </p>
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  fontSize: 15,
                  color: "#1e293b",
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
                <span>הצע קישור לקטלוג באינבוקס</span>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                <span style={labelStyle}>כתובת דף (URL)</span>
                <input
                  type="url"
                  inputMode="url"
                  dir="ltr"
                  value={productLinkUrl}
                  onChange={(e) => setProductLinkUrl(e.target.value)}
                  placeholder="https://…"
                  style={{ ...inputStyle, fontSize: 15, minHeight: 44 }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={labelStyle}>משפט קצר לפני הקישור (אופציונלי)</span>
                <textarea
                  value={productLinkIntro}
                  onChange={(e) => setProductLinkIntro(e.target.value)}
                  rows={2}
                  placeholder="לדוגמה: הנה הקישור לקטלוג שלנו"
                  style={{ ...inputStyle, resize: "vertical", minHeight: 72, fontSize: 15 }}
                />
              </label>
              {isValidProductLinkUrl(productLinkUrl.trim()) ? (
                <div
                  style={{
                    marginTop: 16,
                    padding: "12px 14px",
                    borderRadius: 12,
                    background: "#f0fdf4",
                    border: "1px solid #bbf7d0",
                  }}
                >
                  <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, color: "#166534" }}>
                    תצוגה מקדימה
                  </p>
                  <p style={{ margin: "0 0 8px", fontSize: 13, color: "#14532d", lineHeight: 1.5 }}>
                    כך זה יופיע ב-composer כשתלחץ &quot;שלח קישור למוצר&quot; באינבוקס.
                  </p>
                  {productLinkIntro.trim() ? (
                    <div style={{ ...previewBubble, marginBottom: 8 }}>{productLinkIntro.trim()}</div>
                  ) : null}
                  <div
                    style={{
                      ...previewBubble,
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 13,
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
                background: "#f8fafc",
                borderStyle: "dashed",
                borderColor: "#cbd5e1",
              }}
            >
              <h2 style={{ ...sectionTitle, fontSize: 16 }}>הגדרות מתקדמות</h2>
              <p style={{ ...sectionHint }}>
                טיוטות פתיחה נשלטות ממצב העבודה למעלה. כאן רק פרטים טכניים.
              </p>
              <p style={{ margin: "0 0 12px", fontSize: 14, color: "#64748b", lineHeight: 1.5 }}>
                {workMode === "SMART_DRAFTS"
                  ? "טיוטות הבוט מוצגות באינבוקס — אתם שולחים ידנית."
                  : workMode === "MANUAL"
                    ? "במצב ידני אין טיוטות בוט באינבוקס."
                    : "מצב עתידי — עדיין טיוטות בלבד."}
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
                    fontSize: 12,
                    padding: "6px 12px",
                    borderRadius: 999,
                    background: "#e2e8f0",
                    color: "#475569",
                    fontWeight: 600,
                  }}
                >
                  מצב: Starter
                </span>
                <span
                  style={{
                    fontSize: 12,
                    padding: "6px 12px",
                    borderRadius: 999,
                    background: "#e2e8f0",
                    color: "#475569",
                    fontWeight: 600,
                  }}
                >
                  ערוץ: WhatsApp
                </span>
              </div>
              <p style={{ margin: "10px 0 0", fontSize: 12, color: "#94a3b8", lineHeight: 1.45 }}>
                מצב וערוץ נקבעים כרגע על ידי המערכת — לא ניתן לעריכה כאן.
              </p>
            </section>

            {error ? (
              <div
                role="alert"
                style={{
                  background: "#fef2f2",
                  color: "#991b1b",
                  padding: "12px 14px",
                  borderRadius: 12,
                  fontSize: 14,
                }}
              >
                {error}
              </div>
            ) : null}
            {savedOk ? (
              <div style={{ fontSize: 15, color: "#166534", fontWeight: 600 }}>נשמר בהצלחה</div>
            ) : null}

            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              style={{
                width: "100%",
                padding: "16px 20px",
                borderRadius: 14,
                border: "none",
                background: saving ? "#94a3b8" : "#0f172a",
                color: "#fff",
                fontSize: 16,
                fontWeight: 700,
                cursor: saving ? "not-allowed" : "pointer",
                minHeight: 52,
              }}
            >
              {saving ? "שומר…" : "שמור שינויים"}
            </button>

            <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 8 }}>
              <Link
                href="/business/bot"
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: "#1d4ed8",
                  textDecoration: "none",
                  textAlign: "center",
                  padding: "10px 0",
                }}
              >
                חזרה לבוט
              </Link>
              <Link
                href="/inbox"
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: "#334155",
                  textDecoration: "none",
                  textAlign: "center",
                  padding: "8px 0",
                }}
              >
                מעבר לשיחות
              </Link>
              <Link
                href="/business"
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: "#64748b",
                  textDecoration: "none",
                  textAlign: "center",
                }}
              >
                זהות העסק לחשבוניות
              </Link>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
