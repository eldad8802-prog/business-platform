"use client";

/**
 * "הגדרת יומן" (/calendar/setup) — the first-time setup wizard (G9, owner-approved new screen, design a). Three steps:
 *   1 שעות פעילות   a ready week (א׳–ה׳ 09:00–19:00, ו׳ 09:00–13:00), each day editable or closed;
 *   2 שירותים       "איזה סוג עסק?" → services ready to edit (name, length, a price only if the owner types one —
 *                   Dubiz never invents a price), "+ שירות נוסף";
 *   3 צוות          "אני לבד" (nothing is written) or "יש לי עובדים" (names only — staff have no login).
 * Shown only while the calendar is not configured (no hours and no services — the server's `needsSetup`). "דילוג" leaves
 * without writing anything; the calendar does not open the wizard again on this device, and ניהול היומן links back to it
 * while the calendar is still empty. The server writes each part only while it is still empty, so finishing never
 * overwrites what was configured meanwhile — it says which parts it kept.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";

import { DAY_NAMES, TimeSelect } from "./availability-editors";
import { applySetup, CalendarApiError, getSetupState, type SetupResultWire, type SetupStateWire } from "./calendar-client";
import { errorText, LIMITS, WEEKDAY_LETTER } from "./calendar-model";
import { FeatureOff, IconPlus, IconX, Loading, ScreenHead, Seg, Switch } from "./ui";
import s from "./calendar.module.css";

/** This device's "not now": the calendar does not open the wizard again by itself (a convenience — nothing depends on it). */
export const SETUP_SKIP_KEY = "dubiz.calendar.setupSkipped";
export function setupSkipped(): boolean {
  try { return window.localStorage.getItem(SETUP_SKIP_KEY) === "1"; } catch { return false; }
}
function rememberSkip() {
  try { window.localStorage.setItem(SETUP_SKIP_KEY, "1"); } catch { /* private mode: the wizard may open again — harmless */ }
}

type Win = { startMinute: number; endMinute: number };
/** The ready week of design a: Sunday–Thursday 09:00–19:00, Friday 09:00–13:00, Saturday closed. */
export const DEFAULT_WEEK: Win[][] = [0, 1, 2, 3, 4, 5, 6].map((d) => (d <= 4 ? [{ startMinute: 540, endMinute: 1140 }] : d === 5 ? [{ startMinute: 540, endMinute: 780 }] : []));

export type BusinessType = "barber" | "cosmetics" | "treatments" | "fitness" | "lessons" | "consulting" | "other";
export const BUSINESS_TYPES: Array<[BusinessType, string]> = [
  ["barber", "מספרה"], ["cosmetics", "קוסמטיקה"], ["treatments", "טיפולים"], ["fitness", "אימונים"], ["lessons", "שיעורים"], ["consulting", "ייעוץ"], ["other", "אחר"],
];
/** Services to start from — names and lengths only; the owner edits them, and a price is the owner's to give. */
export const SERVICE_TEMPLATES: Record<BusinessType, Array<{ name: string; durationMinutes: number }>> = {
  barber: [{ name: "תספורת גבר", durationMinutes: 30 }, { name: "תספורת + זקן", durationMinutes: 45 }, { name: "צבע", durationMinutes: 90 }],
  cosmetics: [{ name: "טיפול פנים", durationMinutes: 60 }, { name: "עיצוב גבות", durationMinutes: 20 }, { name: "מניקור", durationMinutes: 45 }],
  treatments: [{ name: "טיפול", durationMinutes: 60 }, { name: "טיפול קצר", durationMinutes: 30 }, { name: "פגישת היכרות", durationMinutes: 30 }],
  fitness: [{ name: "אימון אישי", durationMinutes: 60 }, { name: "אימון זוגי", durationMinutes: 60 }, { name: "אימון היכרות", durationMinutes: 30 }],
  lessons: [{ name: "שיעור פרטי", durationMinutes: 45 }, { name: "שיעור כפול", durationMinutes: 90 }, { name: "שיעור ניסיון", durationMinutes: 30 }],
  consulting: [{ name: "פגישת ייעוץ", durationMinutes: 60 }, { name: "שיחת היכרות", durationMinutes: 20 }, { name: "פגישת המשך", durationMinutes: 45 }],
  other: [{ name: "פגישה", durationMinutes: 30 }],
};

type ServiceDraft = { on: boolean; name: string; duration: string; price: string };
const draftsOf = (t: BusinessType): ServiceDraft[] => SERVICE_TEMPLATES[t].map((x, i) => ({ on: i < 2 || t === "other", name: x.name, duration: String(x.durationMinutes), price: "" }));

/** What the wizard will send, and what is still wrong with it (pure; the tests use it). */
export function buildSetup(week: Win[][], services: ServiceDraft[], team: "alone" | "staff", staff: string[]) {
  const problems: string[] = [];
  week.forEach((ranges, d) => ranges.forEach((r) => { if (!(r.startMinute < r.endMinute)) problems.push(`יום ${DAY_NAMES[d]}: שעת הסיום לפני שעת ההתחלה.`); }));
  const chosen = services.filter((x) => x.on);
  const names = new Set<string>();
  const out = chosen.map((x) => {
    const name = x.name.trim();
    const minutes = Number(x.duration);
    const price = x.price.trim() === "" ? null : Number(x.price);
    if (!name) problems.push("לכל שירות צריך שם.");
    else if (name.length > 120) problems.push(`השם „${name.slice(0, 20)}…” ארוך מדי.`);
    else if (names.has(name)) problems.push(`השירות „${name}” מופיע פעמיים.`);
    names.add(name);
    if (!(Number.isInteger(minutes) && minutes >= LIMITS.minDuration && minutes <= LIMITS.maxDuration)) problems.push(`„${name || "שירות"}”: משך בין ${LIMITS.minDuration} ל־${LIMITS.maxDuration} דקות.`);
    if (price !== null && !(Number.isFinite(price) && price >= 0)) problems.push(`„${name || "שירות"}”: מחיר לא תקין.`);
    return { name, durationMinutes: minutes, priceAmount: price };
  });
  const people = team === "staff" ? staff.map((x) => x.trim()).filter(Boolean) : [];
  if (people.some((x) => x.length > 80)) problems.push("שם עובד ארוך מדי (עד 80 תווים).");
  return {
    problems: [...new Set(problems)],
    body: {
      hours: week.flatMap((ranges, weekday) => ranges.map((r) => ({ weekday, ...r }))),
      services: out,
      staff: people.map((displayName) => ({ displayName })),
    },
  };
}

const STEP_TITLE = ["שעות פעילות", "שירותים", "צוות"];

export function SetupWizard() {
  const on = useFeatureState("appointments");
  const router = useRouter();
  const [state, setState] = useState<SetupStateWire | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [week, setWeek] = useState<Win[][]>(DEFAULT_WEEK);
  const [type, setType] = useState<BusinessType>("barber");
  const [services, setServices] = useState<ServiceDraft[]>(() => draftsOf("barber"));
  const [team, setTeam] = useState<"alone" | "staff">("alone");
  const [staff, setStaff] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SetupResultWire | null>(null);

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    getSetupState().then((v) => { if (!cancelled) setState(v); }).catch((e) => { if (!cancelled) setLoadError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK")); });
    return () => { cancelled = true; };
  }, [on]);

  if (on === false) return <FeatureOff title="הגדרת יומן" />;

  const skip = () => { rememberSkip(); router.push("/calendar"); };
  const head = (
    <ScreenHead
      title="הגדרת יומן"
      fallback="/calendar"
      fallbackLabel={step > 0 && !done ? "חזרה" : "ליומן"}
      onBeforeLeave={step > 0 && !done ? () => { setStep(step - 1); setError(null); } : undefined}
      end={!done ? <button type="button" className={s.wizSkip} onClick={skip}>דילוג</button> : null}
    />
  );

  if (loadError) return <main className={s.screen}><div className={s.narrow}>{head}<p className={s.fieldErr} role="alert">{loadError}</p></div></main>;
  if (!state) return <main className={s.screen}><div className={s.narrow}>{head}<Loading label="טוען" rows={4} /></div></main>;

  if (!state.needsSetup && !done) {
    return (
      <main className={s.screen} data-page-intent="content">
        <div className={s.narrow}>
          {head}
          <div className={s.wizCard}>
            <strong>היומן כבר מוגדר.</strong>
            <span className={s.hint}>האשף מיועד רק ליומן ריק, ואינו משנה הגדרות קיימות. אפשר לשנות שעות, שירותים וצוות מ„ניהול היומן”.</span>
            <button type="button" className={`${s.btn} ${s.btnPri}`} onClick={() => router.push("/calendar/manage")}>לניהול היומן</button>
          </div>
        </div>
      </main>
    );
  }

  if (done) {
    const word = (p: SetupResultWire["hours"], what: string) => (p === "written" ? `${what}: נשמר` : p === "kept" ? `${what}: כבר היה מוגדר — לא שונה` : `${what}: לא הוגדר`);
    return (
      <main className={s.screen} data-page-intent="content">
        <div className={s.narrow}>
          {head}
          <div className={s.wizCard} role="status">
            <strong>היומן מוכן.</strong>
            <span>{word(done.hours, "שעות פעילות")}</span>
            <span>{word(done.services, "שירותים")}</span>
            <span>{word(done.staff, "צוות")}</span>
          </div>
          <button type="button" className={`${s.btn} ${s.btnPri} ${s.btnWide}`} style={{ marginTop: 14 }} onClick={() => router.push("/calendar")}>ליומן</button>
        </div>
      </main>
    );
  }

  const built = buildSetup(week, services, team, staff);
  const finish = async () => {
    if (built.problems.length) { setError(built.problems[0]); return; }
    setBusy(true);
    setError(null);
    try {
      setDone(await applySetup(built.body));
    } catch (e) {
      setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK"));
    } finally {
      setBusy(false);
    }
  };
  const next = () => {
    const stepProblems = step === 0 ? built.problems.filter((p) => p.startsWith("יום ")) : step === 1 ? built.problems.filter((p) => !p.startsWith("יום ") && !p.startsWith("שם עובד")) : [];
    if (stepProblems.length) { setError(stepProblems[0]); return; }
    setError(null);
    if (step < 2) setStep(step + 1);
    else void finish();
  };
  const setDay = (d: number, ranges: Win[]) => setWeek(week.map((x, i) => (i === d ? ranges : x)));
  const setService = (i: number, patch: Partial<ServiceDraft>) => setServices(services.map((x, k) => (k === i ? { ...x, ...patch } : x)));

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        {head}
        <div className={s.wizSteps} aria-hidden="true">{[0, 1, 2].map((i) => <i key={i} data-on={i <= step} />)}</div>
        <p className={s.hint} aria-live="polite">שלב {(step + 1).toLocaleString("he-IL")} מתוך 3 · {STEP_TITLE[step]}</p>

        {step === 0 ? (
          <div className={s.wizCard}>
            <span className={s.label}>מתי העסק פתוח? אפשר לשנות כל יום.</span>
            {week.map((ranges, d) => (
              <div key={d} className={s.dayLine}>
                <span className={s.dayName}>
                  <Switch label={`${DAY_NAMES[d]} פתוח`} checked={ranges.length > 0} onChange={(open) => setDay(d, open ? [{ startMinute: 540, endMinute: 1140 }] : [])} />
                  {/* The short day letter fits a phone row; the switch and the selects carry the full name. */}
                  <span aria-hidden="true">{WEEKDAY_LETTER[d]}</span>
                </span>
                <div className={s.ranges}>
                  {ranges.length === 0 ? <span className={s.closedWord}>סגור</span> : null}
                  {ranges.map((r, i) => (
                    <div key={i} className={s.range}>
                      <TimeSelect kind="start" value={r.startMinute} label={`יום ${DAY_NAMES[d]}, משעה`} onChange={(m) => setDay(d, ranges.map((x, k) => (k === i ? { ...x, startMinute: m } : x)))} />
                      <span aria-hidden="true">–</span>
                      <TimeSelect kind="end" value={r.endMinute} label={`יום ${DAY_NAMES[d]}, עד שעה`} onChange={(m) => setDay(d, ranges.map((x, k) => (k === i ? { ...x, endMinute: m } : x)))} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {step === 1 ? (
          <>
            <div className={s.wizCard}>
              <span className={s.label}>איזה סוג עסק? נציע שירותים מוכנים לעריכה</span>
              <div className={s.chips} role="radiogroup" aria-label="סוג העסק">
                {BUSINESS_TYPES.map(([t, label]) => (
                  <button key={t} type="button" role="radio" aria-checked={type === t} className={s.chip} onClick={() => { setType(t); setServices(draftsOf(t)); }}>{label}</button>
                ))}
              </div>
            </div>
            <div className={s.wizCard}>
              {services.map((x, i) => (
                <div key={i} className={s.wizRow}>
                  <input type="checkbox" checked={x.on} aria-label={`להוסיף את ${x.name || "השירות"}`} onChange={(e) => setService(i, { on: e.target.checked })} />
                  <div className={s.wizRowMain}>
                    <input className={s.input} value={x.name} aria-label="שם השירות" maxLength={170} onChange={(e) => setService(i, { name: e.target.value, on: true })} placeholder="שם השירות" />
                    <div className={s.wizRowMeta}>
                      <input className={s.input} style={{ maxWidth: 84 }} type="number" inputMode="numeric" min={LIMITS.minDuration} max={LIMITS.maxDuration} step={5} aria-label="משך בדקות" value={x.duration} onChange={(e) => setService(i, { duration: e.target.value })} />
                      <span>דק׳</span>
                      <input className={s.input} style={{ maxWidth: 104 }} type="number" inputMode="decimal" min={0} aria-label="מחיר (לא חובה)" placeholder="מחיר ₪" value={x.price} onChange={(e) => setService(i, { price: e.target.value })} />
                    </div>
                  </div>
                  <button type="button" className={s.iconBtn} aria-label={`הסרת ${x.name || "השירות"}`} onClick={() => setServices(services.filter((_, k) => k !== i))}><IconX size={18} /></button>
                </div>
              ))}
              <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} style={{ alignSelf: "flex-start" }} disabled={services.length >= 20}
                onClick={() => setServices([...services, { on: true, name: "", duration: "30", price: "" }])}>
                <IconPlus size={16} /> שירות נוסף
              </button>
              <span className={s.hint}>מחיר — רק אם תרצה; בלי מחיר השירות מוצג ללא מחיר.</span>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <div className={s.wizCard}>
            <Seg label="צוות" value={team} options={[["alone", "אני לבד"], ["staff", "יש לי עובדים"]]} onChange={setTeam} />
            {team === "staff" ? (
              <>
                {staff.map((name, i) => (
                  <div key={i} className={s.range}>
                    <input className={s.input} style={{ flex: 1 }} value={name} maxLength={100} aria-label={`שם עובד ${i + 1}`} placeholder="שם העובד" onChange={(e) => setStaff(staff.map((x, k) => (k === i ? e.target.value : x)))} />
                    {staff.length > 1 ? <button type="button" className={s.iconBtn} aria-label={`הסרת עובד ${i + 1}`} onClick={() => setStaff(staff.filter((_, k) => k !== i))}><IconX size={18} /></button> : null}
                  </div>
                ))}
                <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} style={{ alignSelf: "flex-start" }} disabled={staff.length >= 20} onClick={() => setStaff([...staff, ""])}>
                  <IconPlus size={16} /> עובד נוסף
                </button>
                <span className={s.hint}>לעובדים אין כניסה לדוביז — רק שם ביומן. אפשר להוסיף גם אחר כך.</span>
              </>
            ) : <span className={s.hint}>אפשר להוסיף עובדים בכל זמן מ„ניהול היומן”.</span>}
          </div>
        ) : null}

        {error ? <p className={s.fieldErr} role="alert">{error}</p> : null}
        <button type="button" className={`${s.btn} ${s.btnPri} ${s.btnWide}`} style={{ marginTop: 14 }} disabled={busy} onClick={next}>
          {busy ? "שומר…" : step === 0 ? "המשך — שירותים" : step === 1 ? "המשך — צוות" : "סיום"}
        </button>
      </div>
    </main>
  );
}
