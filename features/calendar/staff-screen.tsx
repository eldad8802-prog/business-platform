"use client";

/**
 * "צוות" — the calendar's people, design direction A.
 *   /calendar/staff        the list (colour, name, active or not, whose hours, how many services) and "הוספת עובד" —
 *                          a name and a colour; a new member gets the first colour nobody uses yet.
 *   /calendar/staff/[id]   one member: name and colour, active or not (deactivating keeps every existing appointment —
 *                          they stay on the calendar), their own weekly hours or the business's, their special days,
 *                          and the services they perform with their own length (the same editor as the service page).
 * Staff have NO login: a name and a colour on the calendar. Nothing is deleted: a member is deactivated.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";
import { uuidV7 } from "@/lib/tasks/tasks-client";

import { AssignmentEditor, assignmentErrorText, saveAssignment } from "./assignment-editor";
import { HoursEditor, SpecialDays } from "./availability-editors";
import { CalendarApiError, createStaff, forgetIntent, listServices, listStaff, updateStaff, type ServiceWire } from "./calendar-client";
import { COLOR_NAME, currentPick, errorText, LIMITS, nextStaffColor, samePick, STAFF_PALETTE, textProblem, type AssignPick, type StaffWire } from "./calendar-model";
import { useLeaveGuard } from "./manage-screens";
import { Chevron, Empty, FeatureOff, IconCheck, IconPlus, IconUsers, Loading, LoadError, ScreenHead, Switch, useBeforeUnload, useToast } from "./ui";
import s from "./calendar.module.css";

function ColorPick({ value, onChange }: { value: string | null; onChange: (c: string) => void }) {
  const palette = value && !STAFF_PALETTE.includes(value) ? [value, ...STAFF_PALETTE] : STAFF_PALETTE;
  return (
    <div className={s.colors} role="radiogroup" aria-label="צבע ביומן">
      {palette.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={COLOR_NAME[c] ?? "הצבע הנוכחי"} className={s.colorBtn} style={{ ["--lane" as string]: c }} onClick={() => onChange(c)}>
          {value === c ? <IconCheck size={18} strokeWidth={2.6} /> : null}
        </button>
      ))}
    </div>
  );
}

const asText = (e: unknown) => (e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK"));

export function StaffScreen() {
  const on = useFeatureState("appointments");
  const router = useRouter();
  const [staff, setStaff] = useState<StaffWire[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const intent = useRef(`staff:create:${uuidV7()}`);

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    listStaff().then((v) => { if (!cancelled) { setStaff(v); setLoadError(null); } }).catch((e) => { if (!cancelled) setLoadError(asText(e)); });
    return () => { cancelled = true; };
  }, [on, tick]);

  if (on === false) return <FeatureOff title="צוות" />;

  const create = async () => {
    const n = name.trim();
    const problem = !n ? "צריך שם לעובד." : textProblem("השם", n, LIMITS.staffName);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const out = await createStaff(intent.current, { displayName: n, color: color ?? nextStaffColor(staff ?? []) });
      intent.current = `staff:create:${uuidV7()}`;
      router.push(`/calendar/staff/${out.staffMember.id}`);
    } catch (e) {
      forgetIntent(intent.current);
      intent.current = `staff:create:${uuidV7()}`;
      setError(asText(e));
    } finally {
      setBusy(false);
    }
  };

  const sorted = [...(staff ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || a.sortOrder - b.sortOrder || a.id - b.id);

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title="צוות" subtitle="מי עובד ביומן" fallback="/calendar/manage"
          end={!adding && staff ? <button type="button" className={`${s.btn} ${s.btnSoft} ${s.btnSm}`} onClick={() => { setAdding(true); setColor(nextStaffColor(staff)); }}><IconPlus size={18} /> הוספת עובד</button> : null} />

        {adding ? (
          <section className={s.section} aria-labelledby="new-staff-title">
            <h2 id="new-staff-title">עובד חדש</h2>
            <div className={s.field}>
              <label className={s.label} htmlFor="staff-name">שם</label>
              <input id="staff-name" className={s.input} value={name} maxLength={LIMITS.staffName + 20} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <div className={s.field}><span className={s.label}>צבע ביומן</span><ColorPick value={color} onChange={setColor} /></div>
            {error ? <p className={s.fieldErr} role="alert">{error}</p> : null}
            <div className={s.confirmRow}>
              <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={busy} onClick={() => void create()}>{busy ? "שומר…" : "הוספת העובד"}</button>
              <button type="button" className={s.btn} disabled={busy} onClick={() => { setAdding(false); setName(""); setError(null); }}>סגירה</button>
            </div>
          </section>
        ) : null}

        {loadError ? <LoadError text={`לא הצלחתי לטעון את הצוות. ${loadError}`} onRetry={() => setTick((x) => x + 1)} /> : null}
        {!loadError && staff === null ? <Loading label="טוען צוות" /> : null}
        {staff && !staff.length && !adding ? (
          <Empty title="עוד אין עובדים" icon={<IconUsers size={32} />}>
            <span>בלי עובדים היומן עובד לפי שעות העסק. עובד נוסף מקבל צבע ושעות משלו.</span>
            <button type="button" className={`${s.btn} ${s.btnPri}`} onClick={() => { setAdding(true); setColor(nextStaffColor([])); }}><IconPlus size={18} /> הוספת עובד</button>
          </Empty>
        ) : null}
        {sorted.length ? (
          <ul className={s.list} style={{ marginTop: 16 }}>
            {sorted.map((m) => (
              <li key={m.id}>
                <Link href={`/calendar/staff/${m.id}`} prefetch={false} className={s.listRow}>
                  <span className={s.avatar} style={{ ["--lane" as string]: m.color ?? "#b9b0a7" }} aria-hidden="true">{m.displayName.trim().slice(0, 1)}</span>
                  <span className={s.rowText}>
                    <span className={s.rowTitle} style={{ fontSize: 17 }}>{m.displayName}</span>
                    <span className={s.rowSub}>{m.services.length ? `${m.services.length} ${m.services.length === 1 ? "שירות" : "שירותים"}` : "כל השירותים הפתוחים"}</span>
                  </span>
                  <span className={s.rowEnd}>{m.active ? null : <span className={s.tag}>לא פעיל</span>}<Chevron dir="open" /></span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        <p className={s.note} style={{ marginTop: 16 }}>לעובדים אין כניסה לדוביז — רק שם וצבע ביומן.</p>
      </div>
    </main>
  );
}

export function StaffDetailScreen({ id }: { id: number }) {
  const on = useFeatureState("appointments");
  const { flash, node: toast } = useToast();
  const guard = useLeaveGuard();
  const [member, setMember] = useState<StaffWire | null>(null);
  const [staff, setStaff] = useState<StaffWire[]>([]);
  const [services, setServices] = useState<ServiceWire[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [tick, setTick] = useState(0);
  const [dirtyParts, setDirtyParts] = useState<Record<string, boolean>>({});

  const reload = useCallback(() => setTick((x) => x + 1), []);
  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    Promise.all([listStaff(), listServices()])
      .then(([st, sv]) => {
        if (cancelled) return;
        setStaff(st);
        setServices(sv);
        const m = st.find((x) => x.id === id) ?? null;
        setMember(m);
        setMissing(!m);
        setLoadError(null);
      })
      .catch((e) => { if (!cancelled) setLoadError(asText(e)); });
    return () => { cancelled = true; };
  }, [on, id, tick]);

  const markDirty = useCallback((part: string) => (d: boolean) => setDirtyParts((cur) => (cur[part] === d ? cur : { ...cur, [part]: d })), []);
  const anyDirty = Object.values(dirtyParts).some(Boolean);
  const { setDirty } = guard;
  useEffect(() => { setDirty(anyDirty); }, [anyDirty, setDirty]);

  if (on === false) return <FeatureOff title="עובד" />;

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title={member?.displayName ?? "עובד"} subtitle={member ? (member.active ? "פעיל ביומן" : "לא פעיל — לא מוצע לתורים חדשים") : undefined} fallback="/calendar/staff" onBeforeLeave={guard.onBeforeLeave} />
        {guard.node}
        {loadError ? <LoadError text={`לא הצלחתי לטעון את העובד. ${loadError}`} onRetry={reload} /> : null}
        {!loadError && !member && !missing ? <Loading label="טוען את העובד" /> : null}
        {missing ? <Empty title="העובד לא נמצא"><Link href="/calendar/staff" prefetch={false} className={s.btn}>לרשימת הצוות</Link></Empty> : null}
        {member && services ? (
          <>
            <StaffDetails key={`d:${member.id}:${member.version}`} member={member} onDirty={markDirty("details")} onSaved={(m) => { reload(); flash(m); }} />
            <section className={s.section} aria-labelledby="staff-hours-title">
              <h2 id="staff-hours-title">שעות עבודה</h2>
              <HoursEditor staffMemberId={member.id} onSaved={flash} onDirty={markDirty("hours")} />
            </section>
            <section className={s.section} aria-labelledby="staff-days-title">
              <h2 id="staff-days-title">ימים מיוחדים של העובד</h2>
              <SpecialDays staffMemberId={member.id} onChanged={flash} />
            </section>
            <section className={s.section} aria-labelledby="staff-services-title">
              <h2 id="staff-services-title">שירותים שהעובד מבצע</h2>
              <StaffServices key={`sv:${member.id}:${member.version}`} member={member} staff={staff} services={services} onDirty={markDirty("services")} onSaved={() => { reload(); flash("השירותים נשמרו"); }} onStale={() => { reload(); flash("השיוכים השתנו בינתיים. מוצג המצב העדכני."); }} />
            </section>
          </>
        ) : null}
      </div>
      {toast}
    </main>
  );
}

function StaffDetails({ member, onSaved, onDirty }: { member: StaffWire; onSaved: (message: string) => void; onDirty: (d: boolean) => void }) {
  const [name, setName] = useState(member.displayName);
  const [color, setColor] = useState<string | null>(member.color);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = name.trim() !== member.displayName || color !== member.color;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useBeforeUnload(dirty);

  const save = async (patch: { displayName?: string; color?: string | null; active?: boolean }, message: string) => {
    const intent = `staff:update:${member.id}:${member.version}:${JSON.stringify(patch)}`;
    setBusy(true);
    setError(null);
    try {
      await updateStaff(intent, member.id, { ...patch, expectedVersion: member.version });
      onDirty(false);
      onSaved(message);
    } catch (e) {
      forgetIntent(intent);
      setError(asText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={s.section} aria-labelledby="staff-details-title">
      <h2 id="staff-details-title">פרטים</h2>
      <div className={s.field}>
        <label className={s.label} htmlFor="staff-edit-name">שם</label>
        <input id="staff-edit-name" className={s.input} value={name} maxLength={LIMITS.staffName + 20} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className={s.field}><span className={s.label}>צבע ביומן</span><ColorPick value={color} onChange={setColor} /></div>
      {error ? <p className={s.fieldErr} role="alert">{error}</p> : null}
      <div className={s.confirmRow} style={{ maxWidth: 420 }}>
        <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={busy || !dirty} onClick={() => {
          const problem = !name.trim() ? "צריך שם לעובד." : textProblem("השם", name.trim(), LIMITS.staffName);
          if (problem) { setError(problem); return; }
          void save({ displayName: name.trim(), color }, "הפרטים נשמרו");
        }}>שמירת הפרטים</button>
      </div>
      <div className={s.setRow}>
        <label htmlFor="staff-active">
          פעיל ביומן
          <small>{member.active ? "מוצע לתורים חדשים." : "לא מוצע לתורים חדשים. התורים הקיימים שלו נשארים ביומן."}</small>
        </label>
        <Switch id="staff-active" label="פעיל ביומן" checked={member.active} disabled={busy} onChange={(v) => void save({ active: v }, v ? "העובד פעיל שוב" : "העובד הוגדר כלא פעיל")} />
      </div>
    </section>
  );
}

function StaffServices({ member, staff, services, onSaved, onStale, onDirty }: { member: StaffWire; staff: StaffWire[]; services: ServiceWire[]; onSaved: () => void; onStale: () => void; onDirty: (d: boolean) => void }) {
  const axis = { kind: "staff" as const, staffId: member.id };
  const initial = currentPick(staff, axis);
  const [pick, setPick] = useState<AssignPick>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = !samePick(pick, initial);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useBeforeUnload(dirty);

  return (
    <>
      <AssignmentEditor axis={axis} staff={staff} services={services} value={pick} onChange={setPick} disabled={busy} />
      {error ? <p className={s.fieldErr} role="alert">{error}</p> : null}
      <div className={s.confirmRow} style={{ maxWidth: 420 }}>
        <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={busy || !dirty} onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await saveAssignment(axis, pick);
            onDirty(false);
            onSaved();
          } catch (e) {
            if (e instanceof CalendarApiError && e.code === "VERSION_CONFLICT") onStale();
            else setError(assignmentErrorText(e, errorText));
          } finally {
            setBusy(false);
          }
        }}>{busy ? "שומר…" : "שמירת השירותים"}</button>
      </div>
    </>
  );
}
