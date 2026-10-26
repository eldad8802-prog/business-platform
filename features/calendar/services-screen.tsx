"use client";

/**
 * "שירותים" (/calendar/services) — the catalog's services as the calendar uses them (Appointments milestone B):
 * add a service, edit its name and length (the catalog's own POST and PATCH /api/business/services — no second
 * service list), the gap before and after it, the step free times are offered in, how soon and how far ahead it may
 * be booked, and who performs it — one form, one save. A price is set when a service is added and is not edited here.
 * Whether a service is open to external booking and how requests are approved belong to milestone D and are not shown.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";
import t from "@/features/tasks/tasks.module.css";

import {
  CalendarApiError,
  createService,
  forgetIntent,
  getPolicy,
  listServices,
  listStaff,
  savePolicy,
  setStaffServices,
  updateService,
  type PolicyWire,
  type ServiceWire,
} from "./calendar-client";
import { durationLabel, errorText, LIMITS, textProblem, type StaffWire } from "./calendar-model";
import s from "./calendar.module.css";

export function ServicesScreen() {
  const on = useFeatureState("appointments");
  const [services, setServices] = useState<ServiceWire[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [stamp, setStamp] = useState(0);

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    listServices().then((v) => { if (!cancelled) setServices(v.filter((x) => x.active)); }).catch(() => { if (!cancelled) setServices([]); });
    return () => { cancelled = true; };
  }, [on, stamp]);

  const flash = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((x) => (x === text ? null : x)), 5000);
  };

  if (on === false) {
    return (
      <main className={s.screen}>
        <header className={s.top}><h1 className={s.title}>שירותים</h1></header>
        <section className={s.empty}><h2>היומן עדיין לא פעיל לעסק שלך</h2></section>
      </main>
    );
  }

  const current = services?.find((x) => x.id === (selected ?? services[0]?.id)) ?? null;

  return (
    <main className={s.screen} data-page-intent="content">
      <header className={s.top}>
        <h1 className={s.title}>שירותים ביומן</h1>
        <span className={s.grow} />
        <button type="button" className={`${t.btn} ${t.pri}`} onClick={() => setAdding(true)}>+ שירות חדש</button>
        <Link href="/calendar" prefetch={false} className={`${t.btn} ${t.ghost}`}>חזרה ליומן</Link>
      </header>
      <p className={s.note}>אלה השירותים של העסק — אותו קטלוג שמשמש את כל דוביז. כאן מוסיפים שירות, משנים שם ומשך, וקובעים איך הוא נכנס ליומן: מרווחים, באילו קפיצות מוצעות שעות ומי מבצע.</p>
      {adding ? (
        <NewService
          onCancel={() => setAdding(false)}
          onCreated={(svc) => { setAdding(false); setSelected(svc.id); setStamp((x) => x + 1); flash("השירות נוסף"); }}
        />
      ) : null}

      {services === null ? <p className={t.hint}>טוען…</p> : null}
      {services && !services.length && !adding ? (
        <section className={s.empty}>
          <h2>אין עדיין שירותים בקטלוג</h2>
          <span>אפשר לקבוע תורים גם בלי שירות, עם משך שבוחרים בכל תור — או להוסיף שירות עכשיו.</span>
          <button type="button" className={`${t.btn} ${t.pri}`} onClick={() => setAdding(true)}>+ שירות חדש</button>
        </section>
      ) : null}

      {services?.length ? (
        <div className={s.split}>
          <nav className={s.list} aria-label="שירותים">
            {services.map((x) => (
              <button key={x.id} type="button" className={`${s.item} ${current?.id === x.id ? s.itemOn : ""}`} onClick={() => setSelected(x.id)}>
                <span style={{ flex: 1, minWidth: 0 }}>{x.name}</span>
                <small style={{ color: "var(--dz-text-muted)" }}>{x.durationMinutes ? durationLabel(x.durationMinutes) : "ללא משך"}</small>
              </button>
            ))}
          </nav>
          {current ? (
            <ServiceEditor key={current.id} service={current} onSaved={(m) => { setStamp((x) => x + 1); flash(m); }} />
          ) : null}
        </div>
      ) : null}
      {toast ? <div className={t.toast} role="status"><span>{toast}</span></div> : null}
    </main>
  );
}

/** A new service in the business's catalog: a name, a length, and a fixed price only if the owner gives one. */
function NewService({ onCancel, onCreated }: { onCancel: () => void; onCreated: (svc: ServiceWire) => void }) {
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("30");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const n = name.trim();
    const minutes = duration.trim() ? Number(duration) : null;
    const amount = price.trim() ? Number(price) : null;
    const problem = !n ? "צריך שם לשירות." : textProblem("השם", n, 120)
      ?? durationProblem(minutes)
      ?? (amount !== null && !(Number.isFinite(amount) && amount >= 0) ? "המחיר צריך להיות מספר, אפס או יותר." : null);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      onCreated(await createService({ name: n, durationMinutes: minutes, priceAmount: amount }));
    } catch (e) {
      setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={s.panel} aria-labelledby="new-service-title">
      <h2 id="new-service-title">שירות חדש</h2>
      <div className={s.numRow}>
        <div className={t.field}>
          <label htmlFor="svc-new-name">שם השירות</label>
          <input id="svc-new-name" className={t.input} value={name} maxLength={140} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className={t.field}>
          <label htmlFor="svc-new-duration">משך (דקות)</label>
          <input id="svc-new-duration" type="number" inputMode="numeric" min={LIMITS.minDuration} max={LIMITS.maxDuration} step={5} className={t.input} value={duration} onChange={(e) => setDuration(e.target.value)} />
        </div>
        <div className={t.field}>
          <label htmlFor="svc-new-price">מחיר בש״ח (לא חובה)</label>
          <input id="svc-new-price" type="number" inputMode="decimal" min={0} step="any" className={t.input} value={price} onChange={(e) => setPrice(e.target.value)} />
          <span className={t.hint}>בלי מחיר — השירות מופיע בלי מחיר פומבי.</span>
        </div>
      </div>
      {error ? <p className={t.error} role="alert">{error}</p> : null}
      <div className={t.actions}>
        <button type="button" className={`${t.btn} ${t.pri}`} disabled={busy} onClick={() => void save()}>{busy ? "שומר…" : "הוספת השירות"}</button>
        <button type="button" className={t.btn} disabled={busy} onClick={onCancel}>ביטול</button>
      </div>
    </section>
  );
}

/** The API's bound on a length, in Hebrew; null when the length is fine or not given. */
function durationProblem(minutes: number | null): string | null {
  if (minutes === null) return null;
  return Number.isInteger(minutes) && minutes >= LIMITS.minDuration && minutes <= LIMITS.maxDuration
    ? null
    : `המשך צריך להיות בין ${LIMITS.minDuration} ל־${LIMITS.maxDuration.toLocaleString("he-IL")} דקות.`;
}

type PolicyKey = "bufferBeforeMinutes" | "bufferAfterMinutes" | "slotStepMinutes" | "minLeadMinutes" | "maxAdvanceDays";
const FIELDS: Array<{ key: PolicyKey; label: string; hint: string; lo: number; hi: number; unit: string }> = [
  { key: "bufferBeforeMinutes", label: "מרווח לפני", hint: "זמן הכנה שנשמר פנוי לפני התור", lo: 0, hi: 240, unit: "דק׳" },
  { key: "bufferAfterMinutes", label: "מרווח אחרי", hint: "זמן ניקיון או התארגנות אחרי התור", lo: 0, hi: 240, unit: "דק׳" },
  { key: "slotStepMinutes", label: "קפיצות בין שעות מוצעות", hint: "למשל כל 15 דקות", lo: 5, hi: 240, unit: "דק׳" },
  { key: "minLeadMinutes", label: "התראה מינימלית", hint: "כמה זמן מראש לכל הפחות", lo: 0, hi: 20160, unit: "דק׳" },
  { key: "maxAdvanceDays", label: "עד כמה רחוק", hint: "כמה ימים קדימה מוצעות שעות", lo: 1, hi: 365, unit: "ימים" },
];

/** Who performs a service, as the server holds it: the active staff members assigned to it. */
function assignedTo(staff: StaffWire[], serviceId: number): Set<number> {
  return new Set(staff.filter((m) => m.active && m.services.some((a) => a.businessServiceId === serviceId)).map((m) => m.id));
}

const sameSet = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * One service, one form, one "שמירת השינויים": its name and length (the catalog), how it sits on the calendar (the
 * booking rules) and who performs it.
 *
 * The form always shows what the SERVER holds: it reads the rules and the staff itself, and reads them again after
 * every save — it never rebuilds itself from a list the screen held before the save (the bug that showed a saved
 * assignment as unchecked and let the next save remove it). Saving who performs the service reads each staff member's
 * current list right before writing it and sends the version it read, so a stale screen can never remove an
 * assignment someone else made, nor touch any other service's assignment.
 */
function ServiceEditor({ service, onSaved }: { service: ServiceWire; onSaved: (message: string) => void }) {
  const [name, setName] = useState(service.name);
  const [duration, setDuration] = useState(service.durationMinutes ? String(service.durationMinutes) : "");
  const [policy, setPolicy] = useState<PolicyWire | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [staff, setStaff] = useState<StaffWire[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getPolicy(service.id), listStaff()])
      .then(([p, st]) => {
        if (cancelled) return;
        setPolicy(p);
        setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(p[f.key])])));
        setStaff(st);
        setChosen(assignedTo(st, service.id));
      })
      .catch((e) => { if (!cancelled) setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK")); });
    return () => { cancelled = true; };
  }, [service.id, stamp]);

  const active = (staff ?? []).filter((m) => m.active);
  const minutes = duration.trim() ? Number(duration) : null;
  const serviceDirty = name.trim() !== service.name || minutes !== service.durationMinutes;
  const policyChanges: Partial<Record<PolicyKey, number>> = {};
  if (policy) for (const f of FIELDS) if (Number(draft[f.key]) !== policy[f.key]) policyChanges[f.key] = Number(draft[f.key]);
  const whoDirty = staff !== null && !sameSet(chosen, assignedTo(staff, service.id));
  const dirty = serviceDirty || Object.keys(policyChanges).length > 0 || whoDirty;

  const save = async () => {
    const n = name.trim();
    let problem = !n ? "צריך שם לשירות." : textProblem("השם", n, 120) ?? durationProblem(minutes);
    for (const f of FIELDS) {
      const v = Number(draft[f.key]);
      if (!problem && (!Number.isInteger(v) || v < f.lo || v > f.hi)) problem = `${f.label}: מספר שלם בין ${f.lo.toLocaleString("he-IL")} ל־${f.hi.toLocaleString("he-IL")}.`;
    }
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      if (serviceDirty) {
        await updateService(service.id, { ...(n !== service.name ? { name: n } : {}), ...(minutes !== service.durationMinutes ? { durationMinutes: minutes } : {}) });
      }
      if (policy && Object.keys(policyChanges).length) {
        const intent = `policy:${service.id}:${policy.version ?? 0}:${JSON.stringify(policyChanges)}`;
        try {
          await savePolicy(intent, service.id, { ...policyChanges, expectedVersion: policy.version });
        } catch (e) {
          forgetIntent(intent);
          throw e;
        }
      }
      if (whoDirty) {
        // Read-modify-write on the CURRENT lists: only this service's entry changes, every other assignment (and its
        // own length) is carried over exactly as the server holds it.
        const fresh = await listStaff();
        for (const member of fresh.filter((m) => m.active)) {
          const has = member.services.some((a) => a.businessServiceId === service.id);
          const want = chosen.has(member.id);
          if (has === want) continue;
          const list = want
            ? [...member.services, { businessServiceId: service.id, durationOverrideMinutes: null }]
            : member.services.filter((a) => a.businessServiceId !== service.id);
          const intent = `staff:services:${member.id}:${member.version}:${JSON.stringify(list)}`;
          try {
            await setStaffServices(intent, member.id, list, member.version);
          } catch (e) {
            forgetIntent(intent);
            throw e;
          }
        }
      }
      setStamp((x) => x + 1); // read back what the server now holds
      onSaved("השינויים נשמרו");
    } catch (e) {
      const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
      setError(err.code === "VERSION_CONFLICT"
        ? "הנתונים השתנו בינתיים (אולי במסך אחר). טענתי את המצב העדכני — אפשר לבדוק ולשמור שוב."
        : errorText(err.code, err.status));
      setStamp((x) => x + 1);
    } finally {
      setBusy(false);
    }
  };

  const loading = policy === null || staff === null;

  return (
    <section className={s.panel} aria-labelledby="service-editor-title">
      <h2 id="service-editor-title">{service.name}</h2>

      <h3 className={s.subhead}>פרטי השירות</h3>
      <div className={s.numRow}>
        <div className={t.field}>
          <label htmlFor="svc-name">שם השירות</label>
          <input id="svc-name" className={t.input} value={name} maxLength={140} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className={t.field}>
          <label htmlFor="svc-duration">משך (דקות)</label>
          <input id="svc-duration" type="number" inputMode="numeric" min={LIMITS.minDuration} max={LIMITS.maxDuration} step={5} className={t.input} value={duration} onChange={(e) => setDuration(e.target.value)} />
          <span className={t.hint}>זה המשך שהיומן מציע בתור חדש. משך אישי לעובד נקבע ב„עובדים וזמינות”.</span>
        </div>
      </div>

      <h3 className={s.subhead}>איך השירות נכנס ליומן</h3>
      {loading ? <p className={t.hint} aria-busy="true">טוען…</p> : (
        <div className={s.numRow}>
          {FIELDS.map((f) => (
            <div key={f.key} className={t.field}>
              <label htmlFor={`pol-${f.key}`}>{f.label} ({f.unit})</label>
              <input id={`pol-${f.key}`} type="number" inputMode="numeric" min={f.lo} max={f.hi} className={t.input} value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
              <span className={t.hint}>{f.hint}</span>
            </div>
          ))}
        </div>
      )}

      <h3 className={s.subhead}>מי מבצע את השירות</h3>
      {loading ? null : active.length ? (
        <>
          <p className={s.note}>אם לא מסמנים אף עובד, השירות פתוח לכולם.</p>
          <div className={t.chips} role="group" aria-label="מי מבצע את השירות">
            {active.map((x) => {
              const on = chosen.has(x.id);
              return (
                <button key={x.id} type="button" aria-pressed={on} className={`${t.chip} ${on ? t.chipOn : ""}`} onClick={() => {
                  const next = new Set(chosen);
                  if (on) next.delete(x.id); else next.add(x.id);
                  setChosen(next);
                }}>
                  <span className={s.swatch} style={{ ["--lane" as string]: x.color ?? "var(--dz-brand)", display: "inline-block", width: 10, height: 10, marginInlineEnd: 6, verticalAlign: "middle" }} />
                  {x.displayName}
                  {on ? <span aria-hidden="true"> ✓</span> : null}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <p className={s.note}>אין עדיין עובדים. אפשר להוסיף ב<Link href="/calendar/staff" prefetch={false}>עובדים וזמינות</Link>.</p>
      )}

      {error ? <p className={t.error} role="alert">{error}</p> : null}
      <div className={t.actions}>
        <button type="button" className={`${t.btn} ${t.pri}`} disabled={busy || loading || !dirty} onClick={() => void save()}>
          {busy ? "שומר…" : "שמירת השינויים"}
        </button>
        {!dirty && !loading ? <span className={t.hint}>אין שינויים שלא נשמרו.</span> : null}
      </div>
    </section>
  );
}
