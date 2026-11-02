"use client";

/**
 * Who performs what — ONE component and ONE save rule for both doors to it: the service's page lists the staff (who
 * performs this service, and in how long when it differs), a staff member's page lists the services (what they
 * perform, and in how long). Both edit the same pairs the server holds (StaffMember × BusinessService with an optional
 * personal length).
 *
 * Saving reads the staff lists again right before writing and changes only this page's entries (assignmentWrites in
 * calendar-model): every other assignment and its own length is carried over exactly, each write sends the version it
 * read, and a list that changed meanwhile is refused (VERSION_CONFLICT) instead of being overwritten.
 */
import { CalendarApiError, forgetIntent, listStaff, setStaffServices, type ServiceWire } from "./calendar-client";
import { assignmentWrites, durationLabel, LIMITS, type AssignAxis, type AssignPick, type StaffWire } from "./calendar-model";
import s from "./calendar.module.css";

export async function saveAssignment(axis: AssignAxis, want: AssignPick): Promise<number> {
  for (const [, d] of want) {
    if (d !== null && !(Number.isInteger(d) && d >= LIMITS.minDuration && d <= LIMITS.maxDuration)) {
      throw new CalendarApiError(400, "INVALID_DURATION");
    }
  }
  const fresh = await listStaff();
  const writes = assignmentWrites(fresh, axis, want);
  for (const w of writes) {
    const intent = `staff:services:${w.member.id}:${w.member.version}:${JSON.stringify(w.services)}`;
    try {
      await setStaffServices(intent, w.member.id, w.services, w.member.version);
    } catch (e) {
      forgetIntent(intent);
      throw e;
    }
  }
  return writes.length;
}

/** The refusal of a save in words. */
export function assignmentErrorText(e: unknown, fallback: (code: string, status?: number) => string): string {
  const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
  if (err.code === "INVALID_DURATION") return `משך אישי צריך להיות בין ${LIMITS.minDuration} ל־${LIMITS.maxDuration.toLocaleString("he-IL")} דקות.`;
  if (err.code === "VERSION_CONFLICT") return "השיוכים השתנו בינתיים (אולי במסך אחר). מוצג המצב העדכני — אפשר לבדוק ולשמור שוב.";
  return fallback(err.code, err.status);
}

type Row = { id: number; name: string; meta: string | null; color?: string | null; base: number | null };

export function AssignmentEditor({
  axis,
  staff,
  services,
  value,
  onChange,
  disabled,
}: {
  axis: AssignAxis;
  staff: StaffWire[];
  services: ServiceWire[];
  value: AssignPick;
  onChange: (next: AssignPick) => void;
  disabled?: boolean;
}) {
  const rows: Row[] = axis.kind === "service"
    ? staff.filter((m) => m.active).map((m) => ({ id: m.id, name: m.displayName, meta: null, color: m.color, base: services.find((x) => x.id === axis.serviceId)?.durationMinutes ?? null }))
    : services.filter((x) => x.active).map((x) => ({ id: x.id, name: x.name, meta: x.durationMinutes ? durationLabel(x.durationMinutes) : "ללא משך", base: x.durationMinutes }));

  if (!rows.length) {
    return <p className={s.note}>{axis.kind === "service" ? "אין עדיין עובדים פעילים." : "אין עדיין שירותים פעילים."}</p>;
  }

  return (
    <div className={s.assign} role="group" aria-label={axis.kind === "service" ? "מי מבצע את השירות" : "שירותים שהעובד מבצע"}>
      {rows.map((r) => {
        const on = value.has(r.id);
        const own = value.get(r.id) ?? null;
        return (
          <div key={r.id} className={s.assignRow}>
            <input
              type="checkbox"
              id={`as-${axis.kind}-${r.id}`}
              checked={on}
              disabled={disabled}
              onChange={(e) => {
                const next = new Map(value);
                if (e.target.checked) next.set(r.id, null);
                else next.delete(r.id);
                onChange(next);
              }}
            />
            <label className={s.assignName} htmlFor={`as-${axis.kind}-${r.id}`}>
              {r.color !== undefined ? <span className={s.dot} style={{ ["--lane" as string]: r.color ?? "#b9b0a7" }} aria-hidden="true" /> : null}
              {r.name}
              {r.meta ? <small> · {r.meta}</small> : null}
            </label>
            <span className={s.assignDur}>
              <input
                type="number"
                inputMode="numeric"
                min={LIMITS.minDuration}
                max={LIMITS.maxDuration}
                step={5}
                className={s.input}
                disabled={!on || disabled}
                aria-label={`משך אישי ל${axis.kind === "service" ? r.name : r.name} (דקות)`}
                placeholder={r.base ? String(r.base) : "משך"}
                value={own ?? ""}
                onChange={(e) => onChange(new Map(value).set(r.id, e.target.value ? Number(e.target.value) : null))}
              />
              דק׳ אישי
            </span>
          </div>
        );
      })}
      <p className={s.hint} style={{ paddingTop: 8 }}>
        {axis.kind === "service" ? "אם לא מסמנים אף עובד, השירות פתוח לכולם." : "שירות שלא שויך לאף עובד פתוח לכולם."} משך אישי — רק כשהוא שונה ממשך השירות.
      </p>
    </div>
  );
}
