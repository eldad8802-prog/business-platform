"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { GOAL_CATALOG } from "@/lib/features/bot";
import {
  AreaHeader,
  BUILDER_SHELL_MAX_WIDTH,
  GuardNote,
  StickyActionBar,
} from "./bot-builder-area-ui";

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

type GoalsResponse = { selected?: { goalKey: string }[] };

const screenWrap: CSSProperties = {
  maxWidth: BUILDER_SHELL_MAX_WIDTH,
  minHeight: "100dvh",
  margin: "0 auto",
  padding: 0,
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
};

export function GoalLibrary({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (goalKey: string) => void;
}) {
  return (
    <>
      {GOAL_CATALOG.map((cat) => (
        <section key={cat.key}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "18px 20px 10px",
              fontSize: TOKEN.font.body,
              fontWeight: TOKEN.weight.bold,
              color: TOKEN.ink.primary,
            }}
          >
            <span aria-hidden style={{ fontSize: 16 }}>{cat.emoji}</span>
            {cat.label}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 9, padding: "0 18px" }}>
            {cat.goals.map((goal) => {
              const on = selected.includes(goal.key);
              return (
                <button
                  key={goal.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onToggle(goal.key)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "10px 14px",
                    borderRadius: TOKEN.radius.card,
                    border: `1px solid ${on ? TOKEN.brand.mid : TOKEN.border.DEFAULT}`,
                    background: on ? TOKEN.brand.soft : TOKEN.surface.card,
                    color: on ? TOKEN.brand.mid : TOKEN.ink.primary,
                    fontFamily: "inherit",
                    fontWeight: TOKEN.weight.bold,
                    fontSize: TOKEN.font.meta,
                    cursor: "pointer",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: TOKEN.radius.pill,
                      border: `2px solid ${on ? TOKEN.brand.mid : TOKEN.border.hover}`,
                      background: on ? TOKEN.brand.mid : "transparent",
                      flexShrink: 0,
                    }}
                  />
                  {goal.label}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}

export function GoalsFlagshipScreen() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = getAuthToken();
      const headers = { Authorization: `Bearer ${token}` };
      const goalsRes = await fetch("/api/business/bot/goals", { headers, cache: "no-store" });
      if (!goalsRes.ok) throw new Error();
      const goals: GoalsResponse = await goalsRes.json();
      setSelected((goals.selected ?? []).map((g) => g.goalKey));
    } catch {
      setError("לא ניתן לטעון את מטרות הבוט");
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

  function toggle(key: string) {
    setSelected((cur) =>
      cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
    );
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/business/bot/goals", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ goals: selected }),
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
          title="מטרות הבוט"
          subtitle="בחר כמה שתרצה - לכל מטרה Dubiz תוכל בעתיד להרכיב בסיס מתאים. אפשר לשנות הכול אחר כך."
          backHref="/business/bot"
          backLabel="הבוט שלי"
        />
        {loading ? (
          <p style={{ margin: 18, color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>טוען...</p>
        ) : (
          <>
            <div style={{ padding: "12px 18px 0" }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  fontSize: TOKEN.font.meta,
                  fontWeight: TOKEN.weight.bold,
                  color: TOKEN.brand.mid,
                  background: TOKEN.brand.soft,
                  padding: "6px 13px",
                  borderRadius: TOKEN.radius.pill,
                }}
              >
                {selected.length > 0 ? `${selected.length} מטרות נבחרו` : "טרם נבחרו מטרות"}
              </span>
            </div>

            <GoalLibrary selected={selected} onToggle={toggle} />

            <GuardNote>
              בחירת מטרה נשמרת לבוט שלך בלבד. בשלב הזה היא לא משנה את זרימת השיחה ולא מפעילה דבר - רק מתעדת מה העסק בחר.
            </GuardNote>
            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void handleSave()}
              saving={saving}
              saved={savedOk}
              error={error}
              saveLabel="שמור מטרות"
            />
          </>
        )}
      </main>
    </div>
  );
}