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
import { useI18n } from "@/components/i18n/I18nProvider";
import { localizeKeyOptions } from "./bot-i18n";

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
  const { t } = useI18n();
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
      setError(t("content.bot.memory.loadError"));
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

  return (
    <div style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={screenWrap}>
        <AreaHeader
          title={t("content.bot.memory.title")}
          subtitle={t("content.bot.memory.subtitle")}
          backHref="/business/bot"
          backLabel={t("content.bot.common.myBot")}
        />
        {loading ? (
          <p style={{ margin: 18, color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>{t("content.bot.common.loading")}</p>
        ) : (
          <>
            <div style={{ padding: "20px 18px 8px", fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.muted }}>
              {t("content.bot.hub.memory.section")}
            </div>
            <section style={areaPanelStyle}>
              {localizeKeyOptions(t, "memory", MEMORY_TOGGLE_OPTIONS).map((opt) => (
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
              {t("content.bot.memory.guard")}
            </GuardNote>
            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void handleSave()}
              saving={saving}
              saved={savedOk}
              error={error}
              saveLabel={t("content.bot.hub.memory.save")}
            />
          </>
        )}
      </main>
    </div>
  );
}
