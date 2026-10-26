"use client";

/**
 * "עובדים וזמינות" (/calendar/staff) — the calendar's people and hours (Appointments milestone B).
 *
 *   שעות העסק     the business's weekly hours and its exceptions (a closed day, part of a day, special hours);
 *   each staff member   name and colour on the calendar, active or not, the services they perform (and in how long,
 *                 when it differs), their own weekly hours — or the business's when they have none — and exceptions.
 *
 * Staff have NO login: a name and a colour (access for staff is a later, separate decision in Dubiz settings).
 * Nothing is deleted: a staff member is deactivated; the weekly hours are one PUT that states the whole week.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";
import { uuidV7 } from "@/lib/tasks/tasks-client";
import { addCalendarDays } from "@/lib/utils/jerusalem-day";
import t from "@/features/tasks/tasks.module.css";

import {
  addException,
  CalendarApiError,
  createStaff,
  forgetIntent,
  getAvailability,
  listServices,
  listStaff,
  removeException,
  replaceWeeklyRules,
  setStaffServices,
  updateStaff,
  type ExceptionWire,
  type RuleWire,
  type ServiceWire,
} from "./calendar-client";
import { clock, dayTitle, errorText, LIMITS, parseClock, textProblem, todayKey, windowsByWeekday, windowsProblem, type StaffWire } from "./calendar-model";
import s from "./calendar.module.css";

const DAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const PALETTE = ["#246966", "#2f6fb5", "#8a4fbf", "#c2410c", "#b7791f", "#2f855a", "#c53060", "#4a5568"];

type Scope = { kind: "business" } | { kind: "staff"; id: number } | { kind: "new" };

export function StaffScreen() {
  const on = useFeatureState("appointments");
  const [staff, setStaff] = useState<StaffWire[] | null>(null);
  const [services, setServices] = useState<ServiceWire[]>([]);
  const [scope, setScope] = useState<Scope>({ kind: "business" });
  const [toast, setToast] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setStaff(await listStaff());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK"));
    }
  }, []);

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    listStaff().then((v) => { if (!cancelled) setStaff(v); }).catch((e) => { if (!cancelled) setLoadError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK")); });
    listServices().then((v) => { if (!cancelled) setServices(v.filter((x) => x.active)); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [on]);

  const flash = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((x) => (x === text ? null : x)), 5000);
  };

  if (on === false) return <Off />;

  const selected = scope.kind === "staff" ? staff?.find((x) => x.id === scope.id) ?? null : null;

  return (
    <main className={s.screen} data-page-intent="content">
      <header className={s.top}>
        <h1 className={s.title}>עובדים וזמינות</h1>
        <span className={s.grow} />
        <Link href="/calendar" prefetch={false} className={`${t.btn} ${t.ghost}`}>חזרה ליומן</Link>
      </header>
      <p className={s.note}>שעות הפעילות קובעות אילו שעות היומן מציע כפנויות. אפשר תמיד לקבוע גם מחוץ להן. לעובדים אין כניסה לדוביז — רק שם וצבע ביומן.</p>
      {loadError ? <div className={`${t.banner} ${t.bannerBad}`} role="alert">{loadError}</div> : null}

      <div className={s.split}>
        <nav className={s.list} aria-label="עובדים">
          <button type="button" className={`${s.item} ${scope.kind === "business" ? s.itemOn : ""}`} onClick={() => setScope({ kind: "business" })}>
            <span className={s.swatch} style={{ ["--lane" as string]: "var(--dz-text-muted)" }} />
            <span style={{ flex: 1 }}>שעות העסק</span>
          </button>
          {(staff ?? []).map((x) => (
            <button key={x.id} type="button" className={`${s.item} ${scope.kind === "staff" && scope.id === x.id ? s.itemOn : ""}`} onClick={() => setScope({ kind: "staff", id: x.id })}>
              <span className={s.swatch} style={{ ["--lane" as string]: x.color ?? "var(--dz-brand)" }} />
              <span style={{ flex: 1, minWidth: 0 }}>{x.displayName}</span>
              {!x.active ? <span className={`${s.status} ${s.st_COMPLETED}`}>לא פעיל</span> : null}
            </button>
          ))}
          <button type="button" className={`${s.item} ${scope.kind === "new" ? s.itemOn : ""}`} onClick={() => setScope({ kind: "new" })} style={{ color: "var(--dz-brand)" }}>
            + עובד חדש
          </button>
        </nav>

        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          {staff === null && !loadError ? <p className={t.hint}>טוען…</p> : null}
          {scope.kind === "new" ? (
            <NewStaff onCreated={async (x) => { await reload(); setScope({ kind: "staff", id: x.id }); flash("העובד נוסף"); }} />
          ) : null}
          {scope.kind === "staff" && selected ? (
            <>
              <StaffCard key={`card:${selected.id}:${selected.version}`} member={selected} onSaved={async (m) => { await reload(); flash(m); }} />
              <ServicesCard key={`svc:${selected.id}:${selected.version}`} member={selected} services={services} onSaved={async () => { await reload(); flash("השירותים נשמרו"); }} onStale={async () => { await reload(); flash("השירותים של העובד השתנו בינתיים (אולי במסך אחר). מוצג המצב העדכני — אפשר לבדוק ולשמור שוב."); }} />
            </>
          ) : null}
          {scope.kind !== "new" && (scope.kind === "business" || selected) ? (
            <>
              <HoursCard key={`hours:${scope.kind === "staff" ? scope.id : "biz"}`} staffMemberId={scope.kind === "staff" ? scope.id : null} onSaved={() => flash("השעות נשמרו")} />
              <ExceptionsCard key={`ex:${scope.kind === "staff" ? scope.id : "biz"}`} staffMemberId={scope.kind === "staff" ? scope.id : null} onChanged={(m) => flash(m)} />
            </>
          ) : null}
        </div>
      </div>
      {toast ? <div className={t.toast} role="status"><span>{toast}</span></div> : null}
    </main>
  );
}

function Off() {
  return (
    <main className={s.screen}>
      <header className={s.top}><h1 className={s.title}>עובדים וזמינות</h1></header>
      <section className={s.empty}><h2>היומן עדיין לא פעיל לעסק שלך</h2></section>
    </main>
  );
}

function ColorPick({ value, onChange }: { value: string | null; onChange: (c: string) => void }) {
  return (
    <div className={s.swatches} role="radiogroup" aria-label="צבע ביומן">
      {PALETTE.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={`צבע ${c}`} className={`${s.swatchBtn} ${value === c ? s.swatchOn : ""}`} style={{ ["--lane" as string]: c }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

function NewStaff({ onCreated }: { onCreated: (m: StaffWire) => Promise<void> }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(PALETTE[1]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const intent = useRef(`staff:create:${uuidV7()}`);
  return (
    <section className={s.panel} aria-labelledby="new-staff-title">
      <h2 id="new-staff-title">עובד חדש</h2>
      <div className={t.field}>
        <label htmlFor="staff-name">שם</label>
        <input id="staff-name" className={t.input} value={name} maxLength={LIMITS.staffName + 20} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className={t.field}><span className={t.hint}>צבע ביומן</span><ColorPick value={color} onChange={setColor} /></div>
      {error ? <p className={t.error} role="alert">{error}</p> : null}
      <div className={t.actions}>
        <button type="button" className={`${t.btn} ${t.pri}`} disabled={busy} onClick={async () => {
          const problem = !name.trim() ? "צריך שם לעובד." : textProblem("השם", name.trim(), LIMITS.staffName);
          if (problem) { setError(problem); return; }
          setBusy(true);
          try {
            const out = await createStaff(intent.current, { displayName: name.trim(), color });
            intent.current = `staff:create:${uuidV7()}`;
            await onCreated(out.staffMember);
          } catch (e) {
            forgetIntent(intent.current);
            intent.current = `staff:create:${uuidV7()}`;
            setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK"));
          } finally {
            setBusy(false);
          }
        }}>{busy ? "שומר…" : "הוסף עובד"}</button>
      </div>
    </section>
  );
}

function StaffCard({ member, onSaved }: { member: StaffWire; onSaved: (message: string) => Promise<void> }) {
  const [name, setName] = useState(member.displayName);
  const [color, setColor] = useState<string | null>(member.color);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (patch: { displayName?: string; color?: string | null; active?: boolean }, message: string) => {
    const intent = `staff:update:${member.id}:${member.version}:${JSON.stringify(patch)}`;
    setBusy(true);
    setError(null);
    try {
      await updateStaff(intent, member.id, { ...patch, expectedVersion: member.version });
      await onSaved(message);
    } catch (e) {
      forgetIntent(intent);
      setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK"));
    } finally {
      setBusy(false);
    }
  };
  const dirty = name.trim() !== member.displayName || color !== member.color;
  return (
    <section className={s.panel} aria-labelledby="staff-card-title">
      <h2 id="staff-card-title">{member.displayName}</h2>
      <div className={t.field}>
        <label htmlFor="staff-edit-name">שם</label>
        <input id="staff-edit-name" className={t.input} value={name} maxLength={LIMITS.staffName + 20} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className={t.field}><span className={t.hint}>צבע ביומן</span><ColorPick value={color} onChange={setColor} /></div>
      {error ? <p className={t.error} role="alert">{error}</p> : null}
      <div className={t.actions}>
        <button type="button" className={`${t.btn} ${t.pri}`} disabled={busy || !dirty} onClick={() => {
          const problem = !name.trim() ? "צריך שם לעובד." : textProblem("השם", name.trim(), LIMITS.staffName);
          if (problem) { setError(problem); return; }
          void save({ displayName: name.trim(), color }, "הפרטים נשמרו");
        }}>שמירה</button>
        <button type="button" className={`${t.btn} ${t.ghost}`} disabled={busy} onClick={() => void save({ active: !member.active }, member.active ? "העובד הוגדר כלא פעיל" : "העובד פעיל שוב")}>
          {member.active ? "הגדר כלא פעיל" : "החזר לפעילות"}
        </button>
      </div>
      {!member.active ? <p className={s.note}>עובד לא פעיל לא מוצע ביומן לתורים חדשים. התורים הקיימים שלו נשארים.</p> : null}
    </section>
  );
}

/**
 * The services one staff member performs. The card is keyed by the member's version, so after any save — here or on
 * "שירותים ושעות" — it starts again from what the server holds; the save sends the version it was built from, and a
 * list that changed meanwhile is refused (VERSION_CONFLICT) and reloaded instead of being overwritten.
 */
function ServicesCard({ member, services, onSaved, onStale }: { member: StaffWire; services: ServiceWire[]; onSaved: () => Promise<void>; onStale: () => Promise<void> }) {
  const initial = new Map(member.services.map((x) => [x.businessServiceId, x.durationOverrideMinutes]));
  const [chosen, setChosen] = useState<Map<number, number | null>>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = chosen.size !== initial.size || [...chosen].some(([id, d]) => !initial.has(id) || initial.get(id) !== d);
  if (!services.length) {
    return (
      <section className={s.panel}>
        <h2>שירותים</h2>
        <p className={s.note}>אין עדיין שירותים בקטלוג של העסק.</p>
      </section>
    );
  }
  return (
    <section className={s.panel} aria-labelledby="staff-services-title">
      <h2 id="staff-services-title">שירותים שהעובד מבצע</h2>
      <p className={s.note}>שירות שלא שויך לאף עובד פתוח לכולם. משך אישי — רק אם הוא שונה ממשך השירות.</p>
      <div>
        {services.map((svc) => {
          const on = chosen.has(svc.id);
          const override = chosen.get(svc.id) ?? null;
          return (
            <div key={svc.id} className={s.svcRow}>
              <input type="checkbox" id={`svc-${svc.id}`} checked={on} onChange={(e) => {
                const next = new Map(chosen);
                if (e.target.checked) next.set(svc.id, null);
                else next.delete(svc.id);
                setChosen(next);
              }} />
              <label htmlFor={`svc-${svc.id}`}>{svc.name}{svc.durationMinutes ? <small style={{ color: "var(--dz-text-muted)" }}> · {svc.durationMinutes} דק׳</small> : null}</label>
              <input
                type="number" inputMode="numeric" min={5} max={1440} step={5} className={t.input} disabled={!on} aria-label={`משך אישי ל${svc.name} (דקות)`}
                placeholder="משך אישי" value={override ?? ""}
                onChange={(e) => setChosen(new Map(chosen).set(svc.id, e.target.value ? Number(e.target.value) : null))}
              />
            </div>
          );
        })}
      </div>
      {error ? <p className={t.error} role="alert">{error}</p> : null}
      <div className={t.actions}>
        <button type="button" className={`${t.btn} ${t.pri}`} disabled={busy || !dirty} onClick={async () => {
          const list = [...chosen.entries()].map(([businessServiceId, d]) => ({ businessServiceId, durationOverrideMinutes: d }));
          if (list.some((x) => x.durationOverrideMinutes !== null && !(x.durationOverrideMinutes >= 5 && x.durationOverrideMinutes <= 1440))) {
            setError("משך אישי צריך להיות בין 5 ל־1,440 דקות.");
            return;
          }
          const intent = `staff:services:${member.id}:${member.version}:${JSON.stringify(list)}`;
          setBusy(true);
          setError(null);
          try {
            await setStaffServices(intent, member.id, list, member.version);
            await onSaved();
          } catch (e) {
            forgetIntent(intent);
            if (e instanceof CalendarApiError && e.code === "VERSION_CONFLICT") {
              await onStale();
            } else {
              setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK"));
            }
          } finally {
            setBusy(false);
          }
        }}>{busy ? "שומר…" : "שמירת השירותים"}</button>
      </div>
    </section>
  );
}

type Range = { start: string; end: string };

const rangesOf = (rules: RuleWire[]): Range[][] =>
  windowsByWeekday(rules).map((d) => d.map((w) => ({ start: clock(w.startMinute), end: w.endMinute === 1440 ? "24:00" : clock(w.endMinute) })));

/**
 * Weekly hours of the business or of one staff member. A staff member with no hours of their own works by the
 * business's hours (the server's rule): the card then SHOWS those inherited hours, read-only, instead of an empty
 * week that reads as "closed every day" — and setting separate hours starts from a copy of them.
 */
function HoursCard({ staffMemberId, onSaved }: { staffMemberId: number | null; onSaved: () => void }) {
  const [week, setWeek] = useState<Range[][] | null>(null);
  const [savedEmpty, setSavedEmpty] = useState(false);
  const [inherited, setInherited] = useState<Range[][] | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAvailability(staffMemberId)
      .then(async (r) => {
        const business = staffMemberId !== null && r.rules.length === 0 ? (await getAvailability(null)).rules : null;
        if (cancelled) return;
        setWeek(rangesOf(r.rules));
        setSavedEmpty(r.rules.length === 0);
        setInherited(business ? rangesOf(business) : null);
        setEditing(false);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK")); });
    return () => { cancelled = true; };
  }, [staffMemberId]);

  if (!week) return <section className={s.panel}><h2>שעות פעילות</h2><p className={t.hint}>{error ?? "טוען…"}</p></section>;

  if (staffMemberId !== null && savedEmpty && inherited && !editing) {
    return (
      <section className={s.panel} aria-labelledby={`hours-title-${staffMemberId}`}>
        <h2 id={`hours-title-${staffMemberId}`}>שעות העבודה של העובד</h2>
        <p className={s.note}>לעובד אין שעות משלו, ולכן הוא עובד לפי שעות העסק:</p>
        <div className={s.week}>
          {inherited.map((ranges, d) => (
            <div key={d} className={s.dayRow}>
              <span className={s.dayName}>{DAY_NAMES[d]}</span>
              <span className={t.hint} style={{ paddingTop: 8 }}>
                {ranges.length ? ranges.map((r, i) => <bdi key={i} dir="ltr" style={{ marginInlineEnd: 10 }}>{r.start}–{r.end}</bdi>) : "סגור"}
              </span>
            </div>
          ))}
        </div>
        <div className={t.actions}>
          <button type="button" className={`${t.btn} ${t.soft}`} onClick={() => { setWeek(inherited.map((d) => d.map((r) => ({ ...r })))); setEditing(true); }}>
            קביעת שעות נפרדות לעובד
          </button>
        </div>
      </section>
    );
  }

  const setDay = (i: number, ranges: Range[]) => setWeek(week.map((d, j) => (j === i ? ranges : d)));
  const toMinutes = (v: string) => (v === "24:00" ? 1440 : parseClock(v));

  const save = async () => {
    const rules: RuleWire[] = [];
    for (let d = 0; d < 7; d++) {
      const windows = week[d].map((r) => ({ startMinute: toMinutes(r.start), endMinute: toMinutes(r.end) }));
      if (windows.some((w) => w.startMinute === null || w.endMinute === null)) { setError(`יום ${DAY_NAMES[d]}: צריך שעה תקינה בכל טווח.`); return; }
      const problem = windowsProblem(windows as Array<{ startMinute: number; endMinute: number }>);
      if (problem) { setError(`יום ${DAY_NAMES[d]}: ${problem}`); return; }
      for (const w of windows) rules.push({ weekday: d, startMinute: w.startMinute!, endMinute: w.endMinute! });
    }
    const intent = `hours:${staffMemberId ?? "biz"}:${JSON.stringify(rules)}`;
    setBusy(true);
    setError(null);
    try {
      await replaceWeeklyRules(intent, staffMemberId, rules);
      setSavedEmpty(rules.length === 0);
      if (staffMemberId !== null && rules.length === 0) {
        const business = await getAvailability(null).catch(() => null);
        if (business) setInherited(rangesOf(business.rules));
      }
      setEditing(false);
      onSaved();
    } catch (e) {
      forgetIntent(intent);
      setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={s.panel} aria-labelledby={`hours-title-${staffMemberId ?? "biz"}`}>
      <h2 id={`hours-title-${staffMemberId ?? "biz"}`}>{staffMemberId === null ? "שעות הפעילות של העסק" : "שעות העבודה של העובד"}</h2>
      {staffMemberId !== null && savedEmpty ? <p className={s.note}>השעות שיישמרו כאן יחליפו עבור העובד את שעות העסק. כל עוד לא שומרים — הוא ממשיך לעבוד לפי שעות העסק.</p> : null}
      {staffMemberId !== null && !savedEmpty ? <p className={s.note}>הסרת כל הטווחים ושמירה מחזירה את העובד לשעות העסק.</p> : null}
      <div className={s.week}>
        {week.map((ranges, d) => (
          <div key={d} className={s.dayRow}>
            <span className={s.dayName}>{DAY_NAMES[d]}</span>
            <div className={s.ranges}>
              {ranges.length === 0 ? <span className={t.hint} style={{ paddingTop: 8 }}>סגור</span> : null}
              {ranges.map((r, i) => (
                <div key={i} className={s.range}>
                  <input type="time" step={300} className={`${t.input} ${s.time}`} aria-label={`יום ${DAY_NAMES[d]}, טווח ${i + 1}, משעה`} value={r.start} onChange={(e) => setDay(d, ranges.map((x, k) => (k === i ? { ...x, start: e.target.value } : x)))} />
                  <span aria-hidden="true">–</span>
                  <input type="time" step={300} className={`${t.input} ${s.time}`} aria-label={`יום ${DAY_NAMES[d]}, טווח ${i + 1}, עד שעה`} value={r.end === "24:00" ? "23:59" : r.end} onChange={(e) => setDay(d, ranges.map((x, k) => (k === i ? { ...x, end: e.target.value } : x)))} />
                  <button type="button" className={`${t.btn} ${t.ghost}`} aria-label={`הסרת הטווח ${i + 1} ביום ${DAY_NAMES[d]}`} onClick={() => setDay(d, ranges.filter((_, k) => k !== i))}>הסרה</button>
                </div>
              ))}
              <div className={s.range}>
                <button type="button" className={`${t.btn} ${t.ghost}`} onClick={() => setDay(d, [...ranges, ranges.length ? { start: ranges[ranges.length - 1].end, end: "18:00" } : { start: "09:00", end: "17:00" }])}>+ טווח שעות</button>
                {d === 0 && ranges.length ? (
                  <button type="button" className={`${t.btn} ${t.ghost}`} onClick={() => setWeek(week.map((x, j) => (j >= 1 && j <= 4 ? ranges.map((r) => ({ ...r })) : x)))}>החל גם על שני–חמישי</button>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
      {error ? <p className={t.error} role="alert">{error}</p> : null}
      <div className={t.actions}>
        <button type="button" className={`${t.btn} ${t.pri}`} disabled={busy} onClick={() => void save()}>{busy ? "שומר…" : "שמירת השעות"}</button>
        {editing && savedEmpty ? <button type="button" className={`${t.btn} ${t.ghost}`} disabled={busy} onClick={() => { setError(null); setEditing(false); }}>ביטול</button> : null}
      </div>
    </section>
  );
}

function ExceptionsCard({ staffMemberId, onChanged }: { staffMemberId: number | null; onChanged: (message: string) => void }) {
  const today = todayKey(new Date());
  const [list, setList] = useState<ExceptionWire[] | null>(null);
  const [stamp, setStamp] = useState(0);
  const [day, setDay] = useState(addCalendarDays(today, 1));
  const [kind, setKind] = useState<"ALL" | "PART" | "OPEN">("ALL");
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("13:00");
  const [label, setLabel] = useState("");
  const [confirming, setConfirming] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAvailability(staffMemberId, today).then((r) => { if (!cancelled) setList(r.exceptions); }).catch(() => { if (!cancelled) setList([]); });
    return () => { cancelled = true; };
  }, [staffMemberId, today, stamp]);

  const add = async () => {
    const problem = textProblem("התיאור", label.trim(), LIMITS.exceptionLabel);
    if (problem) { setError(problem); return; }
    const window = kind === "ALL" ? null : { startMinute: parseClock(start), endMinute: end === "24:00" ? 1440 : parseClock(end) };
    if (window && (window.startMinute === null || window.endMinute === null || window.endMinute <= window.startMinute)) { setError("שעת הסיום צריכה להיות אחרי שעת ההתחלה."); return; }
    const body = {
      staffMemberId, dayKey: day, kind: kind === "OPEN" ? ("OPEN_HOURS" as const) : ("CLOSED" as const),
      startMinute: window?.startMinute ?? null, endMinute: window?.endMinute ?? null, label: label.trim() || null,
    };
    const intent = `exception:add:${JSON.stringify(body)}`;
    setBusy(true);
    setError(null);
    try {
      await addException(intent, body);
      setLabel("");
      setKind("ALL");
      setStart("09:00");
      setEnd("13:00");
      setDay(addCalendarDays(today, 1));
      setStamp((x) => x + 1);
      onChanged("החריגה נשמרה");
    } catch (e) {
      forgetIntent(intent);
      setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={s.panel} aria-labelledby={`ex-title-${staffMemberId ?? "biz"}`}>
      <h2 id={`ex-title-${staffMemberId ?? "biz"}`}>ימים מיוחדים</h2>
      <p className={s.note}>חג, חופשה, יום קצר או שעות מיוחדות — גוברים על השעות הקבועות באותו יום.</p>
      {list?.length ? (
        <div className={s.list}>
          {list.map((x) => (
            <div key={x.id} className={s.item} style={{ cursor: "default" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                {dayTitle(x.dayKey)} · {x.kind === "OPEN_HOURS" ? "שעות מיוחדות " : x.startMinute !== null ? "סגור " : "סגור כל היום"}
                {x.startMinute !== null ? <bdi dir="ltr">{clock(x.startMinute)}–{x.endMinute === 1440 ? "24:00" : clock(x.endMinute!)}</bdi> : null}
                {x.label ? <small style={{ color: "var(--dz-text-muted)" }}> · {x.label}</small> : null}
              </span>
              {confirming === x.id ? (
                <span className={t.actGroup}>
                  <button type="button" className={`${t.btn} ${t.danger}`} disabled={busy} onClick={async () => {
                    const intent = `exception:remove:${x.id}`;
                    setBusy(true);
                    try { await removeException(intent, x.id); setConfirming(null); setStamp((v) => v + 1); onChanged("החריגה הוסרה"); } catch (e) { forgetIntent(intent); setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK")); } finally { setBusy(false); }
                  }}>כן, להסיר</button>
                  <button type="button" className={`${t.btn} ${t.ghost}`} disabled={busy} onClick={() => setConfirming(null)}>ביטול</button>
                </span>
              ) : (
                <button type="button" className={`${t.btn} ${t.ghost} ${t.danger}`} aria-label={`הסרת היום המיוחד ${dayTitle(x.dayKey)}`} onClick={() => setConfirming(x.id)}>הסרה</button>
              )}
            </div>
          ))}
        </div>
      ) : list ? <p className={t.hint}>אין ימים מיוחדים קרובים.</p> : null}
      <div className={s.row2}>
        <div className={t.field}>
          <label htmlFor={`ex-day-${staffMemberId ?? "biz"}`}>תאריך</label>
          <input id={`ex-day-${staffMemberId ?? "biz"}`} type="date" className={t.input} value={day} min={today} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </div>
        <div className={t.field}>
          <label htmlFor={`ex-kind-${staffMemberId ?? "biz"}`}>מה קורה ביום הזה</label>
          <select id={`ex-kind-${staffMemberId ?? "biz"}`} className={t.input} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="ALL">סגור כל היום</option>
            <option value="PART">סגור בחלק מהיום</option>
            <option value="OPEN">שעות מיוחדות במקום הקבועות</option>
          </select>
        </div>
      </div>
      {kind !== "ALL" ? (
        <div className={s.range}>
          <input type="time" step={300} className={`${t.input} ${s.time}`} aria-label="משעה" value={start} onChange={(e) => setStart(e.target.value)} />
          <span aria-hidden="true">–</span>
          <input type="time" step={300} className={`${t.input} ${s.time}`} aria-label="עד שעה" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
      ) : null}
      <div className={t.field}>
        <label htmlFor={`ex-label-${staffMemberId ?? "biz"}`}>תיאור (לא חובה)</label>
        <input id={`ex-label-${staffMemberId ?? "biz"}`} className={t.input} value={label} maxLength={LIMITS.exceptionLabel + 20} onChange={(e) => setLabel(e.target.value)} placeholder="למשל: ערב חג" />
      </div>
      {error ? <p className={t.error} role="alert">{error}</p> : null}
      <div className={t.actions}>
        <button type="button" className={`${t.btn} ${t.soft}`} disabled={busy} onClick={() => void add()}>{busy ? "שומר…" : "הוספת יום מיוחד"}</button>
      </div>
    </section>
  );
}
