"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { TOKEN } from "@/lib/design/bot-theme";
import BackButton from "@/components/ui/back-button";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import { useMediaQuery } from "@/lib/ui/use-breakpoint";
import { LAYOUT } from "@/lib/design/tokens";
import { BOT_BOUNDARY_OPTIONS, BOT_FORBIDDEN_OPTIONS, BOT_WORK_MODE_OPTIONS_ACTIVE, settingsPatchForWorkMode, type BotBoundaryPresets, type BotForbiddenPresets } from "@/lib/features/conversation/bot-control";
import { FINAL_ACTION_OPTIONS as FINAL_ACTIONS, type FinalAction } from "@/lib/features/conversation/final-action";
import { BOT_AUDIENCE_OPTIONS, BOT_INITIATIVE_OPTIONS, BOT_LANGUAGE_OPTIONS, BOT_PRIORITY_OPTIONS, BOT_SALE_STYLE_OPTIONS, BOT_TONE_OPTIONS, BOT_TRAIT_OPTIONS, BOT_VERBOSITY_OPTIONS, LEARNING_TYPE_LABELS, MAX_FAQ_ITEMS, MEMORY_TOGGLE_OPTIONS, emptyMemoryPolicy, type BotApproachConfig, type BotAudienceTag, type BotInitiativeLevel, type BotLanguage, type BotMemoryPolicy, type BotPersonalityConfig, type BotPriority, type BotSaleStyle, type BotTone, type BotTrait, type BotVerbosity, type BotVoiceConfig, type FaqItem, type LearningType, type MemoryToggleKey } from "@/lib/features/bot";
import { BUILDER_SHELL_MAX_WIDTH, BuilderTextAreaField, BuilderTextField, ChoiceRow, GuardNote, Stepper, StickyActionBar, ToggleRow, areaPanelStyle } from "../bot-settings/_components/bot-builder-area-ui";
import hub from "./bot-hub.module.css";
import { GoalLibrary } from "../bot-settings/_components/bot-goals-screen";
import { useBotSettingsEditorState } from "../bot-settings/_components/bot-settings-editor";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";
import { botOptionLabel, localizeKeyOptions, localizeValueHintOptions, localizeValueOptions, localizeWorkModes } from "../bot-settings/_components/bot-i18n";

/** The shell's desktop tier — where its nav becomes a sidebar, not a bottom bar. */
const SHELL_DESKTOP_MIN = `(min-width: ${LAYOUT.bp.expanded}px)`;

type Status = "live" | "saved" | "soon";
type CategoryId = "identity" | "conversation" | "limits" | "future";
type AreaId = "goal" | "personality" | "voice" | "conversation" | "approach" | "knowledge" | "allowed" | "autonomy" | "forbidden" | "handoff" | "memory" | "learning";
type HubPayload = { identity: { displayName: string | null; avatar: string | null }; runtime: { workMode: string }; signals: { welcomeOk: boolean; questionsCount: number; finishOk: boolean; productLinkOk: boolean; workModeManual: boolean; goalsCount: number; learningCount: number; personalityOk: boolean; approachOk: boolean; knowledgeOk: boolean } };

type AreaMeta = { id: AreaId; status: Status };
type CategoryMeta = { id: CategoryId; areas: AreaId[] };

const CATEGORIES: CategoryMeta[] = [
  { id: "identity", areas: ["goal", "personality", "voice"] },
  { id: "conversation", areas: ["conversation", "approach", "knowledge"] },
  { id: "limits", areas: ["allowed", "autonomy", "forbidden", "handoff"] },
  { id: "future", areas: ["memory", "learning"] },
];
const AREAS: Record<AreaId, AreaMeta> = {
  goal: { id: "goal", status: "saved" },
  personality: { id: "personality", status: "saved" },
  voice: { id: "voice", status: "saved" },
  conversation: { id: "conversation", status: "live" },
  approach: { id: "approach", status: "saved" },
  knowledge: { id: "knowledge", status: "saved" },
  allowed: { id: "allowed", status: "live" },
  autonomy: { id: "autonomy", status: "live" },
  forbidden: { id: "forbidden", status: "soon" },
  handoff: { id: "handoff", status: "live" },
  memory: { id: "memory", status: "soon" },
  learning: { id: "learning", status: "soon" },
};

function getAuthToken(): string { if (typeof window === "undefined") return "1"; return localStorage.getItem("token") || "1"; }
function catText(t: Translator, id: CategoryId, field: "title" | "sub"): string { return t(`content.bot.hub.categories.${id}.${field}`); }
function areaText(t: Translator, id: AreaId, field: "title" | "sub" | "desc"): string { return t(`content.bot.hub.areas.${id}.${field}`); }
function statusText(s: Status, t: Translator) { return t(`content.bot.hub.status.${s}`); }
function areaSummary(id: AreaId, p: HubPayload | null, t: Translator) { const s = p?.signals; if (id === "goal") return s?.goalsCount ? t("content.bot.hub.summary.goalsMany", { count: s.goalsCount }) : t("content.bot.hub.summary.goalsNone"); if (id === "conversation") return s?.questionsCount ? t("content.bot.hub.summary.questionsMany", { count: s.questionsCount }) : t("content.bot.hub.summary.questionsNone"); if (id === "voice") return s?.welcomeOk ? t("content.bot.hub.summary.welcomeOk") : t("content.bot.hub.summary.welcomeMissing"); if (id === "allowed") return s?.finishOk ? t("content.bot.hub.summary.finishOk") : t("content.bot.hub.summary.finishMissing"); if (id === "autonomy") return s?.workModeManual ? t("content.bot.hub.summary.autonomyManual") : t("content.bot.hub.summary.autonomySmart"); if (id === "learning") return s?.learningCount ? t("content.bot.hub.summary.learningMany", { count: s.learningCount }) : t("content.bot.hub.summary.learningNone"); if (id === "knowledge") return s?.productLinkOk || s?.knowledgeOk ? t("content.bot.hub.summary.knowledgeOk") : t("content.bot.hub.summary.knowledgeMissing"); if (id === "personality") return s?.personalityOk ? t("content.bot.hub.summary.personalityOk") : t("content.bot.hub.summary.personalityMissing"); if (id === "approach") return s?.approachOk ? t("content.bot.hub.summary.approachOk") : t("content.bot.hub.summary.approachMissing"); return areaText(t, id, "desc"); }

export default function BusinessBotHubPage() {
  const { t } = useI18n();
  const settings = useBotSettingsEditorState();
  const goals = useGoalsState();
  const memory = useMemoryPolicyState();
  const profile = useBotProfileState();
  const knowledge = useKnowledgeState();
  const learning = useLearningState();
  const router = useRouter();
  const [payload, setPayload] = useState<HubPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState<CategoryId | null>(null);
  const [area, setArea] = useState<AreaId | null>(null);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  /**
   * The chrome was hidden unconditionally, with the stated reason that the
   * builder's full-screen setting sheets must not have the app's fixed bottom
   * nav floating over them. That reason is real — but it is about *sheets*, and
   * it only describes the bottom bar. From the shell's desktop tier the nav is
   * a sidebar, so on desktop the page was giving up the owner's navigation for
   * a conflict that does not exist there.
   *
   * So the hiding is tied to the thing it was always about. A sheet is open
   * exactly when `cat` is set, and while it is, the chrome yields: the sheet's
   * dimming overlay sits at z-index 20 and the shell sidebar at 40, so leaving
   * the sidebar up would place live navigation *above* a modal's scrim and let
   * the owner navigate out of a half-finished sheet.
   *
   * Below the desktop tier nothing changes — the chrome stays hidden exactly as
   * before. Only a boolean passed to an existing hook changes; the page's React
   * tree is identical either side of the tier, so nothing remounts.
   */
  const isDesktop = useMediaQuery(SHELL_DESKTOP_MIN);
  useHideShellChrome(!isDesktop || cat !== null);

  const load = useCallback(async () => { setLoading(true); setError(null); try { const res = await fetch("/api/business/bot-hub", { headers: { Authorization: "Bearer " + getAuthToken() }, cache: "no-store" }); if (!res.ok) throw new Error(); setPayload(await res.json() as HubPayload); } catch { setError(t("content.bot.hub.loadError")); } finally { setLoading(false); } }, [t]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (!cancelled) void load(); }); return () => { cancelled = true; }; }, [load]);

  const currentCat = cat ? CATEGORIES.find((c) => c.id === cat) || null : null;
  const currentArea = area ? AREAS[area] : null;
  const botName = payload?.identity.displayName || t("content.bot.common.defaultBotName");
  const botStatus = payload?.runtime.workMode === "MANUAL" ? t("content.bot.hub.statusManual") : t("content.bot.hub.statusActive");
  function closeOne() { if (area) setArea(null); else setCat(null); }
  function closeAll() { setArea(null); setCat(null); }

  // Fix-2: connect the EXISTING path SetupDraft -> Assemble -> Activate. Assembles
  // a base from the selected goals, then activates (server-side materialization
  // of welcome/questions/finalAction only). Never writes BusinessBotSettings from
  // here, never touches workMode/enabled. The result is stashed for the success
  // page BEFORE redirect, so it no longer relies on an unwritten key.
  async function handleActivate() {
    if (goals.selected.length === 0) {
      setActivateError(t("content.bot.hub.activateNeedGoals"));
      return;
    }
    setActivating(true);
    setActivateError(null);
    try {
      const headers = { Authorization: "Bearer " + getAuthToken(), "Content-Type": "application/json" };
      const asm = await fetch("/api/business/bot/setup/assemble", { method: "POST", headers, body: JSON.stringify({ goals: goals.selected }) });
      if (!asm.ok) { setActivateError(t("content.bot.hub.assembleFailed")); return; }
      const act = await fetch("/api/business/bot/setup/activate", { method: "POST", headers });
      const result = await act.json().catch(() => null);
      if (!act.ok) { setActivateError((result && result.error) || t("content.bot.hub.activateFailed")); return; }
      try { window.sessionStorage.setItem("botSetupActivationResult", JSON.stringify(result)); } catch { /* ignore */ }
      // Client navigation keeps the history trail (the success page is
      // transient: back from the bot skips it).
      router.push("/business/bot/setup/success");
    } catch {
      setActivateError(t("content.bot.hub.networkRetry"));
    } finally {
      setActivating(false);
    }
  }

  return <div style={{ minHeight: "100dvh", background: TOKEN.surface.page }}><main className={hub.shell} style={shellStyle}>
    <div style={{ paddingBottom: 44 }}>
      <header style={{ padding: "18px 18px 4px", display: "flex", alignItems: "center", gap: 12 }}><BackButton /><h1 style={{ margin: 0, color: TOKEN.ink.primary, fontSize: TOKEN.font.hero, fontWeight: TOKEN.weight.bold }}>{t("content.bot.hub.title")}</h1></header>
      <p style={{ margin: 0, padding: "0 18px", color: TOKEN.ink.muted, fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.semibold, lineHeight: 1.55 }}>{t("content.bot.hub.intro")}</p>
      {loading ? <p style={{ margin: "14px 18px", color: TOKEN.ink.meta }}>{t("content.bot.common.loading")}</p> : null}{error ? <p style={{ margin: "14px 18px", color: TOKEN.semantic.urgent.ink }}>{error}</p> : null}
      <section style={heroStyle}><div style={heroIconStyle}><BotIcon /></div><div style={{ minWidth: 0, flex: 1 }}><div style={{ fontSize: TOKEN.font.display, fontWeight: TOKEN.weight.bold, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{botName}</div><div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 7, fontSize: TOKEN.font.meta, opacity: 0.92 }}><span style={{ width: 7, height: 7, borderRadius: TOKEN.radius.pill, background: TOKEN.semantic.success.accent }} />{botStatus}</div></div></section>
      <div style={{ padding: "22px 20px 10px", fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.muted }}>{t("content.bot.hub.yourSettings")}</div>
      <div className={hub.cats}>{CATEGORIES.map((c) => <button key={c.id} type="button" onClick={() => { setCat(c.id); setArea(null); }} style={catCardStyle}><div style={{ display: "flex", alignItems: "center", gap: 13 }}><div style={{ ...catIconStyle, ...categoryIconTone(c.id) }}><CategoryIcon id={c.id} /></div><div style={{ flex: 1, minWidth: 0, textAlign: "start" }}><div style={{ fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>{catText(t, c.id, "title")}</div><div style={{ marginTop: 2, fontSize: TOKEN.font.meta, color: TOKEN.ink.muted }}>{catText(t, c.id, "sub")}</div></div><Chevron /></div><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 13 }}>{c.areas.map((id) => <span key={id} style={previewChipStyle}>{areaText(t, id, "sub")}</span>)}</div></button>)}</div>
      <section style={{ margin: "20px 18px 0", padding: 16, borderRadius: TOKEN.radius.card, border: "1px solid " + TOKEN.border.DEFAULT, background: TOKEN.surface.card }}>
        <div style={{ fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>{t("content.bot.hub.activateTitle")}</div>
        <p style={{ margin: "6px 0 0", fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, lineHeight: 1.5 }}>{t("content.bot.hub.activateBody")}</p>
        {activateError ? <div role="alert" style={{ ...alertStyle, margin: "10px 0 0" }}>{activateError}</div> : null}
        <button type="button" onClick={() => void handleActivate()} disabled={activating} style={{ width: "100%", minHeight: 50, marginTop: 12, border: 0, borderRadius: TOKEN.radius.card, background: TOKEN.action.primary.background, color: TOKEN.ink.inverse, fontFamily: "inherit", fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.title, cursor: activating ? "not-allowed" : "pointer", opacity: activating ? 0.7 : 1, boxShadow: TOKEN.action.primary.shadow }}>{activating ? t("content.bot.hub.activating") : t("content.bot.hub.activateCta")}</button>
      </section>
      <GuardNote>{t("content.bot.hub.guard")}</GuardNote>
    </div>
    {cat ? <><button type="button" aria-label={t("content.bot.common.close")} onClick={closeAll} style={overlayStyle} /><section role="dialog" aria-modal="true" style={{ ...sheetStyle, maxHeight: area ? "92dvh" : "88dvh" }}><div style={gripStyle} /><header style={sheetHeadStyle}>{area ? <button type="button" onClick={() => setArea(null)} aria-label={t("content.bot.common.back")} style={backButtonStyle}><Chevron /></button> : null}{currentArea ? <div style={{ ...rowIconStyle, ...areaIconTone(currentArea.id) }}><SettingIcon id={currentArea.id} /></div> : null}<div style={{ flex: 1, minWidth: 0 }}>{area && currentCat ? <div style={{ fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, fontWeight: TOKEN.weight.bold }}>{catText(t, currentCat.id, "title")}</div> : null}<div style={{ fontSize: TOKEN.font.display, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>{currentArea ? areaText(t, currentArea.id, "title") : currentCat ? catText(t, currentCat.id, "title") : null}</div></div><button type="button" onClick={closeOne} aria-label={t("content.bot.common.close")} style={xButtonStyle}>×</button></header>{!area && currentCat ? <><p style={sheetDescStyle}>{catText(t, currentCat.id, "sub")}</p><div style={sheetBodyStyle}>{currentCat.areas.map((id) => <button key={id} type="button" onClick={() => setArea(id)} style={rowStyle}><div style={{ ...rowIconStyle, ...areaIconTone(id) }}><SettingIcon id={id} /></div><div style={{ flex: 1, textAlign: "start" }}><div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}><span style={{ fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.bold }}>{areaText(t, id, "title")}</span><Pill status={AREAS[id].status} /></div><div style={{ marginTop: 2, color: TOKEN.ink.muted, fontSize: TOKEN.font.meta }}>{areaSummary(id, payload, t)}</div></div><Chevron /></button>)}<div style={{ height: 26 }} /></div></> : currentArea ? <div style={sheetBodyStyle}><div style={{ padding: "0 18px 8px" }}><Pill status={currentArea.status} /><p style={{ margin: "8px 0 0", color: TOKEN.ink.muted, fontSize: TOKEN.font.meta, lineHeight: 1.5 }}>{areaText(t, currentArea.id, "desc")}</p></div><Editor area={currentArea.id} settings={settings} goals={goals} memory={memory} profile={profile} knowledge={knowledge} learning={learning} /></div> : null}</section></> : null}
  </main></div>;
}

function Editor({ area, settings, goals, memory, profile, knowledge, learning }: { area: AreaId; settings: ReturnType<typeof useBotSettingsEditorState>; goals: ReturnType<typeof useGoalsState>; memory: ReturnType<typeof useMemoryPolicyState>; profile: ReturnType<typeof useBotProfileState>; knowledge: ReturnType<typeof useKnowledgeState>; learning: ReturnType<typeof useLearningState> }) {
  if (area === "goal") return <GoalEditor goals={goals} />;
  if (area === "personality") return <PersonalityEditor profile={profile} />;
  if (area === "voice") return <VoiceEditor settings={settings} profile={profile} />;
  if (area === "conversation") return <ConversationEditor settings={settings} />;
  if (area === "approach") return <ApproachEditor profile={profile} />;
  if (area === "knowledge") return <KnowledgeEditor settings={settings} knowledge={knowledge} />;
  if (area === "allowed") return <AllowedEditor settings={settings} />;
  if (area === "autonomy") return <AutonomyEditor settings={settings} />;
  if (area === "forbidden") return <ForbiddenEditor settings={settings} />;
  if (area === "handoff") return <HandoffEditor settings={settings} />;
  if (area === "memory") return <MemoryEditor memory={memory} />;
  return <LearningEditor learning={learning} />;
}

function GoalEditor({ goals }: { goals: ReturnType<typeof useGoalsState> }) {
  const { t } = useI18n();
  if (goals.loading) return <LoadingLine />;
  return <><div style={{ padding: "8px 18px 0" }}><span style={countPillStyle}>{goals.selected.length ? t("content.bot.hub.goal.selectedMany", { count: goals.selected.length }) : t("content.bot.hub.summary.goalsNone")}</span></div><GoalLibrary selected={goals.selected} onToggle={goals.toggle} /><GuardNote>{t("content.bot.hub.goal.guard")}</GuardNote><StickyActionBar onSave={() => void goals.save()} saving={goals.saving} saved={goals.savedOk} error={goals.error} saveLabel={t("content.bot.hub.goal.save")} /></>;
}
function PersonalityEditor({ profile }: { profile: ReturnType<typeof useBotProfileState> }) {
  const { t } = useI18n();
  if (profile.loading) return <LoadingLine />;
  return <><SectionLabel>{t("content.bot.hub.personality.traits")}</SectionLabel><ChipMulti options={localizeValueOptions(t, "trait", BOT_TRAIT_OPTIONS)} selected={profile.traits} onToggle={(v) => profile.setTraits((list) => toggleIn(list, v))} /><SectionLabel>{t("content.bot.hub.personality.verbosity")}</SectionLabel><ScaleSingle options={localizeValueHintOptions(t, "verbosity", BOT_VERBOSITY_OPTIONS)} selected={profile.verbosity} onSelect={profile.setVerbosity} /><GuardNote>{t("content.bot.hub.personality.guard")}</GuardNote><StickyActionBar onSave={() => void profile.savePersonality()} saving={profile.saving} saved={profile.savedOk} error={profile.error} saveLabel={t("content.bot.common.save")} /></>;
}
function VoiceEditor({ settings, profile }: { settings: ReturnType<typeof useBotSettingsEditorState>; profile: ReturnType<typeof useBotProfileState> }) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (settings.loading || profile.loading) return <LoadingLine />;
  async function saveAll() { setSaving(true); setSaved(false); setError(null); try { const ok = await profile.saveIdentityAndVoice(); if (!ok) { setError(profile.error || t("content.bot.hub.voice.saveError")); return; } await settings.handleSave(); setSaved(true); window.setTimeout(() => setSaved(false), 2500); } catch { setError(t("content.bot.common.saveFailed")); } finally { setSaving(false); } }
  return <><section style={{ ...areaPanelStyle, padding: "16px 0" }}><BuilderTextField label={t("content.bot.common.botName")} value={profile.displayName} onChange={profile.setDisplayName} placeholder={t("content.bot.common.botName")} /></section><SectionLabel>{t("content.bot.hub.voice.tone")}</SectionLabel><ChipMulti options={localizeValueOptions(t, "tone", BOT_TONE_OPTIONS)} selected={profile.tone ? [profile.tone] : []} onToggle={(v) => profile.setTone((cur) => cur === v ? null : v)} /><SectionLabel>{t("content.bot.hub.voice.languages")}</SectionLabel><ChipMulti options={localizeValueOptions(t, "language", BOT_LANGUAGE_OPTIONS)} selected={profile.languages} onToggle={(v) => profile.setLanguages((list) => toggleIn(list, v))} /><SectionLabel>{t("content.bot.hub.voice.audience")}</SectionLabel><ChipMulti options={localizeValueOptions(t, "audience", BOT_AUDIENCE_OPTIONS)} selected={profile.audienceTags} onToggle={(v) => profile.setAudienceTags((list) => toggleIn(list, v))} /><section style={{ ...areaPanelStyle, padding: "16px 0", marginTop: 18 }}><BuilderTextAreaField label={t("content.bot.common.welcomeMessage")} hint={t("content.bot.hub.voice.welcomeHint")} value={settings.welcomeMessage} onChange={settings.setWelcomeMessage} rows={3} placeholder="היי! איך אפשר לעזור היום?" /></section><GuardNote>{t("content.bot.hub.voice.guard")}</GuardNote><StickyActionBar onSave={() => void saveAll()} saving={saving || settings.saving || profile.saving} saved={saved || settings.savedOk || profile.savedOk} error={error || settings.error || profile.error} saveLabel={t("content.bot.common.save")} /></>;
}
function ConversationEditor({ settings }: { settings: ReturnType<typeof useBotSettingsEditorState> }) {
  const { t } = useI18n();
  if (settings.loading) return <LoadingLine />;
  const questions = settings.questionsLines.split(/\r?\n/).map((q) => q.trim()).filter(Boolean);
  return <><section style={{ ...areaPanelStyle, padding: "16px 0" }}><BuilderTextAreaField label={t("content.bot.hub.conversation.opening")} hint={t("content.bot.hub.conversation.openingHint")} value={settings.welcomeMessage} onChange={settings.setWelcomeMessage} rows={2} placeholder="היי! כמה פרטים ונקבע לך תור" /></section><SectionLabel>{t("content.bot.hub.conversation.steps")}</SectionLabel><div style={{ display: "grid", gap: 0 }}>{questions.length ? questions.map((q, i) => <StepView key={String(i) + q} index={i + 1} text={q} />) : <p style={{ margin: "0 18px", color: TOKEN.ink.muted, fontSize: TOKEN.font.meta }}>{t("content.bot.hub.conversation.noQuestions")}</p>}</div><section style={{ ...areaPanelStyle, padding: "16px 0", marginTop: 14 }}><BuilderTextAreaField label={t("content.bot.hub.conversation.editLegacy")} hint={t("content.bot.hub.conversation.editLegacyHint")} value={settings.questionsLines} onChange={settings.setQuestionsLines} rows={6} placeholder={"מה השם שלך?\nמתי נוח לך?"} /></section><GuardNote>{t("content.bot.hub.conversation.guard")}</GuardNote><StickyActionBar onSave={() => void settings.handleSave()} saving={settings.saving} saved={settings.savedOk} error={settings.error} saveLabel={t("content.bot.common.save")} /></>;
}
function ApproachEditor({ profile }: { profile: ReturnType<typeof useBotProfileState> }) {
  const { t } = useI18n();
  if (profile.loading) return <LoadingLine />;
  return <><SectionLabel>{t("content.bot.hub.approach.saleStyle")}</SectionLabel><ScaleSingle options={localizeValueHintOptions(t, "saleStyle", BOT_SALE_STYLE_OPTIONS)} selected={profile.saleStyle} onSelect={profile.setSaleStyle} /><SectionLabel>{t("content.bot.hub.approach.initiative")}</SectionLabel><ScaleSingle options={localizeValueOptions(t, "initiative", BOT_INITIATIVE_OPTIONS)} selected={profile.initiativeLevel} onSelect={profile.setInitiativeLevel} /><SectionLabel>{t("content.bot.hub.approach.priorities")}</SectionLabel><ChipMulti options={localizeValueOptions(t, "priority", BOT_PRIORITY_OPTIONS)} selected={profile.priorities} onToggle={(v) => profile.setPriorities((list) => toggleIn(list, v))} /><GuardNote>{t("content.bot.hub.approach.guard")}</GuardNote><StickyActionBar onSave={() => void profile.saveApproach()} saving={profile.saving} saved={profile.savedOk} error={profile.error} saveLabel={t("content.bot.common.save")} /></>;
}
function KnowledgeEditor({ settings, knowledge }: { settings: ReturnType<typeof useBotSettingsEditorState>; knowledge: ReturnType<typeof useKnowledgeState> }) {
  const { t } = useI18n();
  if (settings.loading || knowledge.loading) return <LoadingLine />;
  return <><SectionLabel>{t("content.bot.hub.knowledge.section")}</SectionLabel><section style={{ ...areaPanelStyle, padding: "16px 0" }}><div style={{ display: "grid", gap: 16 }}><BuilderTextField label={t("content.bot.hub.knowledge.hours")} value={knowledge.hours} onChange={knowledge.setHours} placeholder={t("content.bot.hub.knowledge.hoursPlaceholder")} /><BuilderTextField label={t("content.bot.hub.knowledge.address")} value={knowledge.address} onChange={knowledge.setAddress} placeholder={t("content.bot.hub.knowledge.addressPlaceholder")} /><BuilderTextAreaField label={t("content.bot.hub.knowledge.notes")} value={knowledge.notes} onChange={knowledge.setNotes} rows={3} placeholder={t("content.bot.hub.knowledge.notesPlaceholder")} /></div></section><SectionLabel>{t("content.bot.hub.knowledge.faq")}</SectionLabel><section style={{ ...areaPanelStyle, padding: "12px 0" }}>{knowledge.faq.length ? knowledge.faq.map((item, i) => <FaqEditor key={i} item={item} index={i} onChange={(patch) => knowledge.updateFaq(i, patch)} onRemove={() => knowledge.removeFaq(i)} />) : <p style={{ margin: "4px 18px", color: TOKEN.ink.muted, fontSize: TOKEN.font.meta }}>{t("content.bot.hub.knowledge.faqEmpty")}</p>}{knowledge.faq.length < MAX_FAQ_ITEMS ? <button type="button" onClick={knowledge.addFaq} style={addButtonStyle}>{t("content.bot.common.addFaq")}</button> : null}</section><SectionLabel>{t("content.bot.hub.knowledge.catalog")}</SectionLabel><section style={areaPanelStyle}><ToggleRow label={t("content.bot.common.offerCatalogLink")} hint={t("content.bot.hub.knowledge.catalogHint")} checked={settings.productLinkEnabled} onChange={settings.setProductLinkEnabled} /><div style={{ display: "grid", gap: 16, padding: "16px 0" }}><BuilderTextField label={t("content.bot.common.pageUrl")} value={settings.productLinkUrl} onChange={settings.setProductLinkUrl} placeholder="https://..." type="url" inputMode="url" dir="ltr" /><BuilderTextAreaField label={t("content.bot.common.linkIntroShort")} value={settings.productLinkIntro} onChange={settings.setProductLinkIntro} rows={2} placeholder="הנה הקישור לקטלוג שלנו" /></div></section><GuardNote>{t("content.bot.hub.knowledge.guard")}</GuardNote><StickyActionBar onSave={() => void knowledge.save(settings.handleSave)} saving={knowledge.saving || settings.saving} saved={knowledge.savedOk || settings.savedOk} error={knowledge.error || settings.error} saveLabel={t("content.bot.hub.knowledge.save")} /></>;
}
function AllowedEditor({ settings }: { settings: ReturnType<typeof useBotSettingsEditorState> }) {
  const { t } = useI18n();
  if (settings.loading) return <LoadingLine />;
  return <><section style={areaPanelStyle}>{FINAL_ACTIONS.map((a) => <ChoiceRow key={a.value} label={botOptionLabel(t, "finalAction", a.value, a.label)} hint={finalActionHint(a.value, t)} selected={settings.finalAction === a.value} onSelect={() => settings.setFinalAction(a.value)} />)}{settings.finalAction === "SEND_LINK" ? <div style={{ padding: "16px 0" }}><BuilderTextField label={t("content.bot.common.linkUrl")} value={settings.websiteUrl} onChange={settings.setWebsiteUrl} placeholder="https://..." type="url" inputMode="url" dir="ltr" /></div> : null}</section><GuardNote>{t("content.bot.hub.allowed.guard")}</GuardNote><StickyActionBar onSave={() => void settings.handleSave()} saving={settings.saving} saved={settings.savedOk} error={settings.error} saveLabel={t("content.bot.common.save")} /></>;
}
function AutonomyEditor({ settings }: { settings: ReturnType<typeof useBotSettingsEditorState> }) {
  const { t } = useI18n();
  if (settings.loading) return <LoadingLine />;
  return <><section style={{ ...areaPanelStyle, padding: "16px 0" }}><div style={{ margin: "0 18px 14px" }}><h2 style={sectionTitle}>{t("content.bot.common.workModeTitle")}</h2><p style={sectionHint}>{t("content.bot.common.workModeHint")}</p></div><div style={{ margin: "0 18px" }}><WorkModeControls settings={settings} /></div><div style={{ display: "grid", gap: 10, margin: "16px 18px 0" }}><Level n="1" title={t("content.bot.levels.manualDash")} active={settings.workMode === "MANUAL"} soon={false} /><Level n="2" title={t("content.bot.levels.smartDash")} active={settings.workMode !== "MANUAL"} soon={false} /><Level n="3" title={t("content.bot.levels.afterApproval")} active={false} soon /><Level n="4" title={t("content.bot.levels.alone")} active={false} soon /></div></section><GuardNote>{t("content.bot.hub.autonomy.guard")}</GuardNote><StickyActionBar onSave={() => void settings.handleSave()} saving={settings.saving} saved={settings.savedOk} error={settings.error} saveLabel={t("content.bot.common.save")} /></>;
}
function ForbiddenEditor({ settings }: { settings: ReturnType<typeof useBotSettingsEditorState> }) {
  const { t } = useI18n();
  if (settings.loading) return <LoadingLine />;
  function setForbid(key: keyof BotForbiddenPresets, checked: boolean) { settings.setForbidden((f) => ({ ...f, [key]: checked })); }
  return <><section style={areaPanelStyle}>{localizeKeyOptions(t, "forbidden", BOT_FORBIDDEN_OPTIONS).map((opt) => <ToggleRow key={opt.key} label={opt.label} hint={opt.hint} checked={settings.forbidden[opt.key] === true} onChange={(next) => setForbid(opt.key, next)} />)}</section><GuardNote>{t("content.bot.hub.forbidden.guard")}</GuardNote><StickyActionBar onSave={() => void settings.handleSave()} saving={settings.saving} saved={settings.savedOk} error={settings.error} saveLabel={t("content.bot.common.save")} /></>;
}
function HandoffEditor({ settings }: { settings: ReturnType<typeof useBotSettingsEditorState> }) {
  const { t } = useI18n();
  if (settings.loading) return <LoadingLine />;
  function setBoundary(key: keyof BotBoundaryPresets, checked: boolean) { settings.setBoundaries((b) => ({ ...b, [key]: checked })); }
  function setThreshold(value: number) { settings.setBoundaries((b) => ({ ...b, afterMessageCountThreshold: Math.min(30, Math.max(3, value)) })); }
  return <><section style={areaPanelStyle}>{localizeKeyOptions(t, "boundary", BOT_BOUNDARY_OPTIONS).map((opt) => { const checked = settings.boundaries[opt.key] === true; return <ToggleRow key={opt.key} label={opt.label} hint={opt.hint} checked={checked} onChange={(next) => setBoundary(opt.key, next)}>{opt.isThreshold && checked ? <Stepper value={settings.boundaries.afterMessageCountThreshold} min={3} max={30} label={t("content.bot.common.messagesFromCustomer")} onChange={setThreshold} /> : null}</ToggleRow>; })}</section><GuardNote>{t("content.bot.hub.handoff.guard")}</GuardNote><StickyActionBar onSave={() => void settings.handleSave()} saving={settings.saving} saved={settings.savedOk} error={settings.error} saveLabel={t("content.bot.common.save")} /></>;
}
function MemoryEditor({ memory }: { memory: ReturnType<typeof useMemoryPolicyState> }) {
  const { t } = useI18n();
  if (memory.loading) return <LoadingLine />;
  return <><SectionLabel>{t("content.bot.hub.memory.section")}</SectionLabel><section style={areaPanelStyle}>{localizeKeyOptions(t, "memory", MEMORY_TOGGLE_OPTIONS).map((opt) => <ToggleRow key={opt.key} label={opt.label} hint={opt.hint} checked={memory.policy[opt.key]} onChange={(next) => memory.toggle(opt.key, next)} />)}</section><GuardNote>{t("content.bot.hub.memory.guard")}</GuardNote><StickyActionBar onSave={() => void memory.save()} saving={memory.saving} saved={memory.savedOk} error={memory.error} saveLabel={t("content.bot.hub.memory.save")} /></>;
}
function LearningEditor({ learning }: { learning: ReturnType<typeof useLearningState> }) {
  const { t } = useI18n();
  if (learning.loading) return <LoadingLine />;
  return <>{learning.error ? <div role="alert" style={alertStyle}>{learning.error}</div> : null}{learning.items.length ? <section style={{ display: "grid", gap: 10, padding: "12px 18px 0" }}>{learning.items.map((s) => <div key={s.id} style={learnCardStyle}><div style={{ fontSize: TOKEN.font.caption, fontWeight: TOKEN.weight.bold, color: TOKEN.semantic.info.ink }}>{botOptionLabel(t, "learningType", s.type, LEARNING_TYPE_LABELS[s.type as LearningType] || t("content.bot.common.suggestion"))}</div><div style={{ marginTop: 5, fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>{s.title}</div>{s.description ? <div style={{ marginTop: 4, fontSize: TOKEN.font.meta, color: TOKEN.ink.secondary, lineHeight: 1.45 }}>{s.description}</div> : null}<div style={{ display: "flex", gap: 8, marginTop: 11 }}><button type="button" disabled={learning.busyId === s.id} onClick={() => void learning.act(s.id, "adopt")} style={primaryMiniButton}>{t("content.bot.hub.learning.adopt")}</button><button type="button" disabled={learning.busyId === s.id} onClick={() => void learning.act(s.id, "dismiss")} style={secondaryMiniButton}>{t("content.bot.hub.learning.dismiss")}</button></div></div>)}</section> : <div style={emptyStateStyle}><div style={{ fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.secondary }}>{t("content.bot.hub.learning.emptyTitle")}</div><p style={{ margin: "6px 0 0", fontSize: TOKEN.font.meta, lineHeight: 1.5 }}>{t("content.bot.hub.learning.emptyBody")}</p></div>}<GuardNote>{t("content.bot.hub.learning.guard")}</GuardNote><div style={{ height: 24 }} /></>;
}

function StepView({ index, text }: { index: number; text: string }) { const { t } = useI18n(); return <div style={{ position: "relative", margin: "0 18px", paddingInlineStart: 28 }}><span style={{ position: "absolute", insetInlineStart: 4, top: 15, width: 13, height: 13, borderRadius: TOKEN.radius.pill, background: TOKEN.surface.card, border: "3px solid " + TOKEN.brand.mid, boxSizing: "border-box" }} /><div style={{ border: "1px solid " + TOKEN.border.DEFAULT, borderRadius: TOKEN.radius.input, padding: 12, marginBottom: 9, display: "flex", alignItems: "center", gap: 10 }}><div style={{ flex: 1, fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold }}>{text}</div><span style={{ fontSize: TOKEN.font.caption, fontWeight: TOKEN.weight.bold, padding: "3px 8px", borderRadius: TOKEN.radius.pill, background: TOKEN.semantic.info.bgSoft, color: TOKEN.semantic.info.ink }}>{t("content.bot.hub.conversation.stepN", { n: index })}</span></div></div>; }
function FaqEditor({ item, index, onChange, onRemove }: { item: FaqItem; index: number; onChange: (patch: Partial<FaqItem>) => void; onRemove: () => void }) { const { t } = useI18n(); return <div style={faqBoxStyle}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}><span style={{ fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.muted }}>{t("content.bot.common.questionN", { n: index + 1 })}</span><button type="button" onClick={onRemove} aria-label={t("content.bot.common.removeQuestion")} style={iconTextButton}>×</button></div><input value={item.question} onChange={(e) => onChange({ question: e.target.value })} placeholder={t("content.bot.common.faqQuestion")} style={inputStyle} /><textarea value={item.answer} onChange={(e) => onChange({ answer: e.target.value })} placeholder={t("content.bot.common.faqAnswer")} rows={2} style={{ ...inputStyle, resize: "vertical", minHeight: 56 }} /></div>; }
function ChipMulti<T extends string>({ options, selected, onToggle }: { options: ReadonlyArray<{ value: T; label: string }>; selected: T[]; onToggle: (value: T) => void }) { return <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "0 18px" }}>{options.map((opt) => { const on = selected.includes(opt.value); return <button key={opt.value} type="button" aria-pressed={on} onClick={() => onToggle(opt.value)} style={{ display: "inline-flex", alignItems: "center", height: 38, padding: "0 14px", borderRadius: TOKEN.radius.pill, border: "1px solid " + (on ? TOKEN.brand.mid : TOKEN.border.DEFAULT), background: on ? TOKEN.action.primary.background : TOKEN.surface.inset, color: on ? TOKEN.ink.inverse : TOKEN.ink.primary, fontFamily: "inherit", fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.body, cursor: "pointer" }}>{opt.label}</button>; })}</div>; }
function ScaleSingle<T extends string>({ options, selected, onSelect }: { options: ReadonlyArray<{ value: T; label: string; hint?: string }>; selected: T | null; onSelect: (value: T) => void }) { return <div style={{ margin: "0 18px", display: "grid", gap: 9 }}>{options.map((opt) => { const on = selected === opt.value; return <button key={opt.value} type="button" aria-pressed={on} onClick={() => onSelect(opt.value)} style={{ display: "flex", alignItems: "center", gap: 13, padding: 14, borderRadius: TOKEN.radius.card, border: "1px solid " + (on ? TOKEN.brand.mid : TOKEN.border.DEFAULT), background: on ? TOKEN.brand.soft : TOKEN.surface.card, cursor: "pointer", textAlign: "start", fontFamily: "inherit", width: "100%" }}><span aria-hidden style={{ width: 20, height: 20, borderRadius: TOKEN.radius.pill, border: (on ? 6 : 2) + "px solid " + (on ? TOKEN.brand.mid : TOKEN.border.hover), flexShrink: 0, boxSizing: "border-box" }} /><span style={{ flex: 1, minWidth: 0 }}><span style={{ display: "block", fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>{opt.label}</span>{opt.hint ? <span style={{ display: "block", marginTop: 2, fontSize: TOKEN.font.meta, color: TOKEN.ink.muted }}>{opt.hint}</span> : null}</span></button>; })}</div>; }
function toggleIn<T>(list: T[], value: T): T[] { return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]; }

type BotApiResponse = { identity?: { displayName: string | null; avatar: string | null }; profile?: { voice?: BotVoiceConfig; personality?: BotPersonalityConfig; approach?: BotApproachConfig } };
function useBotProfileState() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null), [savedOk, setSavedOk] = useState(false);
  const [displayName, setDisplayName] = useState(""), [tone, setTone] = useState<BotTone | null>(null), [languages, setLanguages] = useState<BotLanguage[]>([]), [audienceTags, setAudienceTags] = useState<BotAudienceTag[]>([]), [traits, setTraits] = useState<BotTrait[]>([]), [verbosity, setVerbosity] = useState<BotVerbosity | null>(null), [saleStyle, setSaleStyle] = useState<BotSaleStyle | null>(null), [initiativeLevel, setInitiativeLevel] = useState<BotInitiativeLevel | null>(null), [priorities, setPriorities] = useState<BotPriority[]>([]);
  const load = useCallback(async () => { setLoading(true); setError(null); try { const res = await fetch("/api/business/bot", { headers: { Authorization: "Bearer " + getAuthToken() }, cache: "no-store" }); if (!res.ok) throw new Error(); const data = await res.json() as BotApiResponse; setDisplayName(data.identity?.displayName || ""); setTone(data.profile?.voice?.tone || null); setLanguages(data.profile?.voice?.languages || []); setAudienceTags(data.profile?.voice?.audienceTags || []); setTraits(data.profile?.personality?.traits || []); setVerbosity(data.profile?.personality?.verbosity || null); setSaleStyle(data.profile?.approach?.saleStyle || null); setInitiativeLevel(data.profile?.approach?.initiativeLevel || null); setPriorities(data.profile?.approach?.priorities || []); } catch { setError(t("content.bot.common.errors.loadProfile")); } finally { setLoading(false); } }, [t]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (!cancelled) void load(); }); return () => { cancelled = true; }; }, [load]);
  const voiceBlock = useMemo<BotVoiceConfig>(() => { const b: BotVoiceConfig = {}; if (tone) b.tone = tone; if (languages.length) b.languages = languages; if (audienceTags.length) b.audienceTags = audienceTags; return b; }, [tone, languages, audienceTags]);
  const personalityBlock = useMemo<BotPersonalityConfig>(() => { const b: BotPersonalityConfig = {}; if (traits.length) b.traits = traits; if (verbosity) b.verbosity = verbosity; return b; }, [traits, verbosity]);
  const approachBlock = useMemo<BotApproachConfig>(() => { const b: BotApproachConfig = {}; if (saleStyle) b.saleStyle = saleStyle; if (initiativeLevel) b.initiativeLevel = initiativeLevel; if (priorities.length) b.priorities = priorities; return b; }, [saleStyle, initiativeLevel, priorities]);
  const patch = useCallback(async (body: Record<string, unknown>) => { setSaving(true); setError(null); try { const res = await fetch("/api/business/bot", { method: "PATCH", headers: { Authorization: "Bearer " + getAuthToken(), "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!res.ok) throw new Error(); setSavedOk(true); window.setTimeout(() => setSavedOk(false), 2500); await load(); return true; } catch { setError(t("content.bot.common.saveFailed")); return false; } finally { setSaving(false); } }, [load, t]);
  return { loading, saving, error, savedOk, displayName, setDisplayName, tone, setTone, languages, setLanguages, audienceTags, setAudienceTags, traits, setTraits, verbosity, setVerbosity, saleStyle, setSaleStyle, initiativeLevel, setInitiativeLevel, priorities, setPriorities, saveIdentityAndVoice: () => patch({ displayName: displayName.trim() || null, profile: { voice: voiceBlock } }), savePersonality: () => patch({ profile: { personality: personalityBlock } }), saveApproach: () => patch({ profile: { approach: approachBlock } }) };
}
function useKnowledgeState() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [savedOk, setSavedOk] = useState(false), [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(""), [address, setAddress] = useState(""), [notes, setNotes] = useState(""), [faq, setFaq] = useState<FaqItem[]>([]);
  const load = useCallback(async () => { setLoading(true); setError(null); try { const res = await fetch("/api/business/bot/knowledge", { headers: { Authorization: "Bearer " + getAuthToken() }, cache: "no-store" }); if (!res.ok) throw new Error(); const data = await res.json(); setHours(data.knowledge?.hours || ""); setAddress(data.knowledge?.address || ""); setNotes(data.knowledge?.notes || ""); setFaq(data.knowledge?.faq || []); } catch { setError(t("content.bot.common.errors.loadKnowledge")); } finally { setLoading(false); } }, [t]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (!cancelled) void load(); }); return () => { cancelled = true; }; }, [load]);
  function updateFaq(i: number, patch: Partial<FaqItem>) { setFaq((cur) => cur.map((f, idx) => idx === i ? { ...f, ...patch } : f)); }
  function addFaq() { setFaq((cur) => cur.length >= MAX_FAQ_ITEMS ? cur : [...cur, { question: "", answer: "" }]); }
  function removeFaq(i: number) { setFaq((cur) => cur.filter((_, idx) => idx !== i)); }
  async function save(saveSettings: () => Promise<void> | void) { setSaving(true); setError(null); try { const cleanFaq = faq.map((f) => ({ question: f.question.trim(), answer: f.answer.trim() })).filter((f) => f.question.length > 0); const res = await fetch("/api/business/bot/knowledge", { method: "PUT", headers: { Authorization: "Bearer " + getAuthToken(), "Content-Type": "application/json" }, body: JSON.stringify({ hours: hours.trim() || null, address: address.trim() || null, notes: notes.trim() || null, faq: cleanFaq }) }); if (!res.ok) throw new Error(); await saveSettings(); setSavedOk(true); window.setTimeout(() => setSavedOk(false), 2500); await load(); } catch { setError(t("content.bot.common.errors.knowledgeSaveFailed")); } finally { setSaving(false); } }
  return { loading, saving, savedOk, error, hours, setHours, address, setAddress, notes, setNotes, faq, updateFaq, addFaq, removeFaq, save };
}
type LearningSuggestion = { id: number; type: string; title: string; description: string | null };
function useLearningState() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [busyId, setBusyId] = useState<number | null>(null), [items, setItems] = useState<LearningSuggestion[]>([]);
  const load = useCallback(async () => { setLoading(true); setError(null); try { const res = await fetch("/api/business/bot/learning-suggestions", { headers: { Authorization: "Bearer " + getAuthToken() }, cache: "no-store" }); if (!res.ok) throw new Error(); const data = await res.json(); setItems(data.suggestions || []); } catch { setError(t("content.bot.common.errors.loadSuggestions")); } finally { setLoading(false); } }, [t]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (!cancelled) void load(); }); return () => { cancelled = true; }; }, [load]);
  async function act(id: number, action: "adopt" | "dismiss") { setBusyId(id); setError(null); try { const res = await fetch(`/api/business/bot/learning-suggestions/${id}/${action}`, { method: "POST", headers: { Authorization: "Bearer " + getAuthToken() } }); if (!res.ok) throw new Error(); setItems((cur) => cur.filter((s) => s.id !== id)); } catch { setError(t("content.bot.common.errors.actionFailed")); } finally { setBusyId(null); } }
  return { loading, error, busyId, items, act };
}

const inputStyle: CSSProperties = { width: "100%", border: "1px solid " + TOKEN.border.DEFAULT, borderRadius: TOKEN.radius.input, background: TOKEN.surface.inset, padding: "11px 13px", color: TOKEN.ink.primary, fontFamily: "inherit", fontSize: TOKEN.font.body, lineHeight: 1.5, outline: "none", boxSizing: "border-box" };
const addButtonStyle: CSSProperties = { margin: "2px 18px 0", width: "calc(100% - 36px)", border: "1.5px dashed " + TOKEN.border.hover, borderRadius: TOKEN.radius.input, padding: 13, background: "transparent", color: TOKEN.brand.mid, fontFamily: "inherit", fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.body, cursor: "pointer" };
const faqBoxStyle: CSSProperties = { margin: "0 18px 10px", border: "1px solid " + TOKEN.border.DEFAULT, borderRadius: TOKEN.radius.card, padding: 12, display: "grid", gap: 8 };
const iconTextButton: CSSProperties = { border: 0, background: "transparent", color: TOKEN.ink.meta, cursor: "pointer", fontSize: TOKEN.font.display, lineHeight: 1 };
const alertStyle: CSSProperties = { margin: "12px 18px 0", background: TOKEN.semantic.urgent.bgSoft, color: TOKEN.semantic.urgent.ink, padding: "10px 12px", borderRadius: TOKEN.radius.input, fontSize: TOKEN.font.meta };
const learnCardStyle: CSSProperties = { border: "1px solid " + TOKEN.semantic.info.border, background: TOKEN.semantic.info.bgSoft, borderRadius: TOKEN.radius.card, padding: 14 };
const primaryMiniButton: CSSProperties = { flex: 1, height: 38, borderRadius: TOKEN.radius.input, border: 0, background: TOKEN.action.primary.background, color: TOKEN.ink.inverse, fontFamily: "inherit", fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.meta, cursor: "pointer" };
const secondaryMiniButton: CSSProperties = { flex: 1, height: 38, borderRadius: TOKEN.radius.input, border: "1px solid " + TOKEN.border.hover, background: TOKEN.surface.card, color: TOKEN.ink.muted, fontFamily: "inherit", fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.meta, cursor: "pointer" };
const emptyStateStyle: CSSProperties = { margin: "24px 18px", textAlign: "center", color: TOKEN.ink.muted };
function WorkModeControls({ settings }: { settings: ReturnType<typeof useBotSettingsEditorState> }) { const { t } = useI18n(); return <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{localizeWorkModes(t, BOT_WORK_MODE_OPTIONS_ACTIVE).map((opt) => { const selected = settings.workMode === opt.id; return <button key={opt.id} type="button" onClick={() => { settings.setWorkMode(opt.id); const patch = settingsPatchForWorkMode(opt.id, { version: 1, workMode: opt.id, boundaries: settings.boundaries }); settings.setEnabled(patch.enabled); settings.setShowDraftSuggestionsInInbox(patch.showDraftSuggestionsInInbox); }} style={{ textAlign: "start", width: "100%", border: (selected ? "2px solid " : "1px solid ") + (selected ? TOKEN.brand.mid : TOKEN.border.DEFAULT), borderRadius: TOKEN.radius.card, padding: "14px 16px", background: selected ? TOKEN.brand.soft : TOKEN.surface.card, cursor: "pointer", fontFamily: "inherit" }}><div style={{ fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.body }}>{opt.title}</div><div style={{ fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, marginTop: 4, lineHeight: 1.45 }}>{opt.description}</div><div style={{ fontSize: TOKEN.font.meta, color: selected ? TOKEN.brand.mid : TOKEN.ink.meta, marginTop: 6, fontWeight: TOKEN.weight.semibold }}>{opt.trustLine}</div></button>; })}</div>; }
function Level({ n, title, active, soon }: { n: string; title: string; active: boolean; soon: boolean }) { const { t } = useI18n(); return <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: TOKEN.radius.input, border: "1px solid " + (active ? TOKEN.brand.softBorder : TOKEN.border.DEFAULT), background: active ? TOKEN.brand.soft : TOKEN.surface.card, opacity: soon ? 0.62 : 1 }}><span style={{ width: 28, height: 28, borderRadius: TOKEN.radius.pill, display: "grid", placeItems: "center", background: active ? TOKEN.brand.mid : TOKEN.surface.inset, color: active ? TOKEN.ink.inverse : TOKEN.ink.muted, fontWeight: TOKEN.weight.bold }}>{n}</span><span style={{ flex: 1, fontSize: TOKEN.font.body, color: TOKEN.ink.secondary }}>{title}</span><Pill status={soon ? "soon" : active ? "live" : "saved"} label={soon ? t("content.bot.common.soon") : active ? t("content.bot.common.now") : t("content.bot.common.available")} /></div>; }
function Pill({ status, label }: { status: Status; label?: string }) { const { t } = useI18n(); const color = status === "live" ? TOKEN.semantic.success.ink : status === "saved" ? TOKEN.semantic.info.ink : TOKEN.ink.muted; const bg = status === "live" ? TOKEN.semantic.success.bgSoft : status === "saved" ? TOKEN.semantic.info.bgSoft : TOKEN.surface.inset; const border = status === "live" ? TOKEN.semantic.success.border : status === "saved" ? TOKEN.semantic.info.border : TOKEN.border.DEFAULT; return <span style={{ display: "inline-flex", alignItems: "center", fontSize: TOKEN.font.caption, fontWeight: TOKEN.weight.bold, padding: "3px 8px", borderRadius: TOKEN.radius.pill, color, background: bg, border: "1px solid " + border }}>{label || statusText(status, t)}</span>; }
function SectionLabel({ children }: { children: ReactNode }) { return <div style={{ padding: "18px 18px 8px", fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.muted }}>{children}</div>; }
function LoadingLine() { const { t } = useI18n(); return <p style={{ margin: 18, color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>{t("content.bot.common.loading")}</p>; }
function finalActionHint(action: FinalAction, t: Translator): string { if (action === "LEAVE_MESSAGE") return t("content.bot.hub.allowed.hints.LEAVE_MESSAGE"); if (action === "COLLECT_DETAILS") return t("content.bot.hub.allowed.hints.COLLECT_DETAILS"); if (action === "SEND_LINK") return t("content.bot.hub.allowed.hints.SEND_LINK"); return t("content.bot.hub.allowed.hints.ESCALATE"); }

function useGoalsState() { const { t } = useI18n(); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [savedOk, setSavedOk] = useState(false); const [error, setError] = useState<string | null>(null); const [selected, setSelected] = useState<string[]>([]); const load = useCallback(async () => { setLoading(true); setError(null); try { const res = await fetch("/api/business/bot/goals", { headers: { Authorization: "Bearer " + getAuthToken() }, cache: "no-store" }); if (!res.ok) throw new Error(); const data = await res.json(); setSelected((data.selected || []).map((g: { goalKey: string }) => g.goalKey)); } catch { setError(t("content.bot.hub.goal.loadError")); } finally { setLoading(false); } }, [t]); useEffect(() => { let cancelled = false; queueMicrotask(() => { if (!cancelled) void load(); }); return () => { cancelled = true; }; }, [load]); function toggle(key: string) { setSelected((cur) => cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]); } async function save() { setSaving(true); setError(null); try { const res = await fetch("/api/business/bot/goals", { method: "PUT", headers: { Authorization: "Bearer " + getAuthToken(), "Content-Type": "application/json" }, body: JSON.stringify({ goals: selected }) }); if (!res.ok) throw new Error(); setSavedOk(true); window.setTimeout(() => setSavedOk(false), 2500); await load(); } catch { setError(t("content.bot.hub.goal.saveError")); } finally { setSaving(false); } } return { loading, saving, savedOk, error, selected, toggle, save }; }
function useMemoryPolicyState() { const { t } = useI18n(); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [savedOk, setSavedOk] = useState(false); const [error, setError] = useState<string | null>(null); const [policy, setPolicy] = useState<BotMemoryPolicy>(emptyMemoryPolicy()); const load = useCallback(async () => { setLoading(true); setError(null); try { const res = await fetch("/api/business/bot/memory-policy", { headers: { Authorization: "Bearer " + getAuthToken() }, cache: "no-store" }); if (!res.ok) throw new Error(); const data = await res.json(); setPolicy({ ...emptyMemoryPolicy(), ...(data.policy || {}) }); } catch { setError(t("content.bot.hub.memory.loadError")); } finally { setLoading(false); } }, [t]); useEffect(() => { let cancelled = false; queueMicrotask(() => { if (!cancelled) void load(); }); return () => { cancelled = true; }; }, [load]); function toggle(key: MemoryToggleKey, value: boolean) { setPolicy((p) => ({ ...p, [key]: value })); } async function save() { setSaving(true); setError(null); try { const res = await fetch("/api/business/bot/memory-policy", { method: "PUT", headers: { Authorization: "Bearer " + getAuthToken(), "Content-Type": "application/json" }, body: JSON.stringify(policy) }); if (!res.ok) throw new Error(); setSavedOk(true); window.setTimeout(() => setSavedOk(false), 2500); await load(); } catch { setError(t("content.bot.hub.memory.saveError")); } finally { setSaving(false); } } return { loading, saving, savedOk, error, policy, toggle, save }; }

function categoryIconTone(id: CategoryId): CSSProperties {
  if (id === "identity") return { background: TOKEN.semantic.info.bgSoft, color: TOKEN.semantic.info.ink };
  if (id === "conversation") return { background: TOKEN.brand.soft, color: TOKEN.brand.mid };
  if (id === "limits") return { background: TOKEN.semantic.attention.bgSoft, color: TOKEN.semantic.attention.ink };
  return { background: TOKEN.surface.inset, color: TOKEN.ink.muted };
}
function areaIconTone(id: AreaId): CSSProperties {
  if (["goal", "voice", "knowledge"].includes(id)) return { background: TOKEN.semantic.info.bgSoft, color: TOKEN.semantic.info.ink };
  if (["personality", "conversation", "approach"].includes(id)) return { background: TOKEN.brand.soft, color: TOKEN.brand.mid };
  if (["allowed", "autonomy", "handoff"].includes(id)) return { background: TOKEN.semantic.attention.bgSoft, color: TOKEN.semantic.attention.ink };
  if (id === "forbidden") return { background: TOKEN.semantic.urgent.bgSoft, color: TOKEN.semantic.urgent.ink };
  if (id === "learning") return { background: TOKEN.semantic.success.bgSoft, color: TOKEN.semantic.success.ink };
  return { background: TOKEN.surface.inset, color: TOKEN.ink.muted };
}
function BotIcon() { return <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden><path d="M4 5h16v11H9l-5 4V5z" stroke="currentColor" strokeWidth="1.9" fill="none" strokeLinejoin="round"/><path d="M8 10h8M8 13h5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"/></svg>; }
function Chevron() { return <svg className={hub.chevron} width="20" height="20" viewBox="0 0 24 24" aria-hidden><path d="m15 6-6 6 6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" /></svg>; }
function CategoryIcon({ id }: { id: CategoryId }) { if (id === "identity") return <svg width="23" height="23" viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.9" fill="none"/><path d="M5 20c0-3.3 3-6 7-6s7 2.7 7 6" stroke="currentColor" strokeWidth="1.9" fill="none" strokeLinecap="round"/></svg>; if (id === "conversation") return <BotIcon />; if (id === "limits") return <svg width="23" height="23" viewBox="0 0 24 24" aria-hidden><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" stroke="currentColor" strokeWidth="1.9" fill="none" strokeLinejoin="round"/></svg>; return <svg width="23" height="23" viewBox="0 0 24 24" aria-hidden><path d="M12 3a6 6 0 0 1 6 6c0 2-1 3-2 4s-1 2-1 3H9c0-1 0-2-1-3s-2-2-2-4a6 6 0 0 1 6-6zM9 21h6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function SettingIcon({ id }: { id: AreaId }) { return <span aria-hidden style={{ fontSize: TOKEN.font.display, lineHeight: 1 }}>{settingIcon(id)}</span>; }
function settingIcon(id: AreaId): string {
  if (id === "goal") return "🎯";
  if (id === "personality") return "🎭";
  if (id === "voice") return "🗣️";
  if (id === "conversation") return "💬";
  if (id === "approach") return "🤝";
  if (id === "knowledge") return "📚";
  if (id === "allowed") return "⚡";
  if (id === "autonomy") return "🎚️";
  if (id === "forbidden") return "🚫";
  if (id === "handoff") return "🙋";
  if (id === "memory") return "🧠";
  return "📈";
}

const shellStyle: CSSProperties = { position: "relative", maxWidth: BUILDER_SHELL_MAX_WIDTH, minHeight: "100dvh", margin: "0 auto", background: TOKEN.surface.card, overflowX: "hidden", boxSizing: "border-box" };
const heroStyle: CSSProperties = { margin: "14px 18px 0", borderRadius: TOKEN.radius.modal, padding: 18, background: TOKEN.brand.gradient, color: TOKEN.ink.inverse, boxShadow: TOKEN.action.primary.shadow, display: "flex", alignItems: "center", gap: 14 };
const heroIconStyle: CSSProperties = { width: 54, height: 54, borderRadius: TOKEN.radius.card, background: TOKEN.action.glass.background, border: TOKEN.action.glass.border, display: "grid", placeItems: "center", flexShrink: 0, color: TOKEN.brand.mid };
const catCardStyle: CSSProperties = { display: "block", width: "calc(100% - 36px)", margin: "0 18px 13px", border: "1px solid " + TOKEN.border.DEFAULT, borderRadius: TOKEN.radius.modal, padding: 17, background: TOKEN.surface.card, textAlign: "start", fontFamily: "inherit", cursor: "pointer", boxSizing: "border-box" };
const catIconStyle: CSSProperties = { width: 46, height: 46, borderRadius: TOKEN.radius.card, display: "grid", placeItems: "center", flexShrink: 0, background: TOKEN.brand.soft, color: TOKEN.brand.mid };
const previewChipStyle: CSSProperties = { fontSize: TOKEN.font.caption, fontWeight: TOKEN.weight.bold, padding: "4px 10px", borderRadius: TOKEN.radius.pill, background: TOKEN.surface.inset, color: TOKEN.ink.secondary };
const overlayStyle: CSSProperties = { position: "fixed", inset: 0, border: 0, padding: 0, background: TOKEN.surface.appChrome, opacity: 0.5, zIndex: 20, cursor: "pointer" };
const sheetStyle: CSSProperties = { position: "fixed", left: "50%", bottom: 0, width: "min(100vw, 560px)", transform: "translateX(-50%)", background: TOKEN.surface.overlay, borderRadius: String(TOKEN.radius.modal + 10) + "px " + String(TOKEN.radius.modal + 10) + "px 0 0", zIndex: 21, display: "flex", flexDirection: "column", boxShadow: TOKEN.shadow.floating, overflow: "hidden" };
const gripStyle: CSSProperties = { width: 38, height: 5, borderRadius: TOKEN.radius.pill, background: TOKEN.border.hover, margin: "10px auto 0", flexShrink: 0 };
const sheetHeadStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "12px 18px 8px", flexShrink: 0 };
const backButtonStyle: CSSProperties = { width: 38, height: 38, borderRadius: TOKEN.radius.input, border: 0, background: TOKEN.surface.inset, color: TOKEN.brand.mid, display: "grid", placeItems: "center", cursor: "pointer", flexShrink: 0 };
const xButtonStyle: CSSProperties = { width: 38, height: 38, borderRadius: TOKEN.radius.pill, border: 0, background: TOKEN.surface.inset, color: TOKEN.ink.primary, display: "grid", placeItems: "center", cursor: "pointer", flexShrink: 0, fontSize: TOKEN.font.display };
const sheetDescStyle: CSSProperties = { margin: 0, padding: "0 18px 4px", color: TOKEN.ink.muted, fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.medium, lineHeight: 1.5, flexShrink: 0 };
const sheetBodyStyle: CSSProperties = { overflowY: "auto", padding: "10px 0 0", minHeight: 0 };
const rowStyle: CSSProperties = { width: "100%", display: "flex", alignItems: "center", gap: 13, padding: "15px 18px", border: 0, borderTop: "1px solid " + TOKEN.border.DEFAULT, background: TOKEN.surface.card, cursor: "pointer", textAlign: "start", fontFamily: "inherit" };
const rowIconStyle: CSSProperties = { width: 40, height: 40, borderRadius: TOKEN.radius.input, background: TOKEN.surface.inset, display: "grid", placeItems: "center", flexShrink: 0, color: TOKEN.brand.mid };
const countPillStyle: CSSProperties = { display: "inline-flex", alignItems: "center", fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, color: TOKEN.brand.mid, background: TOKEN.brand.soft, padding: "6px 13px", borderRadius: TOKEN.radius.pill };
const sectionTitle: CSSProperties = { margin: "0 0 6px", fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary, lineHeight: 1.3 };
const sectionHint: CSSProperties = { margin: 0, fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, lineHeight: 1.55 };
