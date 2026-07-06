"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { TOKEN } from "@/lib/design/bot-theme";
import {
  MEMORY_TOGGLE_OPTIONS,
  emptyMemoryPolicy,
  type BotMemoryPolicy,
  type MemoryToggleKey,
} from "@/lib/features/bot";
import {
  AreaHeader,
  BUILDER_SHELL_MAX_WIDTH,
  GuardNote,
  StickyActionBar,
  ToggleRow,
  areaPanelStyle,
} from "./bot-builder-area-ui";

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

const screenWrap: CSSProperties = {
  maxWidth: BUILDER_SHELL_MAX_WIDTH,
  minHeight: "100dvh",
  margin: "0 auto",
  padding: 0,
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
};

export function MemoryPolicyScreen() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<BotMemoryPolicy>(emptyMemoryPolicy());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/business/bot/memory-policy", {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
        cache: "no-store",
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setPolicy({ ...emptyMemoryPolicy(), ...(data.policy ?? {}) });
    } catch {
      setError("לא ניתן לטעון את מדיניות הזיכרון");
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

  function toggle(key: MemoryToggleKey, value: boolean) {
    setPolicy((p) => ({ ...p, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/business/bot/memory-policy", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${getAuthToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(policy),
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

  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={screenWrap}>
        <AreaHeader
          title="מה הבוט זוכר על לקוחות"
          subtitle="כאן בוחרים מה מותר לבוט לזכור על לקוחות בעתיד. זו מדיניות בלבד — בשלב הזה הבוט עדיין לא זוכר דבר בפועל."
          backHref="/business/bot"
          backLabel="הבוט שלי"
        />
        {loading ? (
          <p style={{ margin: 18, color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>טוען...</p>
        ) : (
          <>
            <div style={{ padding: "20px 18px 8px", fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.muted }}>
              מה מותר לזכור על כל לקוח
            </div>
            <section style={areaPanelStyle}>
              {MEMORY_TOGGLE_OPTIONS.map((opt) => (
                <ToggleRow
                  key={opt.key}
                  label={opt.label}
                  hint={opt.hint}
                  checked={policy[opt.key]}
                  onChange={(next) => toggle(opt.key, next)}
                />
              ))}
            </section>
            <GuardNote>
              זו הגדרת מדיניות עתידית בלבד. הבוט אינו כותב מידע על לקוחות ואינו זוכר בין שיחות בשלב הזה.
            </GuardNote>
            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void handleSave()}
              saving={saving}
              saved={savedOk}
              error={error}
              saveLabel="שמור מדיניות"
            />
          </>
        )}
      </main>
    </div>
  );
}
