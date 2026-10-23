"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { TOKEN } from "@/lib/design/bot-theme";
import { LEARNING_TYPE_LABELS, type LearningType } from "@/lib/features/bot";
import { AreaHeader, BUILDER_SHELL_MAX_WIDTH, GuardNote } from "./bot-builder-area-ui";
import { useI18n } from "@/components/i18n/I18nProvider";
import { botOptionLabel } from "./bot-i18n";

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

type Suggestion = {
  id: number;
  type: string;
  title: string;
  description: string | null;
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

export function LearningScreen() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [items, setItems] = useState<Suggestion[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/business/bot/learning-suggestions", {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
        cache: "no-store",
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setItems(data.suggestions ?? []);
    } catch {
      setError(t("content.bot.common.errors.loadSuggestions"));
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

  async function act(id: number, action: "adopt" | "dismiss") {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/business/bot/learning-suggestions/${id}/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      if (!res.ok) {
        setError(t("content.bot.common.errors.actionFailed"));
        return;
      }
      // Both adopt + dismiss remove the item from the PROPOSED list.
      setItems((cur) => cur.filter((s) => s.id !== id));
    } catch {
      setError(t("content.bot.common.networkError"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={screenWrap}>
        <AreaHeader
          title={t("content.bot.learning.title")}
          subtitle={t("content.bot.learning.subtitle")}
          backHref="/business/bot"
          backLabel={t("content.bot.common.myBot")}
        />
        {loading ? (
          <p style={{ margin: 18, color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>{t("content.bot.common.loading")}</p>
        ) : (
          <>
            {error ? (
              <div role="alert" style={{ margin: "12px 18px 0", background: TOKEN.semantic.urgent.bgSoft, color: TOKEN.semantic.urgent.ink, padding: "10px 12px", borderRadius: TOKEN.radius.input, fontSize: TOKEN.font.meta }}>
                {error}
              </div>
            ) : null}

            {items.length === 0 ? (
              <div style={{ margin: "24px 18px", textAlign: "center", color: TOKEN.ink.muted }}>
                <div style={{ fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.secondary }}>
                  {t("content.bot.hub.learning.emptyTitle")}
                </div>
                <p style={{ marginTop: 6, fontSize: TOKEN.font.meta, lineHeight: 1.5 }}>
                  {t("content.bot.learning.emptyBody")}
                </p>
              </div>
            ) : (
              <section style={{ display: "grid", gap: 11, padding: "16px 18px 0" }}>
                {items.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      border: `1px solid ${TOKEN.brand.softBorder}`,
                      background: TOKEN.brand.soft,
                      borderRadius: TOKEN.radius.card,
                      padding: 15,
                    }}
                  >
                    <div style={{ fontSize: TOKEN.font.caption, fontWeight: TOKEN.weight.bold, color: TOKEN.brand.mid }}>
                      {botOptionLabel(t, "learningType", s.type, LEARNING_TYPE_LABELS[s.type as LearningType] ?? t("content.bot.common.suggestion"))}
                    </div>
                    <div style={{ marginTop: 6, fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary, lineHeight: 1.4 }}>
                      {s.title}
                    </div>
                    {s.description ? (
                      <div style={{ marginTop: 5, fontSize: TOKEN.font.meta, color: TOKEN.ink.secondary, lineHeight: 1.45 }}>
                        {s.description}
                      </div>
                    ) : null}
                    <div style={{ display: "flex", gap: 9, marginTop: 12 }}>
                      <button
                        type="button"
                        disabled={busyId === s.id}
                        onClick={() => void act(s.id, "adopt")}
                        style={{
                          flex: 1,
                          height: 40,
                          borderRadius: TOKEN.radius.input,
                          border: 0,
                          background: TOKEN.action.primary.background,
                          color: TOKEN.ink.inverse,
                          fontFamily: "inherit",
                          fontWeight: TOKEN.weight.bold,
                          fontSize: TOKEN.font.body,
                          cursor: busyId === s.id ? "not-allowed" : "pointer",
                        }}
                      >
                        {t("content.bot.learning.adopt")}
                      </button>
                      <button
                        type="button"
                        disabled={busyId === s.id}
                        onClick={() => void act(s.id, "dismiss")}
                        style={{
                          flex: 1,
                          height: 40,
                          borderRadius: TOKEN.radius.input,
                          border: `1px solid ${TOKEN.border.hover}`,
                          background: TOKEN.surface.card,
                          color: TOKEN.ink.muted,
                          fontFamily: "inherit",
                          fontWeight: TOKEN.weight.bold,
                          fontSize: TOKEN.font.body,
                          cursor: busyId === s.id ? "not-allowed" : "pointer",
                        }}
                      >
                        {t("content.bot.learning.dismiss")}
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            )}

            <GuardNote>
              {t("content.bot.learning.guard")}
            </GuardNote>
          </>
        )}
      </main>
    </div>
  );
}
