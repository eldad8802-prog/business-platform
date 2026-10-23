"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { TOKEN } from "@/lib/design/bot-theme";
import {
  BOT_AUDIENCE_OPTIONS,
  BOT_INITIATIVE_OPTIONS,
  BOT_LANGUAGE_OPTIONS,
  BOT_PRIORITY_OPTIONS,
  BOT_SALE_STYLE_OPTIONS,
  BOT_TONE_OPTIONS,
  BOT_TRAIT_OPTIONS,
  BOT_VERBOSITY_OPTIONS,
  type BotApproachConfig,
  type BotAudienceTag,
  type BotInitiativeLevel,
  type BotLanguage,
  type BotPersonalityConfig,
  type BotPriority,
  type BotProfileObjection,
  type BotSaleStyle,
  type BotTone,
  type BotTrait,
  type BotVerbosity,
  type BotVoiceConfig,
} from "@/lib/features/bot";
import {
  AreaHeader,
  BUILDER_SHELL_MAX_WIDTH,
  BuilderTextField,
  GuardNote,
  StickyActionBar,
  areaPanelStyle,
} from "./bot-builder-area-ui";
import { useI18n } from "@/components/i18n/I18nProvider";
import { localizeValueHintOptions, localizeValueOptions } from "./bot-i18n";

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

type BotApiResponse = {
  identity?: { displayName: string | null; avatar: string | null };
  profile?: {
    voice?: BotVoiceConfig;
    personality?: BotPersonalityConfig;
    approach?: BotApproachConfig;
  };
};

/** Shared state for all BusinessBot profile-backed screens. */
function useBotProfileState() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [tone, setTone] = useState<BotTone | null>(null);
  const [languages, setLanguages] = useState<BotLanguage[]>([]);
  const [audienceTags, setAudienceTags] = useState<BotAudienceTag[]>([]);
  const [traits, setTraits] = useState<BotTrait[]>([]);
  const [verbosity, setVerbosity] = useState<BotVerbosity | null>(null);
  const [saleStyle, setSaleStyle] = useState<BotSaleStyle | null>(null);
  const [initiativeLevel, setInitiativeLevel] = useState<BotInitiativeLevel | null>(null);
  const [priorities, setPriorities] = useState<BotPriority[]>([]);
  const [objections, setObjections] = useState<BotProfileObjection[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/business/bot", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) throw new Error();
      const data: BotApiResponse = await res.json();
      setDisplayName(data.identity?.displayName ?? "");
      const v = data.profile?.voice;
      setTone(v?.tone ?? null);
      setLanguages(v?.languages ?? []);
      setAudienceTags(v?.audienceTags ?? []);
      const p = data.profile?.personality;
      setTraits(p?.traits ?? []);
      setVerbosity(p?.verbosity ?? null);
      const a = data.profile?.approach;
      setSaleStyle(a?.saleStyle ?? null);
      setInitiativeLevel(a?.initiativeLevel ?? null);
      setPriorities(a?.priorities ?? []);
      setObjections(a?.objections ?? []);
    } catch {
      setError(t("content.bot.common.errors.loadProfile"));
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

  const patch = useCallback(async (body: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/business/bot", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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
        return false;
      }
      setSavedOk(true);
      window.setTimeout(() => setSavedOk(false), 2500);
      await load();
      return true;
    } catch {
      setError(t("content.bot.common.networkError"));
      return false;
    } finally {
      setSaving(false);
    }
  }, [load, t]);

  const voiceBlock = useMemo<BotVoiceConfig>(() => {
    const block: BotVoiceConfig = {};
    if (tone) block.tone = tone;
    if (languages.length) block.languages = languages;
    if (audienceTags.length) block.audienceTags = audienceTags;
    return block;
  }, [tone, languages, audienceTags]);

  const personalityBlock = useMemo<BotPersonalityConfig>(() => {
    const block: BotPersonalityConfig = {};
    if (traits.length) block.traits = traits;
    if (verbosity) block.verbosity = verbosity;
    return block;
  }, [traits, verbosity]);

  const approachBlock = useMemo<BotApproachConfig>(() => {
    const block: BotApproachConfig = {};
    if (saleStyle) block.saleStyle = saleStyle;
    if (initiativeLevel) block.initiativeLevel = initiativeLevel;
    if (priorities.length) block.priorities = priorities;
    const cleanObjections = objections
      .map((o) => ({ label: o.label.trim(), response: o.response.trim() }))
      .filter((o) => o.label.length > 0);
    if (cleanObjections.length) block.objections = cleanObjections;
    return block;
  }, [saleStyle, initiativeLevel, priorities, objections]);

  const saveIdentityAndVoice = useCallback(
    () =>
      patch({
        displayName: displayName.trim() === "" ? null : displayName.trim(),
        profile: { voice: voiceBlock },
      }),
    [patch, displayName, voiceBlock]
  );
  const savePersonality = useCallback(
    () => patch({ profile: { personality: personalityBlock } }),
    [patch, personalityBlock]
  );
  const saveApproach = useCallback(
    () => patch({ profile: { approach: approachBlock } }),
    [patch, approachBlock]
  );

  return {
    loading,
    saving,
    error,
    savedOk,
    setError,
    setSavedOk,
    displayName,
    setDisplayName,
    tone,
    setTone,
    languages,
    setLanguages,
    audienceTags,
    setAudienceTags,
    traits,
    setTraits,
    verbosity,
    setVerbosity,
    saleStyle,
    setSaleStyle,
    initiativeLevel,
    setInitiativeLevel,
    priorities,
    setPriorities,
    objections,
    setObjections,
    saveIdentityAndVoice,
    savePersonality,
    saveApproach,
  };
}

type ProfileState = ReturnType<typeof useBotProfileState>;

function toggleIn<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
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

const sectionLabel: CSSProperties = {
  padding: "20px 18px 8px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
  color: TOKEN.ink.muted,
};

function ChipMulti<T extends string>({
  options,
  selected,
  onToggle,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  selected: T[];
  onToggle: (value: T) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "0 18px" }}>
      {options.map((opt) => {
        const on = selected.includes(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(opt.value)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              height: 40,
              padding: "0 15px",
              borderRadius: TOKEN.radius.pill,
              border: `1px solid ${on ? TOKEN.brand.mid : TOKEN.border.DEFAULT}`,
              background: on ? TOKEN.brand.soft : TOKEN.surface.inset,
              color: on ? TOKEN.brand.mid : TOKEN.ink.primary,
              fontFamily: "inherit",
              fontWeight: TOKEN.weight.bold,
              fontSize: TOKEN.font.body,
              cursor: "pointer",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ScaleSingle<T extends string>({
  options,
  selected,
  onSelect,
}: {
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  selected: T | null;
  onSelect: (value: T) => void;
}) {
  return (
    <div style={{ margin: "0 18px", display: "grid", gap: 9 }}>
      {options.map((opt) => {
        const on = selected === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(opt.value)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 13,
              padding: 14,
              borderRadius: TOKEN.radius.card,
              border: `1px solid ${on ? TOKEN.brand.mid : TOKEN.border.DEFAULT}`,
              background: on ? TOKEN.brand.soft : TOKEN.surface.card,
              cursor: "pointer",
              textAlign: "start",
              fontFamily: "inherit",
              width: "100%",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 20,
                height: 20,
                borderRadius: TOKEN.radius.pill,
                border: `${on ? 6 : 2}px solid ${on ? TOKEN.brand.mid : TOKEN.border.hover}`,
                flexShrink: 0,
                boxSizing: "border-box",
              }}
            />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>
                {opt.label}
              </span>
              {opt.hint ? (
                <span style={{ display: "block", marginTop: 2, fontSize: TOKEN.font.meta, color: TOKEN.ink.muted }}>
                  {opt.hint}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Loading() {
  const { t } = useI18n();
  return (
    <p style={{ margin: 18, color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>{t("content.bot.common.loading")}</p>
  );
}

// ── Personality ──────────────────────────────────────────────────────────────
export function PersonalityFlagshipScreen() {
  const { t } = useI18n();
  const s = useBotProfileState();
  return (
    <div style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={screenWrap}>
        <AreaHeader
          title={t("content.bot.profile.personality.title")}
          subtitle={t("content.bot.profile.personality.subtitle")}
          backHref="/business/bot"
          backLabel={t("content.bot.common.myBot")}
        />
        {s.loading ? (
          <Loading />
        ) : (
          <>
            <div style={sectionLabel}>{t("content.bot.hub.personality.traits")}</div>
            <ChipMulti
              options={localizeValueOptions(t, "trait", BOT_TRAIT_OPTIONS)}
              selected={s.traits}
              onToggle={(v) => s.setTraits((list) => toggleIn(list, v))}
            />
            <div style={sectionLabel}>{t("content.bot.hub.personality.verbosity")}</div>
            <ScaleSingle
              options={localizeValueHintOptions(t, "verbosity", BOT_VERBOSITY_OPTIONS)}
              selected={s.verbosity}
              onSelect={s.setVerbosity}
            />
            <GuardNote>
              {t("content.bot.profile.personality.guard")}
            </GuardNote>
            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void s.savePersonality()}
              saving={s.saving}
              saved={s.savedOk}
              error={s.error}
              saveLabel={t("content.bot.common.save")}
            />
          </>
        )}
      </main>
    </div>
  );
}

// ── Approach ─────────────────────────────────────────────────────────────────
export function ApproachFlagshipScreen() {
  const { t } = useI18n();
  const s = useBotProfileState();
  return (
    <div style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={screenWrap}>
        <AreaHeader
          title={t("content.bot.profile.approach.title")}
          subtitle={t("content.bot.profile.approach.subtitle")}
          backHref="/business/bot"
          backLabel={t("content.bot.common.myBot")}
        />
        {s.loading ? (
          <Loading />
        ) : (
          <>
            <div style={sectionLabel}>{t("content.bot.hub.approach.saleStyle")}</div>
            <ScaleSingle
              options={localizeValueHintOptions(t, "saleStyle", BOT_SALE_STYLE_OPTIONS)}
              selected={s.saleStyle}
              onSelect={s.setSaleStyle}
            />
            <div style={sectionLabel}>{t("content.bot.hub.approach.initiative")}</div>
            <ScaleSingle
              options={localizeValueOptions(t, "initiative", BOT_INITIATIVE_OPTIONS)}
              selected={s.initiativeLevel}
              onSelect={s.setInitiativeLevel}
            />
            <div style={sectionLabel}>{t("content.bot.hub.approach.priorities")}</div>
            <ChipMulti
              options={localizeValueOptions(t, "priority", BOT_PRIORITY_OPTIONS)}
              selected={s.priorities}
              onToggle={(v) => s.setPriorities((list) => toggleIn(list, v))}
            />
            <GuardNote>
              {t("content.bot.profile.approach.guard")}
            </GuardNote>
            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void s.saveApproach()}
              saving={s.saving}
              saved={s.savedOk}
              error={s.error}
              saveLabel={t("content.bot.common.save")}
            />
          </>
        )}
      </main>
    </div>
  );
}

// ── Voice (identity name + tone/languages/audience) + welcome via settings ───
export function VoiceProfileScreen({
  welcomeMessage,
  onWelcomeChange,
  onSaveWelcome,
}: {
  welcomeMessage: string;
  onWelcomeChange: (value: string) => void;
  onSaveWelcome: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const s = useBotProfileState();
  const [combinedSaving, setCombinedSaving] = useState(false);
  const [combinedSaved, setCombinedSaved] = useState(false);
  const [combinedError, setCombinedError] = useState<string | null>(null);

  async function handleSave() {
    setCombinedSaving(true);
    setCombinedError(null);
    setCombinedSaved(false);
    try {
      const ok = await s.saveIdentityAndVoice();
      if (!ok) {
        setCombinedError(s.error ?? t("content.bot.profile.voice.saveError"));
        return;
      }
      await onSaveWelcome();
      setCombinedSaved(true);
      window.setTimeout(() => setCombinedSaved(false), 2500);
    } finally {
      setCombinedSaving(false);
    }
  }

  return (
    <div style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <main style={screenWrap}>
        <AreaHeader
          title={t("content.bot.hub.areas.voice.title")}
          subtitle={t("content.bot.profile.voice.subtitle")}
          backHref="/business/bot"
          backLabel={t("content.bot.common.myBot")}
        />
        {s.loading ? (
          <Loading />
        ) : (
          <>
            <section style={{ ...areaPanelStyle, padding: "16px 0" }}>
              <BuilderTextField
                label={t("content.bot.common.botName")}
                hint={t("content.bot.profile.voice.nameHint")}
                value={s.displayName}
                onChange={s.setDisplayName}
                placeholder={t("content.bot.common.botName")}
              />
            </section>

            <div style={sectionLabel}>{t("content.bot.hub.voice.tone")}</div>
            <ChipMulti
              options={localizeValueOptions(t, "tone", BOT_TONE_OPTIONS)}
              selected={s.tone ? [s.tone] : []}
              onToggle={(v) => s.setTone((cur) => (cur === v ? null : v))}
            />

            <div style={sectionLabel}>{t("content.bot.hub.voice.languages")}</div>
            <ChipMulti
              options={localizeValueOptions(t, "language", BOT_LANGUAGE_OPTIONS)}
              selected={s.languages}
              onToggle={(v) => s.setLanguages((list) => toggleIn(list, v))}
            />

            <div style={sectionLabel}>{t("content.bot.profile.voice.audience")}</div>
            <ChipMulti
              options={localizeValueOptions(t, "audience", BOT_AUDIENCE_OPTIONS)}
              selected={s.audienceTags}
              onToggle={(v) => s.setAudienceTags((list) => toggleIn(list, v))}
            />

            <section style={{ ...areaPanelStyle, padding: "16px 0", marginTop: 18 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 8, margin: "0 18px" }}>
                <span style={{ color: TOKEN.ink.primary, fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold }}>
                  {t("content.bot.common.welcomeMessage")}
                </span>
                <span style={{ color: TOKEN.ink.muted, fontSize: TOKEN.font.meta }}>
                  {t("content.bot.profile.voice.welcomeHint")}
                </span>
                <textarea
                  value={welcomeMessage}
                  onChange={(e) => onWelcomeChange(e.target.value)}
                  rows={4}
                  placeholder="לדוגמה: היי! איך אפשר לעזור היום?"
                  style={{
                    width: "100%",
                    minHeight: 110,
                    border: `1px solid ${TOKEN.border.DEFAULT}`,
                    borderRadius: TOKEN.radius.input,
                    background: TOKEN.surface.inset,
                    padding: "13px 14px",
                    color: TOKEN.ink.primary,
                    fontFamily: "inherit",
                    fontSize: TOKEN.font.body,
                    lineHeight: 1.5,
                    resize: "vertical",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </label>
            </section>

            <GuardNote>
              {t("content.bot.profile.voice.guard")}
            </GuardNote>
            <div style={{ flex: 1 }} />
            <StickyActionBar
              onSave={() => void handleSave()}
              saving={combinedSaving || s.saving}
              saved={combinedSaved}
              error={combinedError}
              saveLabel={t("content.bot.common.save")}
            />
          </>
        )}
      </main>
    </div>
  );
}
