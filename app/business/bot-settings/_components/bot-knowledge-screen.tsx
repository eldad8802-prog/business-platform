"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { TOKEN } from "@/lib/design/bot-theme";
import { MAX_FAQ_ITEMS, type FaqItem } from "@/lib/features/bot";
import {
  AreaHeader,
  BUILDER_SHELL_MAX_WIDTH,
  BuilderTextAreaField,
  BuilderTextField,
  GuardNote,
  StickyActionBar,
  ToggleRow,
  areaPanelStyle,
} from "./bot-builder-area-ui";

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

type KnowledgeResponse = {
  knowledge?: { hours: string | null; address: string | null; notes: string | null; faq: FaqItem[] };
  bridges?: { productLinkEnabled: boolean; productLinkSet: boolean; servicesCount: number };
};

const screenWrap: CSSProperties = {
  maxWidth: BUILDER_SHELL_MAX_WIDTH,
  minHeight: "100dvh",
  margin: "0 auto",
  padding: 0,
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
};
const sectionLabel: CSSProperties = {
  padding: "20px 18px 8px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
  color: TOKEN.ink.muted,
};

export function KnowledgeProfileScreen({
  productLinkEnabled,
  setProductLinkEnabled,
  productLinkUrl,
  setProductLinkUrl,
  productLinkIntro,
  setProductLinkIntro,
  onSaveSettings,
}: {
  productLinkEnabled: boolean;
  setProductLinkEnabled: (v: boolean) => void;
  productLinkUrl: string;
  setProductLinkUrl: (v: string) => void;
  productLinkIntro: string;
  setProductLinkIntro: (v: string) => void;
  onSaveSettings: () => Promise<void> | void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [hours, setHours] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [faq, setFaq] = useState<FaqItem[]>([]);
  const [servicesCount, setServicesCount] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/business/bot/knowledge", {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
        cache: "no-store",
      });
      if (!res.ok) throw new Error();
      const data: KnowledgeResponse = await res.json();
      setHours(data.knowledge?.hours ?? "");
      setAddress(data.knowledge?.address ?? "");
      setNotes(data.knowledge?.notes ?? "");
      setFaq(data.knowledge?.faq ?? []);
      setServicesCount(data.bridges?.servicesCount ?? 0);
    } catch {
      setError("לא ניתן לטעון את הידע");
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

  function updateFaq(i: number, patch: Partial<FaqItem>) {
    setFaq((cur) => cur.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }
  function addFaq() {
    setFaq((cur) => (cur.length >= MAX_FAQ_ITEMS ? cur : [...cur, { question: "", answer: "" }]));
  }
  function removeFaq(i: number) {
    setFaq((cur) => cur.filter((_, idx) => idx !== i));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const cleanFaq = faq
        .map((f) => ({ question: f.question.trim(), answer: f.answer.trim() }))
        .filter((f) => f.question.length > 0);
      const res = await fetch("/api/business/bot/knowledge", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${getAuthToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          hours: hours.trim() === "" ? null : hours.trim(),
          address: address.trim() === "" ? null : address.trim(),
          notes: notes.trim() === "" ? null : notes.trim(),
          faq: cleanFaq,
        }),
      });
      if (!res.ok) {
        let msg = "שמירת הידע נכשלה";
        try {
          const j = await res.json();
          if (j?.error) msg = String(j.error);
        } catch {
          /* ignore */
        }
        setError(msg);
        return;
      }
      // Product link still saved through the existing settings contract.
      await onSaveSettings();
      setSavedOk(true);
      window.setTimeout(() => setSavedOk(false), 2500);
      await load();
    } catch {
      setError("שגיאת רשת");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={screenWrap}>
        <AreaHeader
          title="מה הבוט יודע"
          subtitle="ככל שהבוט יודע יותר על העסק, ככה התשובות שלו מדויקות יותר. (נשמר כידע — עדיין לא בשימוש בשיחה.)"
          backHref="/business/bot"
          backLabel="הבוט שלי"
        />
        {loading ? (
          <p style={{ margin: 18, color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>טוען...</p>
        ) : (
          <>
            <div style={sectionLabel}>ידע על העסק</div>
            <section style={{ ...areaPanelStyle, padding: "16px 0" }}>
              <div style={{ display: "grid", gap: 16 }}>
                <BuilderTextField
                  label="שעות פעילות"
                  hint="לדוגמה: א׳–ה׳ 9:00–19:00"
                  value={hours}
                  onChange={setHours}
                  placeholder="שעות פעילות"
                />
                <BuilderTextField
                  label="כתובת והגעה"
                  value={address}
                  onChange={setAddress}
                  placeholder="לדוגמה: הרצל 24, ירושלים"
                />
                <BuilderTextAreaField
                  label="מידע חופשי על העסק"
                  hint="הערות שכדאי שהבוט יכיר."
                  value={notes}
                  onChange={setNotes}
                  rows={3}
                  placeholder="לדוגמה: יש חניה בחצר, גישה לנכים..."
                />
              </div>
            </section>

            <div style={sectionLabel}>שאלות נפוצות</div>
            <section style={{ ...areaPanelStyle, padding: "12px 0" }}>
              {faq.length === 0 ? (
                <p style={{ margin: "4px 18px", color: TOKEN.ink.muted, fontSize: TOKEN.font.meta }}>
                  עדיין אין שאלות נפוצות.
                </p>
              ) : null}
              {faq.map((item, i) => (
                <div
                  key={i}
                  style={{
                    margin: "0 18px 10px",
                    border: `1px solid ${TOKEN.border.DEFAULT}`,
                    borderRadius: TOKEN.radius.card,
                    padding: 12,
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.muted }}>
                      שאלה {i + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFaq(i)}
                      aria-label="הסר שאלה"
                      style={{ border: 0, background: "transparent", color: TOKEN.ink.meta, cursor: "pointer", fontSize: TOKEN.font.body }}
                    >
                      ✕
                    </button>
                  </div>
                  <input
                    value={item.question}
                    onChange={(e) => updateFaq(i, { question: e.target.value })}
                    placeholder="השאלה"
                    style={inputStyle}
                  />
                  <textarea
                    value={item.answer}
                    onChange={(e) => updateFaq(i, { answer: e.target.value })}
                    placeholder="התשובה"
                    rows={2}
                    style={{ ...inputStyle, resize: "vertical", minHeight: 56 }}
                  />
                </div>
              ))}
              {faq.length < MAX_FAQ_ITEMS ? (
                <button
                  type="button"
                  onClick={addFaq}
                  style={{
                    margin: "2px 18px 0",
                    width: "calc(100% - 36px)",
                    border: `1.5px dashed ${TOKEN.border.hover}`,
                    borderRadius: TOKEN.radius.input,
                    padding: 13,
                    background: "transparent",
                    color: TOKEN.brand.mid,
                    fontFamily: "inherit",
                    fontWeight: TOKEN.weight.bold,
                    fontSize: TOKEN.font.body,
                    cursor: "pointer",
                  }}
                >
                  + הוסף שאלה נפוצה
                </button>
              ) : null}
            </section>

            <div style={sectionLabel}>קישור לקטלוג</div>
            <section style={areaPanelStyle}>
              <ToggleRow
                label="הצע קישור לקטלוג באינבוקס"
                hint="כשלקוח מבקש לראות מוצרים, האינבוקס יוכל למלא הודעה עם הקישור."
                checked={productLinkEnabled}
                onChange={setProductLinkEnabled}
              />
              <div style={{ display: "grid", gap: 16, padding: "16px 0" }}>
                <BuilderTextField
                  label="כתובת דף (URL)"
                  value={productLinkUrl}
                  onChange={setProductLinkUrl}
                  placeholder="https://..."
                  type="url"
                  inputMode="url"
                  dir="ltr"
                />
                <BuilderTextAreaField
                  label="משפט קצר לפני הקישור"
                  hint="אופציונלי."
                  value={productLinkIntro}
                  onChange={setProductLinkIntro}
                  rows={2}
                  placeholder="לדוגמה: הנה הקישור לקטלוג שלנו"
                />
              </div>
            </section>

            <GuardNote>
              שירותים ומחירון נשארים במקור הקיים שלהם
              {servicesCount > 0 ? ` (${servicesCount} שירותים מוגדרים)` : ""} — לא משוכפלים כאן. הידע נשמר אך אינו בשימוש בתשובות בשלב הזה.
            </GuardNote>
            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void handleSave()}
              saving={saving}
              saved={savedOk}
              error={error}
              saveLabel="שמור ידע"
            />
          </>
        )}
      </main>
    </div>
  );
}

const inputStyle: CSSProperties = {
  width: "100%",
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.input,
  background: TOKEN.surface.inset,
  padding: "11px 13px",
  color: TOKEN.ink.primary,
  fontFamily: "inherit",
  fontSize: TOKEN.font.body,
  lineHeight: 1.5,
  outline: "none",
  boxSizing: "border-box",
};
