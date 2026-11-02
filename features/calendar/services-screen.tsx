"use client";

/**
 * "שירותים" — the catalog's services as the calendar uses them, design direction A.
 *   /calendar/services        the list (length, who performs) and "הוספת שירות" (name, length, a price only if given —
 *                             the catalog's own POST /api/business/services; one catalog for all of Dubiz).
 *   /calendar/services/[id]   one service, one save: its name and length (the catalog's PATCH), who performs it and in
 *                             how long (the same editor as the staff page), and the booking rules in plain words:
 *                             preparation before / tidying after, "שעות מוצעות כל", "אפשר לקבוע לפחות … מראש" (minutes,
 *                             hours or days — stored in minutes, as before), "עד … ימים קדימה".
 * The form shows what the SERVER holds and reads it again after every save. Leaving with unsaved changes asks first.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";

import { AssignmentEditor, assignmentErrorText, saveAssignment } from "./assignment-editor";
import { CalendarApiError, createService, forgetIntent, getPolicy, listServices, listStaff, savePolicy, updateService, type PolicyWire, type ServiceWire } from "./calendar-client";
import { currentPick, durationLabel, errorText, LIMITS, samePick, splitMinutes, textProblem, UNIT_LABEL, UNIT_MINUTES, type AssignPick, type LeadUnit, type StaffWire } from "./calendar-model";
import { useLeaveGuard } from "./manage-screens";
import { Chevron, Empty, FeatureOff, IconPlus, IconScissors, Loading, LoadError, ScreenHead, useBeforeUnload, useToast } from "./ui";
import s from "./calendar.module.css";

const asText = (e: unknown) => (e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK"));

/** The API's bound on a length, in Hebrew; null when the length is fine or not given. */
function durationProblem(minutes: number | null): string | null {
  if (minutes === null) return null;
  return Number.isInteger(minutes) && minutes >= LIMITS.minDuration && minutes <= LIMITS.maxDuration
    ? null
    : `המשך צריך להיות בין ${LIMITS.minDuration} ל־${LIMITS.maxDuration.toLocaleString("he-IL")} דקות.`;
}

export function ServicesScreen() {
  const on = useFeatureState("appointments");
  const router = useRouter();
  const [services, setServices] = useState<ServiceWire[] | null>(null);
  const [staff, setStaff] = useState<StaffWire[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("30");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    listServices().then((v) => { if (!cancelled) { setServices(v.filter((x) => x.active)); setLoadError(null); } }).catch((e) => { if (!cancelled) setLoadError(asText(e)); });
    listStaff().then((v) => { if (!cancelled) setStaff(v); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [on, tick]);

  if (on === false) return <FeatureOff title="שירותים" />;

  const create = async () => {
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
      const svc = await createService({ name: n, durationMinutes: minutes, priceAmount: amount });
      router.push(`/calendar/services/${svc.id}`);
    } catch (e) {
      setError(asText(e));
    } finally {
      setBusy(false);
    }
  };

  const performers = (id: number) => {
    const who = staff.filter((m) => m.active && m.services.some((a) => a.businessServiceId === id)).map((m) => m.displayName);
    return who.length ? who.join(", ") : staff.some((m) => m.active) ? "כל הצוות" : null;
  };

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title="שירותים" subtitle="מה אפשר לקבוע ביומן" fallback="/calendar/manage"
          end={!adding && services ? <button type="button" className={`${s.btn} ${s.btnSoft} ${s.btnSm}`} onClick={() => setAdding(true)}><IconPlus size={18} /> הוספת שירות</button> : null} />

        {adding ? (
          <section className={s.section} aria-labelledby="new-service-title">
            <h2 id="new-service-title">שירות חדש</h2>
            <div className={s.field}>
              <label className={s.label} htmlFor="svc-new-name">שם השירות</label>
              <input id="svc-new-name" className={s.input} value={name} maxLength={140} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <div className={s.row2}>
              <div className={s.field}>
                <label className={s.label} htmlFor="svc-new-duration">משך (דקות)</label>
                <input id="svc-new-duration" type="number" inputMode="numeric" min={LIMITS.minDuration} max={LIMITS.maxDuration} step={5} className={s.input} value={duration} onChange={(e) => setDuration(e.target.value)} />
              </div>
              <div className={s.field}>
                <label className={s.label} htmlFor="svc-new-price">מחיר בש״ח (לא חובה)</label>
                <input id="svc-new-price" type="number" inputMode="decimal" min={0} step="any" className={s.input} value={price} onChange={(e) => setPrice(e.target.value)} />
              </div>
            </div>
            <p className={s.hint}>בלי מחיר — השירות מופיע בלי מחיר פומבי. השירות נכנס לקטלוג של העסק בכל דוביז.</p>
            {error ? <p className={s.fieldErr} role="alert">{error}</p> : null}
            <div className={s.confirmRow}>
              <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={busy} onClick={() => void create()}>{busy ? "שומר…" : "הוספת השירות"}</button>
              <button type="button" className={s.btn} disabled={busy} onClick={() => { setAdding(false); setError(null); }}>סגירה</button>
            </div>
          </section>
        ) : null}

        {loadError ? <LoadError text={`לא הצלחתי לטעון את השירותים. ${loadError}`} onRetry={() => setTick((x) => x + 1)} /> : null}
        {!loadError && services === null ? <Loading label="טוען שירותים" /> : null}
        {services && !services.length && !adding ? (
          <Empty title="עוד אין שירותים" icon={<IconScissors size={32} />}>
            <span>אפשר לקבוע תורים גם בלי שירות, עם משך שבוחרים בכל תור — או להוסיף שירות עכשיו.</span>
            <button type="button" className={`${s.btn} ${s.btnPri}`} onClick={() => setAdding(true)}><IconPlus size={18} /> הוספת שירות</button>
          </Empty>
        ) : null}
        {services?.length ? (
          <ul className={s.list} style={{ marginTop: 16 }}>
            {services.map((x) => (
              <li key={x.id}>
                <Link href={`/calendar/services/${x.id}`} prefetch={false} className={s.listRow}>
                  <span className={s.lineIcon}><IconScissors /></span>
                  <span className={s.rowText}>
                    <span className={s.rowTitle} style={{ fontSize: 17 }}>{x.name}</span>
                    <span className={s.rowSub}>{[x.durationMinutes ? durationLabel(x.durationMinutes) : "ללא משך", performers(x.id)].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className={s.rowEnd}><Chevron dir="open" /></span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </main>
  );
}

type PolicyKey = "bufferBeforeMinutes" | "bufferAfterMinutes" | "slotStepMinutes" | "minLeadMinutes" | "maxAdvanceDays";
const RULES: Array<{ key: PolicyKey; label: string; hint: string; lo: number; hi: number; unit: "minutes" | "days" | "lead" }> = [
  { key: "bufferBeforeMinutes", label: "זמן הכנה לפני", hint: "נשמר פנוי לפני כל תור", lo: 0, hi: 240, unit: "minutes" },
  { key: "bufferAfterMinutes", label: "זמן סידור אחרי", hint: "נשמר פנוי אחרי כל תור", lo: 0, hi: 240, unit: "minutes" },
  { key: "slotStepMinutes", label: "שעות מוצעות כל", hint: "למשל כל 15 דקות: 09:00, 09:15…", lo: 5, hi: 240, unit: "minutes" },
  { key: "minLeadMinutes", label: "אפשר לקבוע לפחות … מראש", hint: "השעות הקרובות מזה לא מוצעות", lo: 0, hi: 20160, unit: "lead" },
  { key: "maxAdvanceDays", label: "עד כמה ימים קדימה", hint: "שעות רחוקות מזה לא מוצעות", lo: 1, hi: 365, unit: "days" },
];

export function ServiceDetailScreen({ id }: { id: number }) {
  const on = useFeatureState("appointments");
  const { flash, node: toast } = useToast();
  const guard = useLeaveGuard();
  const [service, setService] = useState<ServiceWire | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((x) => x + 1), []);

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    listServices()
      .then((v) => { if (cancelled) return; const x = v.find((y) => y.id === id && y.active) ?? null; setService(x); setMissing(!x); setLoadError(null); })
      .catch((e) => { if (!cancelled) setLoadError(asText(e)); });
    return () => { cancelled = true; };
  }, [on, id, tick]);

  if (on === false) return <FeatureOff title="שירות" />;

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title={service?.name ?? "שירות"} subtitle={service?.durationMinutes ? durationLabel(service.durationMinutes) : undefined} fallback="/calendar/services" onBeforeLeave={guard.onBeforeLeave} />
        {guard.node}
        {loadError ? <LoadError text={`לא הצלחתי לטעון את השירות. ${loadError}`} onRetry={reload} /> : null}
        {!loadError && !service && !missing ? <Loading label="טוען את השירות" /> : null}
        {missing ? <Empty title="השירות לא נמצא"><Link href="/calendar/services" prefetch={false} className={s.btn}>לרשימת השירותים</Link></Empty> : null}
        {service ? <ServiceEditor key={`${service.id}:${tick}`} service={service} onDirty={guard.setDirty} onSaved={(m) => { reload(); flash(m); }} /> : null}
      </div>
      {toast}
    </main>
  );
}

function ServiceEditor({ service, onSaved, onDirty }: { service: ServiceWire; onSaved: (message: string) => void; onDirty: (dirty: boolean) => void }) {
  const [name, setName] = useState(service.name);
  const [duration, setDuration] = useState(service.durationMinutes ? String(service.durationMinutes) : "");
  const [policy, setPolicy] = useState<PolicyWire | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [leadUnit, setLeadUnit] = useState<LeadUnit>("minutes");
  const [staff, setStaff] = useState<StaffWire[] | null>(null);
  const [pick, setPick] = useState<AssignPick>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState(0);
  const axis = { kind: "service" as const, serviceId: service.id };

  useEffect(() => {
    let cancelled = false;
    Promise.all([getPolicy(service.id), listStaff()])
      .then(([p, st]) => {
        if (cancelled) return;
        const lead = splitMinutes(p.minLeadMinutes);
        setPolicy(p);
        setLeadUnit(lead.unit);
        setDraft(Object.fromEntries(RULES.map((f) => [f.key, String(f.key === "minLeadMinutes" ? lead.value : p[f.key])])));
        setStaff(st);
        setPick(currentPick(st, { kind: "service", serviceId: service.id }));
        setLoadError(null);
      })
      .catch((e) => { if (!cancelled) setLoadError(asText(e)); });
    return () => { cancelled = true; };
  }, [service.id, stamp]);

  const valueOf = (key: PolicyKey) => (key === "minLeadMinutes" ? Number(draft[key]) * UNIT_MINUTES[leadUnit] : Number(draft[key]));
  const minutes = duration.trim() ? Number(duration) : null;
  const serviceDirty = name.trim() !== service.name || minutes !== service.durationMinutes;
  const policyChanges: Partial<Record<PolicyKey, number>> = {};
  if (policy) for (const f of RULES) if (valueOf(f.key) !== policy[f.key]) policyChanges[f.key] = valueOf(f.key);
  const whoDirty = staff !== null && !samePick(pick, currentPick(staff, axis));
  const dirty = serviceDirty || Object.keys(policyChanges).length > 0 || whoDirty;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useBeforeUnload(dirty);

  const save = async () => {
    const n = name.trim();
    let problem = !n ? "צריך שם לשירות." : textProblem("השם", n, 120) ?? durationProblem(minutes);
    for (const f of RULES) {
      const v = valueOf(f.key);
      if (!problem && (!Number.isInteger(v) || v < f.lo || v > f.hi)) {
        problem = f.key === "minLeadMinutes" ? `${f.label}: עד 14 ימים (${f.hi.toLocaleString("he-IL")} דקות).` : `${f.label}: מספר שלם בין ${f.lo.toLocaleString("he-IL")} ל־${f.hi.toLocaleString("he-IL")}.`;
      }
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
      if (whoDirty) await saveAssignment(axis, pick);
      onDirty(false);
      setStamp((x) => x + 1);
      onSaved("השינויים נשמרו");
    } catch (e) {
      setError(e instanceof CalendarApiError && e.code === "VERSION_CONFLICT"
        ? "הנתונים השתנו בינתיים (אולי במסך אחר). מוצג המצב העדכני — אפשר לבדוק ולשמור שוב."
        : assignmentErrorText(e, errorText));
      setStamp((x) => x + 1);
    } finally {
      setBusy(false);
    }
  };

  const loading = policy === null || staff === null;

  return (
    <>
      <section className={s.section} aria-labelledby="svc-details-title">
        <h2 id="svc-details-title">פרטי השירות</h2>
        <div className={s.row2}>
          <div className={s.field}>
            <label className={s.label} htmlFor="svc-name">שם השירות</label>
            <input id="svc-name" className={s.input} value={name} maxLength={140} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className={s.field}>
            <label className={s.label} htmlFor="svc-duration">משך (דקות)</label>
            <input id="svc-duration" type="number" inputMode="numeric" min={LIMITS.minDuration} max={LIMITS.maxDuration} step={5} className={s.input} value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
        </div>
        <p className={s.hint}>זה המשך שהיומן מציע בתור חדש. השם והמשך משותפים לקטלוג השירותים בכל דוביז.</p>
      </section>

      {loadError ? <LoadError text={`לא הצלחתי לטעון את כללי הקביעה. ${loadError}`} onRetry={() => setStamp((x) => x + 1)} /> : null}
      {loading && !loadError ? <Loading label="טוען" rows={3} /> : null}

      {!loading ? (
        <>
          <section className={s.section} aria-labelledby="svc-who-title">
            <h2 id="svc-who-title">מי מבצע את השירות</h2>
            {staff!.some((m) => m.active) ? (
              <AssignmentEditor axis={axis} staff={staff!} services={[service]} value={pick} onChange={setPick} disabled={busy} />
            ) : (
              <p className={s.note}>אין עדיין עובדים. אפשר להוסיף ב<Link href="/calendar/staff" prefetch={false} className={s.linkBtn}>צוות</Link>.</p>
            )}
          </section>

          <section className={s.section} aria-labelledby="svc-rules-title">
            <h2 id="svc-rules-title">כללי קביעה</h2>
            <div className={s.ruleGrid}>
              {RULES.map((f) => (
                <div key={f.key} className={s.field}>
                  <label className={s.label} htmlFor={`pol-${f.key}`}>{f.label}</label>
                  {f.unit === "lead" ? (
                    <div className={s.unitField}>
                      <input id={`pol-${f.key}`} type="number" inputMode="numeric" min={0} className={s.input} value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
                      <select className={s.input} aria-label="יחידה" value={leadUnit} onChange={(e) => {
                        const unit = e.target.value as LeadUnit;
                        const total = Number(draft[f.key]) * UNIT_MINUTES[leadUnit];
                        setLeadUnit(unit);
                        setDraft({ ...draft, [f.key]: String(Math.round(total / UNIT_MINUTES[unit])) });
                      }}>
                        {(["minutes", "hours", "days"] as LeadUnit[]).map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
                      </select>
                    </div>
                  ) : (
                    <div className={s.unitField}>
                      <input id={`pol-${f.key}`} type="number" inputMode="numeric" min={f.lo} max={f.hi} className={s.input} value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
                      <span className={s.hint} style={{ alignSelf: "center", width: 48 }}>{f.unit === "days" ? "ימים" : "דקות"}</span>
                    </div>
                  )}
                  <span className={s.hint}>{f.hint}</span>
                </div>
              ))}
            </div>
            <p className={s.hint}>הכללים חלים על השעות שהיומן מציע — ועל הזמנה מהקישור כשהיא פתוחה.</p>
          </section>
        </>
      ) : null}

      {error ? <p className={s.fieldErr} role="alert">{error}</p> : null}
      <div className={s.saveBar}>
        <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={busy || loading || !dirty} onClick={() => void save()}>{busy ? "שומר…" : "שמירת השינויים"}</button>
        {!dirty && !loading ? <span className={s.hint}>אין שינויים שלא נשמרו.</span> : null}
      </div>
    </>
  );
}
