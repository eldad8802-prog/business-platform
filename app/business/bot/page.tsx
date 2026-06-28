"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { BOT_BOUNDARY_OPTIONS, BOT_WORK_MODE_OPTIONS_ACTIVE, settingsPatchForWorkMode, type BotBoundaryPresets } from "@/lib/features/conversation/bot-control";
import { FINAL_ACTION_OPTIONS as FINAL_ACTIONS, type FinalAction } from "@/lib/features/conversation/final-action";
import { BOT_AUDIENCE_OPTIONS, BOT_INITIATIVE_OPTIONS, BOT_LANGUAGE_OPTIONS, BOT_PRIORITY_OPTIONS, BOT_SALE_STYLE_OPTIONS, BOT_TONE_OPTIONS, BOT_TRAIT_OPTIONS, BOT_VERBOSITY_OPTIONS, LEARNING_TYPE_LABELS, MAX_FAQ_ITEMS, MEMORY_TOGGLE_OPTIONS, emptyMemoryPolicy, type BotApproachConfig, type BotAudienceTag, type BotInitiativeLevel, type BotLanguage, type BotMemoryPolicy, type BotPersonalityConfig, type BotPriority, type BotSaleStyle, type BotTone, type BotTrait, type BotVerbosity, type BotVoiceConfig, type FaqItem, type LearningType, type MemoryToggleKey } from "@/lib/features/bot";
import { BUILDER_SHELL_MAX_WIDTH, BuilderTextAreaField, BuilderTextField, ChoiceRow, GuardNote, Stepper, StickyActionBar, ToggleRow, areaPanelStyle } from "../bot-settings/_components/bot-builder-area-ui";
import { GoalLibrary } from "../bot-settings/_components/bot-goals-screen";
import { useBotSettingsEditorState } from "../bot-settings/_components/bot-settings-editor";

type Status = "live" | "saved" | "soon";
type CategoryId = "identity" | "conversation" | "limits" | "future";
type AreaId = "goal" | "personality" | "voice" | "conversation" | "approach" | "knowledge" | "allowed" | "autonomy" | "forbidden" | "handoff" | "memory" | "learning";
type HubPayload = { identity: { displayName: string | null; avatar: string | null }; runtime: { workMode: string }; signals: { welcomeOk: boolean; questionsCount: number; finishOk: boolean; productLinkOk: boolean; workModeManual: boolean; goalsCount: number; learningCount: number; personalityOk: boolean; approachOk: boolean; knowledgeOk: boolean } };

type AreaMeta = { id: AreaId; title: string; sub: string; desc: string; status: Status };
type CategoryMeta = { id: CategoryId; title: string; sub: string; areas: AreaId[] };

const CATEGORIES: CategoryMeta[] = [
  { id: "identity", title: "מי הבוט", sub: "הזהות, האופי והקול שלו", areas: ["goal", "personality", "voice"] },
  { id: "conversation", title: "איך הוא עובד", sub: "השיחה, הגישה והידע שלו", areas: ["conversation", "approach", "knowledge"] },
  { id: "limits", title: "מה מותר ומתי לעצור", sub: "הפעולות, הגבולות והעצמאות", areas: ["allowed", "autonomy", "forbidden", "handoff"] },
  { id: "future", title: "העדפות לעתיד", sub: "זיכרון והצעות לשיפור", areas: ["memory", "learning"] },
];
const AREAS: Record<AreaId, AreaMeta> = {
  goal: { id: "goal", title: "המטרה שלו", sub: "מטרה", desc: "בחר את הדברים שהבוט אמור לעזור בהם. נשמר כשכבת תכנון ואינו משנה את השיחה החיה כרגע.", status: "saved" },
  personality: { id: "personality", title: "האופי שלו", sub: "אופי", desc: "נשמר בפרופיל הבוט. לא משפיע על הבוט החי בשלב הזה.", status: "saved" },
  voice: { id: "voice", title: "איך הוא מדבר", sub: "קול", desc: "הודעת הפתיחה חיה. שאר הקול נשמר כשכבת פרופיל.", status: "saved" },
  conversation: { id: "conversation", title: "איך השיחה עובדת", sub: "שיחה", desc: "השאלות שהבוט שואל לפי הסדר. זה המקור החי של שאלות legacy.", status: "live" },
  approach: { id: "approach", title: "הגישה שלו", sub: "גישה", desc: "נשמר כהעדפה תיאורית ולא משפיע על ה-runtime כרגע.", status: "saved" },
  knowledge: { id: "knowledge", title: "מה הוא יודע", sub: "ידע", desc: "קישור הקטלוג נשמר דרך הגדרות הבוט הקיימות. ידע נוסף נשמר בשכבת ידע.", status: "saved" },
  allowed: { id: "allowed", title: "פעולת סיום", sub: "סיום", desc: "מה הבוט מכין בסיום איסוף הפרטים. הערך נשאר אותו enum קיים.", status: "live" },
  autonomy: { id: "autonomy", title: "עצמאות", sub: "draft-only", desc: "המצב האמיתי בקוד הוא ידני או טיוטות חכמות. רמות ביצוע מסומנות עתידיות.", status: "live" },
  forbidden: { id: "forbidden", title: "מה אסור", sub: "אסור", desc: "אין backend נפרד לאיסורים. כרגע ההגנה מגיעה מ-draft-only ומגבולות העברה.", status: "soon" },
  handoff: { id: "handoff", title: "מתי מעביר אליי", sub: "העברה", desc: "באילו מצבים הבוט מפסיק להכין טיוטות ומעביר את השיחה אליך.", status: "live" },
  memory: { id: "memory", title: "זיכרון לקוח", sub: "זיכרון", desc: "מדיניות עתידית בלבד. כרגע הבוט לא שומר מידע על לקוחות בפועל.", status: "soon" },
  learning: { id: "learning", title: "למידה", sub: "למידה", desc: "הצעות לשיפור לא משנות את הבוט אוטומטית.", status: "soon" },
};

function getAuthToken(): string { if (typeof window === "undefined") return "1"; return localStorage.getItem("token") || "1"; }
function statusText(s: Status) { return s === "live" ? "חי" : s === "saved" ? "נשמר" : "בקרוב"; }
function areaSummary(id: AreaId, p: HubPayload | null) { const s = p?.signals; if (id === "goal") return s?.goalsCount ? String(s.goalsCount) + " מטרות" : "טרם נבחרו מטרות"; if (id === "conversation") return s?.questionsCount ? String(s.questionsCount) + " שאלות" : "אין שאלות עדיין"; if (id === "voice") return s?.welcomeOk ? "הודעת פתיחה קיימת" : "חסרה הודעת פתיחה"; if (id === "allowed") return s?.finishOk ? "פעולת סיום מוגדרת" : "בחר פעולת סיום"; if (id === "autonomy") return s?.workModeManual ? "רמה 1 · ידני" : "רמה 2 · טיוטות חכמות"; if (id === "learning") return s?.learningCount ? String(s.learningCount) + " הצעות" : "אין הצעות כרגע"; if (id === "knowledge") return s?.productLinkOk || s?.knowledgeOk ? "ידע נשמר" : "אפשר להוסיף ידע"; if (id === "personality") return s?.personalityOk ? "אופי נשמר" : "אפשר לבחור אופי"; if (id === "approach") return s?.approachOk ? "גישה נשמרה" : "אפשר להגדיר גישה"; return AREAS[id].desc; }

export default function BusinessBotHubPage() {
  const settings = useBotSettingsEditorState();
  const goals = useGoalsState();
  const memory = useMemoryPolicyState();
  const profile = useBotProfileState();
  const knowledge = useKnowledgeState();
  const learning = useLearningState();
  const [payload, setPayload] = useState<HubPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState<CategoryId | null>(null);
  const [area, setArea] = useState<AreaId | null>(null);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  const load = useCallback(async () => { setLoading(true); setError(null); try { const res = await fetch("/api/business/bot-hub", { headers: { Authorization: "Bearer " + getAuthToken() }, cache: "no-store" }); if (!res.ok) throw new Error(); setPayload(await res.json() as HubPayload); } catch { setError("לא ניתן לטעון את נתוני הבוט"); } finally { setLoading(false); } }, []);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (!cancelled) void load(); }); return () => { cancelled = true; }; }, [load]);

  const currentCat = cat ? CATEGORIES.find((c) => c.id === cat) || null : null;
  const currentArea = area ? AREAS[area] : null;
  const botName = payload?.identity.displayName || "הבוט של העסק";
  const botStatus = payload?.runtime.workMode === "MANUAL" ? "ידני · draft-only" : "פעיל · מכין טיוטות";
  function closeOne() { if (area) setArea(null); else setCat(null); }
  function closeAll() { setArea(null); setCat(null); }

  // Fix-2: connect the EXISTING path SetupDraft -> Assemble -> Activate. Assembles
  // a base from the selected goals, then activates (server-side materialization
  // of welcome/questions/finalAction only). Never writes BusinessBotSettings from
  // here, never touches workMode/enabled. The result is stashed for the success
  // page BEFORE redirect, so it no longer relies on an unwritten key.
  async function handleActivate() {
    if (goals.selected.length === 0) {
      setActivateError("בחר מטרות תחילה - הבוט צריך בסיס לפני הפעלה.");
      return;
    }
    setActivating(true);
    setActivateError(null);
    try {
      const headers = { Authorization: "Bearer " + getAuthToken(), "Content-Type": "application/json" };
      const asm = await fetch("/api/business/bot/setup/assemble", { method: "POST", headers, body: JSON.stringify({ goals: goals.selected }) });
      if (!asm.ok) { setActivateError("הרכבת הבסיס נכשלה. נסה שוב."); return; }
      const act = await fetch("/api/business/bot/setup/activate", { method: "POST", headers });
      const result = await act.json().catch(() => null);
      if (!act.ok) { setActivateError((result && result.error) || "ההפעלה נכשלה."); return; }
      try { window.sessionStorage.setItem("botSetupActivationResult", JSON.stringify(result)); } catch { /* ignore */ }
      window.location.href = "/business/bot/setup/success";
    } catch {
      setActivateError("שגיאת רשת. נסה שוב.");
    } finally {
      setActivating(false);
    }
  }

  return <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.page }}><main style={shellStyle}>
    <div style={{ paddingBottom: 44 }}>
      <header style={{ padding: "18px 18px 4px" }}><h1 style={{ margin: 0, color: TOKEN.ink.primary, fontSize: TOKEN.font.hero, fontWeight: TOKEN.weight.bold }}>הבוט שלי</h1></header>
      <p style={{ margin: 0, padding: "0 18px", color: TOKEN.ink.muted, fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.semibold, lineHeight: 1.55 }}>בנוי בדיוק לעסק שלך. אפשר לשנות כל דבר, מתי שתרצה.</p>
      {loading ? <p style={{ margin: "14px 18px", color: TOKEN.ink.meta }}>טוען...</p> : null}{error ? <p style={{ margin: "14px 18px", color: TOKEN.semantic.urgent.ink }}>{error}</p> : null}
      <section style={heroStyle}><div style={heroIconStyle}><BotIcon /></div><div style={{ minWidth: 0, flex: 1 }}><div style={{ fontSize: TOKEN.font.display, fontWeight: TOKEN.weight.bold, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{botName}</div><div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 7, fontSize: TOKEN.font.meta, opacity: 0.92 }}><span style={{ width: 7, height: 7, borderRadius: TOKEN.radius.pill, background: TOKEN.semantic.success.accent }} />{botStatus}</div></div></section>
      <div style={{ padding: "22px 20px 10px", fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.muted }}>ההגדרות שלך</div>
      {CATEGORIES.map((c) => <button key={c.id} type="button" onClick={() => { setCat(c.id); setArea(null); }} style={catCardStyle}><div style={{ display: "flex", alignItems: "center", gap: 13 }}><div style={{ ...catIconStyle, ...categoryIconTone(c.id) }}><CategoryIcon id={c.id} /></div><div style={{ flex: 1, minWidth: 0, textAlign: "right" }}><div style={{ fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>{c.title}</div><div style={{ marginTop: 2, fontSize: TOKEN.font.meta, color: TOKEN.ink.muted }}>{c.sub}</div></div><Chevron /></div><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 13 }}>{c.areas.map((id) => <span key={id} style={previewChipStyle}>{AREAS[id].sub}</span>)}</div></button>)}
      <section style={{ margin: "20px 18px 0", padding: 16, borderRadius: TOKEN.radius.card, border: "1px solid " + TOKEN.border.DEFAULT, background: TOKEN.surface.card }}>
        <div style={{ fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>מוכן להפעיל את הבוט?</div>
        <p style={{ margin: "6px 0 0", fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, lineHeight: 1.5 }}>נרכיב בסיס מהמטרות שבחרת ונחבר אותו לשיחות. הבוט נשאר draft-only - מכין טיוטה ואתה שולח, שום הודעה לא נשלחת לבד.</p>
        {activateError ? <div role="alert" style={{ ...alertStyle, margin: "10px 0 0" }}>{activateError}</div> : null}
        <button type="button" onClick={() => void handleActivate()} disabled={activating} style={{ width: "100%", minHeight: 50, marginTop: 12, border: 0, borderRadius: TOKEN.radius.card, background: TOKEN.action.primary.background, color: TOKEN.ink.inverse, fontFamily: "inherit", fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.title, cursor: activating ? "not-allowed" : "pointer", opacity: activating ? 0.7 : 1, boxShadow: TOKEN.action.primary.shadow }}>{activating ? "מפעיל..." : "הרכב והפעל את הבוט"}</button>
      </section>
      <GuardNote>Dubiz שומר ברקע שהבוט לא ימציא מידע ולא יפעל מעבר למה שהגדרת.</GuardNote>
    </div>
    {cat ? <><button type="button" aria-label="סגור" onClick={closeAll} style={overlayStyle} /><section role="dialog" aria-modal="true" style={{ ...sheetStyle, maxHeight: area ? "92dvh" : "88dvh" }}><div style={gripStyle} /><header style={sheetHeadStyle}>{area ? <button type="button" onClick={() => setArea(null)} aria-label="חזרה" style={backButtonStyle}><Chevron /></button> : null}{currentArea ? <div style={{ ...rowIconStyle, ...areaIconTone(currentArea.id) }}><SettingIcon id={currentArea.id} /></div> : null}<div style={{ flex: 1, minWidth: 0 }}>{area && currentCat ? <div style={{ fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, fontWeight: TOKEN.weight.bold }}>{currentCat.title}</div> : null}<div style={{ fontSize: TOKEN.font.display, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>{currentArea ? currentArea.title : currentCat?.title}</div></div><button type="button" onClick={closeOne} aria-label="סגור" style={xButtonStyle}>×</button></header>{!area && currentCat ? <><p style={sheetDescStyle}>{currentCat.sub}</p><div style={sheetBodyStyle}>{currentCat.areas.map((id) => <button key={id} type="button" onClick={() => setArea(id)} style={rowStyle}><div style={{ ...rowIconStyle, ...areaIconTone(id) }}><SettingIcon id={id} /></div><div style={{ flex: 1, textAlign: "right" }}><div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}><span style={{ fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.bold }}>{AREAS[id].title}</span><Pill status={AREAS[id].status} /></div><div style={{ marginTop: 2, color: TOKEN.ink.muted, fontSize: TOKEN.font.meta }}>{areaSummary(id, payload)}</div></div><Chevron /></button>)}<div style={{ height: 26 }} /></div></> : currentArea ? <div style={sheetBodyStyle}><div style={{ padding: "0 18px 8px" }}><Pill status={currentArea.status} /><p style={{ margin: "8px 0 0", color: TOKEN.ink.muted, fontSize: TOKEN.font.meta, lineHeight: 1.5 }}>{currentArea.desc}</p></div><Editor area={currentArea.id} settings={settings} goals={goals} memory={memory} profile={profile} knowledge={knowledge} learning={learning} /></div> : null}</section></> : null}
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
  if (area === "forbidden") return <ForbiddenEditor />;
  if (area === "handoff") return <HandoffEditor settings={settings} />;
  if (area === "memory") return <MemoryEditor memory={memory} />;
  return <LearningEditor learning={learning} />;
}

function GoalEditor({ goals }: { goals: ReturnType<typeof useGoalsState> }) {
  if (goals.loading) return <LoadingLine />;
  return <><div style={{ padding: "8px 18px 0" }}><span style={countPillStyle}>{goals.selected.length ? String(goals.selected.length) + " מטרות נבחרו" : "טרם נבחרו מטרות"}</span></div><GoalLibrary selected={goals.selected} onToggle={goals.toggle} /><GuardNote>בחירת מטרה נשמרת כשכבת תכנון בלבד. היא לא משנה את זרימת השיחה החיה.</GuardNote><StickyActionBar onSave={() => void goals.save()} saving={goals.saving} saved={goals.savedOk} error={goals.error} saveLabel="שמור מטרות" /></>;
}
function PersonalityEditor({ profile }: { profile: ReturnType<typeof useBotProfileState> }) {
  if (profile.loading) return <LoadingLine />;
  return <><SectionLabel>האישיות שלו</SectionLabel><ChipMulti options={BOT_TRAIT_OPTIONS} selected={profile.traits} onToggle={(v) => profile.setTraits((list) => toggleIn(list, v))} /><SectionLabel>כמה קצר או מפורט</SectionLabel><ScaleSingle options={BOT_VERBOSITY_OPTIONS} selected={profile.verbosity} onSelect={profile.setVerbosity} /><GuardNote>נשמר כהעדפה. ייכנס לקול של הבוט כשהיכולת תופעל.</GuardNote><StickyActionBar onSave={() => void profile.savePersonality()} saving={profile.saving} saved={profile.savedOk} error={profile.error} saveLabel="שמור" /></>;
}
function VoiceEditor({ settings, profile }: { settings: ReturnType<typeof useBotSettingsEditorState>; profile: ReturnType<typeof useBotProfileState> }) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (settings.loading || profile.loading) return <LoadingLine />;
  async function saveAll() { setSaving(true); setSaved(false); setError(null); try { const ok = await profile.saveIdentityAndVoice(); if (!ok) { setError(profile.error || "שמירת הקול נכשלה"); return; } await settings.handleSave(); setSaved(true); window.setTimeout(() => setSaved(false), 2500); } catch { setError("שמירה נכשלה"); } finally { setSaving(false); } }
  return <><section style={{ ...areaPanelStyle, padding: "16px 0" }}><BuilderTextField label="שם הבוט" value={profile.displayName} onChange={profile.setDisplayName} placeholder="שם הבוט" /></section><SectionLabel>טון</SectionLabel><ChipMulti options={BOT_TONE_OPTIONS} selected={profile.tone ? [profile.tone] : []} onToggle={(v) => profile.setTone((cur) => cur === v ? null : v)} /><SectionLabel>שפות</SectionLabel><ChipMulti options={BOT_LANGUAGE_OPTIONS} selected={profile.languages} onToggle={(v) => profile.setLanguages((list) => toggleIn(list, v))} /><SectionLabel>למי הבוט מדבר</SectionLabel><ChipMulti options={BOT_AUDIENCE_OPTIONS} selected={profile.audienceTags} onToggle={(v) => profile.setAudienceTags((list) => toggleIn(list, v))} /><section style={{ ...areaPanelStyle, padding: "16px 0", marginTop: 18 }}><BuilderTextAreaField label="הודעת פתיחה" hint="המשפט הראשון שהלקוח רואה. שדה חי בהגדרות הקיימות." value={settings.welcomeMessage} onChange={settings.setWelcomeMessage} rows={3} placeholder="היי! איך אפשר לעזור היום?" /></section><GuardNote>הודעת הפתיחה חיה. שם/טון/שפות/קהל נשמרים וייכנסו לפעולה כשהיכולת תופעל.</GuardNote><StickyActionBar onSave={() => void saveAll()} saving={saving || settings.saving || profile.saving} saved={saved || settings.savedOk || profile.savedOk} error={error || settings.error || profile.error} saveLabel="שמור" /></>;
}
function ConversationEditor({ settings }: { settings: ReturnType<typeof useBotSettingsEditorState> }) {
  if (settings.loading) return <LoadingLine />;
  const questions = settings.questionsLines.split(/\r?\n/).map((q) => q.trim()).filter(Boolean);
  return <><section style={{ ...areaPanelStyle, padding: "16px 0" }}><BuilderTextAreaField label="פתיחה" hint="הודעת הפתיחה החיה של הבוט." value={settings.welcomeMessage} onChange={settings.setWelcomeMessage} rows={2} placeholder="היי! כמה פרטים ונקבע לך תור" /></section><SectionLabel>שלבי השיחה</SectionLabel><div style={{ display: "grid", gap: 0 }}>{questions.length ? questions.map((q, i) => <StepView key={String(i) + q} index={i + 1} text={q} />) : <p style={{ margin: "0 18px", color: TOKEN.ink.muted, fontSize: TOKEN.font.meta }}>אין שאלות עדיין.</p>}</div><section style={{ ...areaPanelStyle, padding: "16px 0", marginTop: 14 }}><BuilderTextAreaField label="עריכת שאלות legacy" hint="שורה אחת לכל שאלה. נשמר באותו מבנה items שקיים היום." value={settings.questionsLines} onChange={settings.setQuestionsLines} rows={6} placeholder={"מה השם שלך?\nמתי נוח לך?"} /></section><GuardNote>Structured Fields v2 לא מחובר כמקור חי. השמירה נשארת על שאלות legacy.</GuardNote><StickyActionBar onSave={() => void settings.handleSave()} saving={settings.saving} saved={settings.savedOk} error={settings.error} saveLabel="שמור" /></>;
}
function ApproachEditor({ profile }: { profile: ReturnType<typeof useBotProfileState> }) {
  if (profile.loading) return <LoadingLine />;
  return <><SectionLabel>סגנון מכירה</SectionLabel><ScaleSingle options={BOT_SALE_STYLE_OPTIONS} selected={profile.saleStyle} onSelect={profile.setSaleStyle} /><SectionLabel>רמת יוזמה</SectionLabel><ScaleSingle options={BOT_INITIATIVE_OPTIONS} selected={profile.initiativeLevel} onSelect={profile.setInitiativeLevel} /><SectionLabel>מה הכי חשוב לבוט</SectionLabel><ChipMulti options={BOT_PRIORITY_OPTIONS} selected={profile.priorities} onToggle={(v) => profile.setPriorities((list) => toggleIn(list, v))} /><GuardNote>ההעדפות נשמרות וישפיעו על אופן הניסוח כשהיכולת תופעל.</GuardNote><StickyActionBar onSave={() => void profile.saveApproach()} saving={profile.saving} saved={profile.savedOk} error={profile.error} saveLabel="שמור" /></>;
}
function KnowledgeEditor({ settings, knowledge }: { settings: ReturnType<typeof useBotSettingsEditorState>; knowledge: ReturnType<typeof useKnowledgeState> }) {
  if (settings.loading || knowledge.loading) return <LoadingLine />;
  return <><SectionLabel>ידע על העסק</SectionLabel><section style={{ ...areaPanelStyle, padding: "16px 0" }}><div style={{ display: "grid", gap: 16 }}><BuilderTextField label="שעות פעילות" value={knowledge.hours} onChange={knowledge.setHours} placeholder="א'-ה' 9:00-19:00" /><BuilderTextField label="כתובת" value={knowledge.address} onChange={knowledge.setAddress} placeholder="הרצל 24, ירושלים" /><BuilderTextAreaField label="מידע חופשי על העסק" value={knowledge.notes} onChange={knowledge.setNotes} rows={3} placeholder="דברים שכדאי שהבוט יכיר" /></div></section><SectionLabel>שאלות נפוצות</SectionLabel><section style={{ ...areaPanelStyle, padding: "12px 0" }}>{knowledge.faq.length ? knowledge.faq.map((item, i) => <FaqEditor key={i} item={item} index={i} onChange={(patch) => knowledge.updateFaq(i, patch)} onRemove={() => knowledge.removeFaq(i)} />) : <p style={{ margin: "4px 18px", color: TOKEN.ink.muted, fontSize: TOKEN.font.meta }}>אין שאלות נפוצות עדיין.</p>}{knowledge.faq.length < MAX_FAQ_ITEMS ? <button type="button" onClick={knowledge.addFaq} style={addButtonStyle}>+ הוסף שאלה נפוצה</button> : null}</section><SectionLabel>קישור לקטלוג</SectionLabel><section style={areaPanelStyle}><ToggleRow label="הצע קישור לקטלוג באינבוקס" hint="נשמר בהגדרות הקיימות של הבוט." checked={settings.productLinkEnabled} onChange={settings.setProductLinkEnabled} /><div style={{ display: "grid", gap: 16, padding: "16px 0" }}><BuilderTextField label="כתובת דף (URL)" value={settings.productLinkUrl} onChange={settings.setProductLinkUrl} placeholder="https://..." type="url" inputMode="url" dir="ltr" /><BuilderTextAreaField label="משפט קצר לפני הקישור" value={settings.productLinkIntro} onChange={settings.setProductLinkIntro} rows={2} placeholder="הנה הקישור לקטלוג שלנו" /></div></section><GuardNote>אם הבוט לא יודע משהו - הוא לא ימציא. קישור הקטלוג נשמר דרך שמירת ההגדרות המלאה הקיימת.</GuardNote><StickyActionBar onSave={() => void knowledge.save(settings.handleSave)} saving={knowledge.saving || settings.saving} saved={knowledge.savedOk || settings.savedOk} error={knowledge.error || settings.error} saveLabel="שמור ידע" /></>;
}
function AllowedEditor({ settings }: { settings: ReturnType<typeof useBotSettingsEditorState> }) {
  if (settings.loading) return <LoadingLine />;
  return <><section style={areaPanelStyle}>{FINAL_ACTIONS.map((a) => <ChoiceRow key={a.value} label={a.label} hint={finalActionHint(a.value)} selected={settings.finalAction === a.value} onSelect={() => settings.setFinalAction(a.value)} />)}{settings.finalAction === "SEND_LINK" ? <div style={{ padding: "16px 0" }}><BuilderTextField label="כתובת קישור (URL)" value={settings.websiteUrl} onChange={settings.setWebsiteUrl} placeholder="https://..." type="url" inputMode="url" dir="ltr" /></div> : null}</section><GuardNote>הערך שנשמר נשאר אותו enum קיים: LEAVE_MESSAGE, COLLECT_DETAILS, SEND_LINK או ESCALATE.</GuardNote><StickyActionBar onSave={() => void settings.handleSave()} saving={settings.saving} saved={settings.savedOk} error={settings.error} saveLabel="שמור" /></>;
}
function AutonomyEditor({ settings }: { settings: ReturnType<typeof useBotSettingsEditorState> }) {
  if (settings.loading) return <LoadingLine />;
  return <><section style={{ ...areaPanelStyle, padding: "16px 0" }}><div style={{ margin: "0 18px 14px" }}><h2 style={sectionTitle}>מצב עבודה</h2><p style={sectionHint}>בחר אם הבוט כבוי, או מכין טיוטות שאתה מאשר ושולח.</p></div><div style={{ margin: "0 18px" }}><WorkModeControls settings={settings} /></div><div style={{ display: "grid", gap: 10, margin: "16px 18px 0" }}><Level n="1" title="ידני - אני עונה בעצמי" active={settings.workMode === "MANUAL"} soon={false} /><Level n="2" title="טיוטות חכמות - הבוט מכין, אני שולח" active={settings.workMode !== "MANUAL"} soon={false} /><Level n="3" title="מבצע אחרי אישור" active={false} soon /><Level n="4" title="מבצע לבד" active={false} soon /></div></section><GuardNote>אזור מה אסור ומתי מעביר תמיד גוברים - העצמאות בתוך הגבולות שלך.</GuardNote><StickyActionBar onSave={() => void settings.handleSave()} saving={settings.saving} saved={settings.savedOk} error={settings.error} saveLabel="שמור" /></>;
}
function ForbiddenEditor() {
  return <><section style={areaPanelStyle}>{["להתחייב למחיר", "להבטיח זמינות", "לתת ייעוץ מקצועי", "לתת הנחות"].map((label) => <ForbiddenToggleRow key={label} label={label} />)}</section><GuardNote>אזור זה עדיין בפיתוח. כרגע הבוט תמיד מכין טיוטה בלבד - אתה שולח, ולכן הוא לא יכול להתחייב בעצמו.</GuardNote><div style={{ height: 24 }} /></>;
}
function HandoffEditor({ settings }: { settings: ReturnType<typeof useBotSettingsEditorState> }) {
  if (settings.loading) return <LoadingLine />;
  function setBoundary(key: keyof BotBoundaryPresets, checked: boolean) { settings.setBoundaries((b) => ({ ...b, [key]: checked })); }
  function setThreshold(value: number) { settings.setBoundaries((b) => ({ ...b, afterMessageCountThreshold: Math.min(30, Math.max(3, value)) })); }
  return <><section style={areaPanelStyle}>{BOT_BOUNDARY_OPTIONS.map((opt) => { const checked = settings.boundaries[opt.key] === true; return <ToggleRow key={opt.key} label={opt.label} hint={opt.hint} checked={checked} onChange={(next) => setBoundary(opt.key, next)}>{opt.isThreshold && checked ? <Stepper value={settings.boundaries.afterMessageCountThreshold} min={3} max={30} label="הודעות מהלקוח" onChange={setThreshold} /> : null}</ToggleRow>; })}</section><GuardNote>גם בלי הגדרה - כשהבוט לא בטוח, הוא יעדיף להעביר אליך מאשר לנחש.</GuardNote><StickyActionBar onSave={() => void settings.handleSave()} saving={settings.saving} saved={settings.savedOk} error={settings.error} saveLabel="שמור" /></>;
}
function MemoryEditor({ memory }: { memory: ReturnType<typeof useMemoryPolicyState> }) {
  if (memory.loading) return <LoadingLine />;
  return <><SectionLabel>מה מותר לזכור על כל לקוח</SectionLabel><section style={areaPanelStyle}>{MEMORY_TOGGLE_OPTIONS.map((opt) => <ToggleRow key={opt.key} label={opt.label} hint={opt.hint} checked={memory.policy[opt.key]} onChange={(next) => memory.toggle(opt.key, next)} />)}</section><GuardNote>זו מדיניות לעתיד. כרגע הבוט לא שומר מידע על לקוחות ולא מכיר אותם.</GuardNote><StickyActionBar onSave={() => void memory.save()} saving={memory.saving} saved={memory.savedOk} error={memory.error} saveLabel="שמור מדיניות" /></>;
}
function LearningEditor({ learning }: { learning: ReturnType<typeof useLearningState> }) {
  if (learning.loading) return <LoadingLine />;
  return <>{learning.error ? <div role="alert" style={alertStyle}>{learning.error}</div> : null}{learning.items.length ? <section style={{ display: "grid", gap: 10, padding: "12px 18px 0" }}>{learning.items.map((s) => <div key={s.id} style={learnCardStyle}><div style={{ fontSize: TOKEN.font.caption, fontWeight: TOKEN.weight.bold, color: TOKEN.semantic.info.ink }}>{LEARNING_TYPE_LABELS[s.type as LearningType] || "הצעה"}</div><div style={{ marginTop: 5, fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>{s.title}</div>{s.description ? <div style={{ marginTop: 4, fontSize: TOKEN.font.meta, color: TOKEN.ink.secondary, lineHeight: 1.45 }}>{s.description}</div> : null}<div style={{ display: "flex", gap: 8, marginTop: 11 }}><button type="button" disabled={learning.busyId === s.id} onClick={() => void learning.act(s.id, "adopt")} style={primaryMiniButton}>אמץ כהעדפה</button><button type="button" disabled={learning.busyId === s.id} onClick={() => void learning.act(s.id, "dismiss")} style={secondaryMiniButton}>דחה</button></div></div>)}</section> : <div style={emptyStateStyle}><div style={{ fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.secondary }}>אין הצעות כרגע</div><p style={{ margin: "6px 0 0", fontSize: TOKEN.font.meta, lineHeight: 1.5 }}>כשיזוהו דפוסים שכדאי לשפר, הם יופיעו כאן.</p></div>}<GuardNote>אימוץ מסמן העדפה בלבד - הבוט לא משנה את עצמו אוטומטית.</GuardNote><div style={{ height: 24 }} /></>;
}

function StepView({ index, text }: { index: number; text: string }) { return <div style={{ position: "relative", margin: "0 18px", paddingRight: 28 }}><span style={{ position: "absolute", right: 4, top: 15, width: 13, height: 13, borderRadius: TOKEN.radius.pill, background: TOKEN.surface.card, border: "3px solid " + TOKEN.brand.mid, boxSizing: "border-box" }} /><div style={{ border: "1px solid " + TOKEN.border.DEFAULT, borderRadius: TOKEN.radius.input, padding: 12, marginBottom: 9, display: "flex", alignItems: "center", gap: 10 }}><div style={{ flex: 1, fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold }}>{text}</div><span style={{ fontSize: TOKEN.font.caption, fontWeight: TOKEN.weight.bold, padding: "3px 8px", borderRadius: TOKEN.radius.pill, background: TOKEN.semantic.info.bgSoft, color: TOKEN.semantic.info.ink }}>שלב {index}</span></div></div>; }
function FaqEditor({ item, index, onChange, onRemove }: { item: FaqItem; index: number; onChange: (patch: Partial<FaqItem>) => void; onRemove: () => void }) { return <div style={faqBoxStyle}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}><span style={{ fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.muted }}>שאלה {index + 1}</span><button type="button" onClick={onRemove} aria-label="הסר שאלה" style={iconTextButton}>×</button></div><input value={item.question} onChange={(e) => onChange({ question: e.target.value })} placeholder="השאלה" style={inputStyle} /><textarea value={item.answer} onChange={(e) => onChange({ answer: e.target.value })} placeholder="התשובה" rows={2} style={{ ...inputStyle, resize: "vertical", minHeight: 56 }} /></div>; }
function ChipMulti<T extends string>({ options, selected, onToggle }: { options: ReadonlyArray<{ value: T; label: string }>; selected: T[]; onToggle: (value: T) => void }) { return <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "0 18px" }}>{options.map((opt) => { const on = selected.includes(opt.value); return <button key={opt.value} type="button" aria-pressed={on} onClick={() => onToggle(opt.value)} style={{ display: "inline-flex", alignItems: "center", height: 38, padding: "0 14px", borderRadius: TOKEN.radius.pill, border: "1px solid " + (on ? TOKEN.brand.mid : TOKEN.border.DEFAULT), background: on ? TOKEN.action.primary.background : TOKEN.surface.inset, color: on ? TOKEN.ink.inverse : TOKEN.ink.primary, fontFamily: "inherit", fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.body, cursor: "pointer" }}>{opt.label}</button>; })}</div>; }
function ScaleSingle<T extends string>({ options, selected, onSelect }: { options: ReadonlyArray<{ value: T; label: string; hint?: string }>; selected: T | null; onSelect: (value: T) => void }) { return <div style={{ margin: "0 18px", display: "grid", gap: 9 }}>{options.map((opt) => { const on = selected === opt.value; return <button key={opt.value} type="button" aria-pressed={on} onClick={() => onSelect(opt.value)} style={{ display: "flex", alignItems: "center", gap: 13, padding: 14, borderRadius: TOKEN.radius.card, border: "1px solid " + (on ? TOKEN.brand.mid : TOKEN.border.DEFAULT), background: on ? TOKEN.brand.soft : TOKEN.surface.card, cursor: "pointer", textAlign: "right", fontFamily: "inherit", width: "100%" }}><span aria-hidden style={{ width: 20, height: 20, borderRadius: TOKEN.radius.pill, border: (on ? 6 : 2) + "px solid " + (on ? TOKEN.brand.mid : TOKEN.border.hover), flexShrink: 0, boxSizing: "border-box" }} /><span style={{ flex: 1, minWidth: 0 }}><span style={{ display: "block", fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>{opt.label}</span>{opt.hint ? <span style={{ display: "block", marginTop: 2, fontSize: TOKEN.font.meta, color: TOKEN.ink.muted }}>{opt.hint}</span> : null}</span></button>; })}</div>; }
function toggleIn<T>(list: T[], value: T): T[] { return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]; }

type BotApiResponse = { identity?: { displayName: string | null; avatar: string | null }; profile?: { voice?: BotVoiceConfig; personality?: BotPersonalityConfig; approach?: BotApproachConfig } };
function useBotProfileState() {
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null), [savedOk, setSavedOk] = useState(false);
  const [displayName, setDisplayName] = useState(""), [tone, setTone] = useState<BotTone | null>(null), [languages, setLanguages] = useState<BotLanguage[]>([]), [audienceTags, setAudienceTags] = useState<BotAudienceTag[]>([]), [traits, setTraits] = useState<BotTrait[]>([]), [verbosity, setVerbosity] = useState<BotVerbosity | null>(null), [saleStyle, setSaleStyle] = useState<BotSaleStyle | null>(null), [initiativeLevel, setInitiativeLevel] = useState<BotInitiativeLevel | null>(null), [priorities, setPriorities] = useState<BotPriority[]>([]);
  const load = useCallback(async () => { setLoading(true); setError(null); try { const res = await fetch("/api/business/bot", { headers: { Authorization: "Bearer " + getAuthToken() }, cache: "no-store" }); if (!res.ok) throw new Error(); const data = await res.json() as BotApiResponse; setDisplayName(data.identity?.displayName || ""); setTone(data.profile?.voice?.tone || null); setLanguages(data.profile?.voice?.languages || []); setAudienceTags(data.profile?.voice?.audienceTags || []); setTraits(data.profile?.personality?.traits || []); setVerbosity(data.profile?.personality?.verbosity || null); setSaleStyle(data.profile?.approach?.saleStyle || null); setInitiativeLevel(data.profile?.approach?.initiativeLevel || null); setPriorities(data.profile?.approach?.priorities || []); } catch { setError("לא ניתן לטעון את פרטי הבוט"); } finally { setLoading(false); } }, []);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (!cancelled) void load(); }); return () => { cancelled = true; }; }, [load]);
  const voiceBlock = useMemo<BotVoiceConfig>(() => { const b: BotVoiceConfig = {}; if (tone) b.tone = tone; if (languages.length) b.languages = languages; if (audienceTags.length) b.audienceTags = audienceTags; return b; }, [tone, languages, audienceTags]);
  const personalityBlock = useMemo<BotPersonalityConfig>(() => { const b: BotPersonalityConfig = {}; if (traits.length) b.traits = traits; if (verbosity) b.verbosity = verbosity; return b; }, [traits, verbosity]);
  const approachBlock = useMemo<BotApproachConfig>(() => { const b: BotApproachConfig = {}; if (saleStyle) b.saleStyle = saleStyle; if (initiativeLevel) b.initiativeLevel = initiativeLevel; if (priorities.length) b.priorities = priorities; return b; }, [saleStyle, initiativeLevel, priorities]);
  const patch = useCallback(async (body: Record<string, unknown>) => { setSaving(true); setError(null); try { const res = await fetch("/api/business/bot", { method: "PATCH", headers: { Authorization: "Bearer " + getAuthToken(), "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!res.ok) throw new Error(); setSavedOk(true); window.setTimeout(() => setSavedOk(false), 2500); await load(); return true; } catch { setError("שמירה נכשלה"); return false; } finally { setSaving(false); } }, [load]);
  return { loading, saving, error, savedOk, displayName, setDisplayName, tone, setTone, languages, setLanguages, audienceTags, setAudienceTags, traits, setTraits, verbosity, setVerbosity, saleStyle, setSaleStyle, initiativeLevel, setInitiativeLevel, priorities, setPriorities, saveIdentityAndVoice: () => patch({ displayName: displayName.trim() || null, profile: { voice: voiceBlock } }), savePersonality: () => patch({ profile: { personality: personalityBlock } }), saveApproach: () => patch({ profile: { approach: approachBlock } }) };
}
function useKnowledgeState() {
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [savedOk, setSavedOk] = useState(false), [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(""), [address, setAddress] = useState(""), [notes, setNotes] = useState(""), [faq, setFaq] = useState<FaqItem[]>([]);
  const load = useCallback(async () => { setLoading(true); setError(null); try { const res = await fetch("/api/business/bot/knowledge", { headers: { Authorization: "Bearer " + getAuthToken() }, cache: "no-store" }); if (!res.ok) throw new Error(); const data = await res.json(); setHours(data.knowledge?.hours || ""); setAddress(data.knowledge?.address || ""); setNotes(data.knowledge?.notes || ""); setFaq(data.knowledge?.faq || []); } catch { setError("לא ניתן לטעון את הידע"); } finally { setLoading(false); } }, []);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (!cancelled) void load(); }); return () => { cancelled = true; }; }, [load]);
  function updateFaq(i: number, patch: Partial<FaqItem>) { setFaq((cur) => cur.map((f, idx) => idx === i ? { ...f, ...patch } : f)); }
  function addFaq() { setFaq((cur) => cur.length >= MAX_FAQ_ITEMS ? cur : [...cur, { question: "", answer: "" }]); }
  function removeFaq(i: number) { setFaq((cur) => cur.filter((_, idx) => idx !== i)); }
  async function save(saveSettings: () => Promise<void> | void) { setSaving(true); setError(null); try { const cleanFaq = faq.map((f) => ({ question: f.question.trim(), answer: f.answer.trim() })).filter((f) => f.question.length > 0); const res = await fetch("/api/business/bot/knowledge", { method: "PUT", headers: { Authorization: "Bearer " + getAuthToken(), "Content-Type": "application/json" }, body: JSON.stringify({ hours: hours.trim() || null, address: address.trim() || null, notes: notes.trim() || null, faq: cleanFaq }) }); if (!res.ok) throw new Error(); await saveSettings(); setSavedOk(true); window.setTimeout(() => setSavedOk(false), 2500); await load(); } catch { setError("שמירת הידע נכשלה"); } finally { setSaving(false); } }
  return { loading, saving, savedOk, error, hours, setHours, address, setAddress, notes, setNotes, faq, updateFaq, addFaq, removeFaq, save };
}
type LearningSuggestion = { id: number; type: string; title: string; description: string | null };
function useLearningState() {
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [busyId, setBusyId] = useState<number | null>(null), [items, setItems] = useState<LearningSuggestion[]>([]);
  const load = useCallback(async () => { setLoading(true); setError(null); try { const res = await fetch("/api/business/bot/learning-suggestions", { headers: { Authorization: "Bearer " + getAuthToken() }, cache: "no-store" }); if (!res.ok) throw new Error(); const data = await res.json(); setItems(data.suggestions || []); } catch { setError("לא ניתן לטעון את ההצעות"); } finally { setLoading(false); } }, []);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (!cancelled) void load(); }); return () => { cancelled = true; }; }, [load]);
  async function act(id: number, action: "adopt" | "dismiss") { setBusyId(id); setError(null); try { const res = await fetch(`/api/business/bot/learning-suggestions/${id}/${action}`, { method: "POST", headers: { Authorization: "Bearer " + getAuthToken() } }); if (!res.ok) throw new Error(); setItems((cur) => cur.filter((s) => s.id !== id)); } catch { setError("הפעולה נכשלה"); } finally { setBusyId(null); } }
  return { loading, error, busyId, items, act };
}
function ForbiddenToggleRow({ label }: { label: string }) { return <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderTop: "1px solid " + TOKEN.border.DEFAULT, opacity: 0.72 }}><div style={{ flex: 1, fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.semibold, color: TOKEN.ink.primary }}>{label}</div><span aria-hidden style={{ width: 46, height: 27, borderRadius: TOKEN.radius.pill, background: TOKEN.semantic.urgent.accent, position: "relative", flexShrink: 0 }}><span style={{ position: "absolute", top: 3, right: 3, width: 21, height: 21, borderRadius: TOKEN.radius.pill, background: TOKEN.surface.card, boxShadow: TOKEN.shadow.elevated }} /></span></div>; }

const inputStyle: CSSProperties = { width: "100%", border: "1px solid " + TOKEN.border.DEFAULT, borderRadius: TOKEN.radius.input, background: TOKEN.surface.inset, padding: "11px 13px", color: TOKEN.ink.primary, fontFamily: "inherit", fontSize: TOKEN.font.body, lineHeight: 1.5, outline: "none", boxSizing: "border-box" };
const addButtonStyle: CSSProperties = { margin: "2px 18px 0", width: "calc(100% - 36px)", border: "1.5px dashed " + TOKEN.border.hover, borderRadius: TOKEN.radius.input, padding: 13, background: "transparent", color: TOKEN.brand.mid, fontFamily: "inherit", fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.body, cursor: "pointer" };
const faqBoxStyle: CSSProperties = { margin: "0 18px 10px", border: "1px solid " + TOKEN.border.DEFAULT, borderRadius: TOKEN.radius.card, padding: 12, display: "grid", gap: 8 };
const iconTextButton: CSSProperties = { border: 0, background: "transparent", color: TOKEN.ink.meta, cursor: "pointer", fontSize: TOKEN.font.display, lineHeight: 1 };
const alertStyle: CSSProperties = { margin: "12px 18px 0", background: TOKEN.semantic.urgent.bgSoft, color: TOKEN.semantic.urgent.ink, padding: "10px 12px", borderRadius: TOKEN.radius.input, fontSize: TOKEN.font.meta };
const learnCardStyle: CSSProperties = { border: "1px solid " + TOKEN.semantic.info.border, background: TOKEN.semantic.info.bgSoft, borderRadius: TOKEN.radius.card, padding: 14 };
const primaryMiniButton: CSSProperties = { flex: 1, height: 38, borderRadius: TOKEN.radius.input, border: 0, background: TOKEN.action.primary.background, color: TOKEN.ink.inverse, fontFamily: "inherit", fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.meta, cursor: "pointer" };
const secondaryMiniButton: CSSProperties = { flex: 1, height: 38, borderRadius: TOKEN.radius.input, border: "1px solid " + TOKEN.border.hover, background: TOKEN.surface.card, color: TOKEN.ink.muted, fontFamily: "inherit", fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.meta, cursor: "pointer" };
const emptyStateStyle: CSSProperties = { margin: "24px 18px", textAlign: "center", color: TOKEN.ink.muted };
function WorkModeControls({ settings }: { settings: ReturnType<typeof useBotSettingsEditorState> }) { return <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{BOT_WORK_MODE_OPTIONS_ACTIVE.map((opt) => { const selected = settings.workMode === opt.id; return <button key={opt.id} type="button" onClick={() => { settings.setWorkMode(opt.id); const patch = settingsPatchForWorkMode(opt.id, { version: 1, workMode: opt.id, boundaries: settings.boundaries }); settings.setEnabled(patch.enabled); settings.setShowDraftSuggestionsInInbox(patch.showDraftSuggestionsInInbox); }} style={{ textAlign: "right", width: "100%", border: (selected ? "2px solid " : "1px solid ") + (selected ? TOKEN.brand.mid : TOKEN.border.DEFAULT), borderRadius: TOKEN.radius.card, padding: "14px 16px", background: selected ? TOKEN.brand.soft : TOKEN.surface.card, cursor: "pointer", fontFamily: "inherit" }}><div style={{ fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.body }}>{opt.title}</div><div style={{ fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, marginTop: 4, lineHeight: 1.45 }}>{opt.description}</div><div style={{ fontSize: TOKEN.font.meta, color: selected ? TOKEN.brand.mid : TOKEN.ink.meta, marginTop: 6, fontWeight: TOKEN.weight.semibold }}>{opt.trustLine}</div></button>; })}</div>; }
function Level({ n, title, active, soon }: { n: string; title: string; active: boolean; soon: boolean }) { return <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: TOKEN.radius.input, border: "1px solid " + (active ? TOKEN.brand.softBorder : TOKEN.border.DEFAULT), background: active ? TOKEN.brand.soft : TOKEN.surface.card, opacity: soon ? 0.62 : 1 }}><span style={{ width: 28, height: 28, borderRadius: TOKEN.radius.pill, display: "grid", placeItems: "center", background: active ? TOKEN.brand.mid : TOKEN.surface.inset, color: active ? TOKEN.ink.inverse : TOKEN.ink.muted, fontWeight: TOKEN.weight.bold }}>{n}</span><span style={{ flex: 1, fontSize: TOKEN.font.body, color: TOKEN.ink.secondary }}>{title}</span><Pill status={soon ? "soon" : active ? "live" : "saved"} label={soon ? "בקרוב" : active ? "עכשיו" : "זמין"} /></div>; }
function Pill({ status, label }: { status: Status; label?: string }) { const color = status === "live" ? TOKEN.semantic.success.ink : status === "saved" ? TOKEN.semantic.info.ink : TOKEN.ink.muted; const bg = status === "live" ? TOKEN.semantic.success.bgSoft : status === "saved" ? TOKEN.semantic.info.bgSoft : TOKEN.surface.inset; const border = status === "live" ? TOKEN.semantic.success.border : status === "saved" ? TOKEN.semantic.info.border : TOKEN.border.DEFAULT; return <span style={{ display: "inline-flex", alignItems: "center", fontSize: TOKEN.font.caption, fontWeight: TOKEN.weight.bold, padding: "3px 8px", borderRadius: TOKEN.radius.pill, color, background: bg, border: "1px solid " + border }}>{label || statusText(status)}</span>; }
function SectionLabel({ children }: { children: ReactNode }) { return <div style={{ padding: "18px 18px 8px", fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.muted }}>{children}</div>; }
function LoadingLine() { return <p style={{ margin: 18, color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>טוען...</p>; }
function finalActionHint(action: FinalAction): string { if (action === "LEAVE_MESSAGE") return "מסכם את הפנייה ומשאיר לך לטיפול."; if (action === "COLLECT_DETAILS") return "מבקש את הפרטים הדרושים להמשך."; if (action === "SEND_LINK") return "מצרף קישור שהוגדר כאן."; return "מסמן שהשיחה עוברת אליך."; }

function useGoalsState() { const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [savedOk, setSavedOk] = useState(false); const [error, setError] = useState<string | null>(null); const [selected, setSelected] = useState<string[]>([]); const load = useCallback(async () => { setLoading(true); setError(null); try { const res = await fetch("/api/business/bot/goals", { headers: { Authorization: "Bearer " + getAuthToken() }, cache: "no-store" }); if (!res.ok) throw new Error(); const data = await res.json(); setSelected((data.selected || []).map((g: { goalKey: string }) => g.goalKey)); } catch { setError("לא ניתן לטעון מטרות"); } finally { setLoading(false); } }, []); useEffect(() => { let cancelled = false; queueMicrotask(() => { if (!cancelled) void load(); }); return () => { cancelled = true; }; }, [load]); function toggle(key: string) { setSelected((cur) => cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]); } async function save() { setSaving(true); setError(null); try { const res = await fetch("/api/business/bot/goals", { method: "PUT", headers: { Authorization: "Bearer " + getAuthToken(), "Content-Type": "application/json" }, body: JSON.stringify({ goals: selected }) }); if (!res.ok) throw new Error(); setSavedOk(true); window.setTimeout(() => setSavedOk(false), 2500); await load(); } catch { setError("שמירת מטרות נכשלה"); } finally { setSaving(false); } } return { loading, saving, savedOk, error, selected, toggle, save }; }
function useMemoryPolicyState() { const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [savedOk, setSavedOk] = useState(false); const [error, setError] = useState<string | null>(null); const [policy, setPolicy] = useState<BotMemoryPolicy>(emptyMemoryPolicy()); const load = useCallback(async () => { setLoading(true); setError(null); try { const res = await fetch("/api/business/bot/memory-policy", { headers: { Authorization: "Bearer " + getAuthToken() }, cache: "no-store" }); if (!res.ok) throw new Error(); const data = await res.json(); setPolicy({ ...emptyMemoryPolicy(), ...(data.policy || {}) }); } catch { setError("לא ניתן לטעון מדיניות זיכרון"); } finally { setLoading(false); } }, []); useEffect(() => { let cancelled = false; queueMicrotask(() => { if (!cancelled) void load(); }); return () => { cancelled = true; }; }, [load]); function toggle(key: MemoryToggleKey, value: boolean) { setPolicy((p) => ({ ...p, [key]: value })); } async function save() { setSaving(true); setError(null); try { const res = await fetch("/api/business/bot/memory-policy", { method: "PUT", headers: { Authorization: "Bearer " + getAuthToken(), "Content-Type": "application/json" }, body: JSON.stringify(policy) }); if (!res.ok) throw new Error(); setSavedOk(true); window.setTimeout(() => setSavedOk(false), 2500); await load(); } catch { setError("שמירת מדיניות נכשלה"); } finally { setSaving(false); } } return { loading, saving, savedOk, error, policy, toggle, save }; }

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
function Chevron() { return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden><path d="m15 6-6 6 6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" /></svg>; }
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
const catCardStyle: CSSProperties = { display: "block", width: "calc(100% - 36px)", margin: "0 18px 13px", border: "1px solid " + TOKEN.border.DEFAULT, borderRadius: TOKEN.radius.modal, padding: 17, background: TOKEN.surface.card, textAlign: "right", fontFamily: "inherit", cursor: "pointer", boxSizing: "border-box" };
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
const rowStyle: CSSProperties = { width: "100%", display: "flex", alignItems: "center", gap: 13, padding: "15px 18px", border: 0, borderTop: "1px solid " + TOKEN.border.DEFAULT, background: TOKEN.surface.card, cursor: "pointer", textAlign: "right", fontFamily: "inherit" };
const rowIconStyle: CSSProperties = { width: 40, height: 40, borderRadius: TOKEN.radius.input, background: TOKEN.surface.inset, display: "grid", placeItems: "center", flexShrink: 0, color: TOKEN.brand.mid };
const countPillStyle: CSSProperties = { display: "inline-flex", alignItems: "center", fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, color: TOKEN.brand.mid, background: TOKEN.brand.soft, padding: "6px 13px", borderRadius: TOKEN.radius.pill };
const sectionTitle: CSSProperties = { margin: "0 0 6px", fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary, lineHeight: 1.3 };
const sectionHint: CSSProperties = { margin: 0, fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, lineHeight: 1.55 };
