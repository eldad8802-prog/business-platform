"use client";

/**
 * "הגדרות שירות" (UI 1.3a, PR 1 — screen 10 of the approved mockups): the default technician and the business's repair
 * warranty. Saved through PUT /api/service-desk/settings, which journals the change (P4) in the same transaction; the
 * server checks the staff member, the version and the limits — the screen only explains its answer.
 *
 * Owner decisions this screen carries: the technician chosen here is assigned automatically to every NEW case (the
 * existing server behaviour, stated plainly here); there is no default warranty (מ3) and the commercial warranty never
 * replaces the statutory one; terms and pickup reminders are not available yet and are shown muted, with no control.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdaptiveOverlay } from "@/components/ui/adaptive-overlay";

import { getSettings, listStaff, saveSettings, type ServiceSettings, type StaffMember } from "./service-desk-client";
import { errorView, type ErrorView } from "./service-desk-errors";
import { bodyFrom, formFrom, hasProblems, isDirty, MAX_BY_UNIT, validate, type SettingsForm } from "./settings-model";
import { Later, LoadError, Loading, NotOpen, ReadOnlyBanner, ScreenHead } from "./ui";
import { useServiceDeskAccess } from "./use-service-desk-access";
import s from "./sd.module.css";

type Loaded = { settings: ServiceSettings; staff: StaffMember[] };

export function ServiceSettingsScreen() {
  const { access, retry } = useServiceDeskAccess();
  const open = access.status === "open";
  const readOnly = open && access.mode === "READ_ONLY";

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ErrorView | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const [settings, staff] = await Promise.all([getSettings(), listStaff()]);
      setLoaded({ settings, staff });
      setForm(formFrom(settings));
      setShowProblems(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const problems = useMemo(() => (form ? validate(form) : {}), [form]);
  const dirty = !!(form && loaded && isDirty(form, loaded.settings));

  const set = (patch: Partial<SettingsForm>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setSaveError(null);
  };

  async function save() {
    if (!form || !loaded || saving || readOnly) return;
    if (hasProblems(problems)) {
      setShowProblems(true);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const r = await saveSettings(bodyFrom(form, loaded.settings.version));
      const settings: ServiceSettings = {
        version: r.version, defaultStaffMemberId: r.defaultStaffMemberId, warrantyTemplate: r.warrantyTemplate,
        activeTermsVersionId: r.activeTermsVersionId, activeStatutoryNoticeVersionId: r.activeStatutoryNoticeVersionId,
      };
      setLoaded((l) => (l ? { ...l, settings } : l));
      setForm(formFrom(settings));
      setShowProblems(false);
      setToast("ההגדרות נשמרו");
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 3000);
    } catch (e) {
      setSaveError(errorView(e));
    } finally {
      setSaving(false);
    }
  }

  const beforeLeave = (proceed: () => void) => {
    if (dirty && !readOnly) setLeaving(() => proceed);
    else proceed();
  };

  const staffIds = new Set((loaded?.staff ?? []).map((m) => String(m.id)));
  const staleDefault = !!(form && form.staffId !== "" && !staffIds.has(form.staffId));
  const disabled = readOnly || saving;

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title="הגדרות שירות" subtitle="טכנאי ברירת מחדל ואחריות לתיקון" fallback="/service-desk" fallbackLabel="לתיקונים ושירות" onBeforeLeave={beforeLeave} />
        {access.status === "loading" ? (
          <Loading />
        ) : access.status === "error" ? (
          <LoadError text="לא הצלחנו לבדוק אם מערכת השירות פתוחה לעסק." onRetry={retry} />
        ) : access.status === "none" ? (
          <NotOpen />
        ) : loadFailed ? (
          <LoadError text="לא הצלחנו לטעון את ההגדרות." onRetry={() => void load()} />
        ) : !form || !loaded ? (
          <Loading />
        ) : (
          <form
            className={s.narrow}
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {readOnly ? <ReadOnlyBanner /> : null}

            <section className={s.card} aria-labelledby="sd-tech-title">
              <div className={s.cardHead}>
                <h2 className={s.cardTitle} id="sd-tech-title">טכנאי ברירת מחדל</h2>
                <p className={s.cardSub}>הטכנאי שתבחר כאן ישויך אוטומטית לכל תיק חדש שייפתח. בלי בחירה — אתה מטפל בתיקים החדשים בעצמך.</p>
              </div>
              <div className={s.field}>
                <label className={s.label} htmlFor="sd-tech">טכנאי לתיקים חדשים</label>
                <select id="sd-tech" className={s.select} value={form.staffId} disabled={disabled} onChange={(e) => set({ staffId: e.target.value })}>
                  <option value="">אני (בעל העסק)</option>
                  {loaded.staff.map((m) => (
                    <option key={m.id} value={String(m.id)}>{m.displayName}</option>
                  ))}
                  {staleDefault ? <option value={form.staffId} disabled>טכנאי שכבר לא פעיל</option> : null}
                </select>
                {staleDefault ? (
                  <span className={s.problem}>הטכנאי שהוגדר כבר לא פעיל בעסק, ולכן תיקים חדשים יטופלו על ידך. בחר טכנאי אחר או את עצמך.</span>
                ) : loaded.staff.length === 0 ? (
                  <span className={s.hint}>אין כרגע עובדים פעילים בעסק, ולכן התיקים יטופלו על ידך.</span>
                ) : null}
              </div>
            </section>

            <section className={s.card} aria-labelledby="sd-warranty-title">
              <div className={s.cardHead}>
                <h2 className={s.cardTitle} id="sd-warranty-title">אחריות על תיקונים</h2>
                <p className={s.cardSub}>אין ברירת מחדל. אם העסק נותן אחריות על תיקונים, הגדר אותה כאן והיא תוצע בתיקים.</p>
              </div>
              <label className={s.check}>
                <input type="checkbox" checked={form.warrantyOn} disabled={disabled} onChange={(e) => set({ warrantyOn: e.target.checked })} />
                <span>העסק נותן אחריות על תיקונים</span>
              </label>
              {form.warrantyOn ? (
                <>
                  <div className={s.pair}>
                    <div className={s.field}>
                      <label className={s.label} htmlFor="sd-w-value">משך</label>
                      <input
                        id="sd-w-value"
                        className={s.input}
                        inputMode="numeric"
                        value={form.value}
                        disabled={disabled}
                        aria-invalid={showProblems && !!problems.value}
                        aria-describedby={showProblems && problems.value ? "sd-w-value-p" : undefined}
                        onChange={(e) => set({ value: e.target.value })}
                      />
                    </div>
                    <div className={s.field}>
                      <label className={s.label} htmlFor="sd-w-unit">יחידה</label>
                      <select id="sd-w-unit" className={s.select} value={form.unit} disabled={disabled} onChange={(e) => set({ unit: e.target.value as SettingsForm["unit"] })}>
                        <option value="MONTHS">חודשים</option>
                        <option value="DAYS">ימים</option>
                      </select>
                    </div>
                  </div>
                  {showProblems && problems.value ? (
                    <span className={s.problem} id="sd-w-value-p">{problems.value}</span>
                  ) : (
                    <span className={s.hint}>עד {MAX_BY_UNIT[form.unit]} {form.unit === "MONTHS" ? "חודשים" : "ימים"}.</span>
                  )}
                  <div className={s.field}>
                    <label className={s.label} htmlFor="sd-w-scope">מה האחריות מכסה</label>
                    <textarea
                      id="sd-w-scope"
                      className={s.textarea}
                      value={form.scope}
                      disabled={disabled}
                      aria-invalid={showProblems && !!problems.scope}
                      aria-describedby={showProblems && problems.scope ? "sd-w-scope-p" : undefined}
                      onChange={(e) => set({ scope: e.target.value })}
                    />
                    {showProblems && problems.scope ? <span className={s.problem} id="sd-w-scope-p">{problems.scope}</span> : null}
                  </div>
                  <div className={s.field}>
                    <label className={s.label} htmlFor="sd-w-excl">מה לא מכוסה (לא חובה)</label>
                    <textarea
                      id="sd-w-excl"
                      className={s.textarea}
                      value={form.exclusions}
                      disabled={disabled}
                      aria-invalid={showProblems && !!problems.exclusions}
                      aria-describedby={showProblems && problems.exclusions ? "sd-w-excl-p" : undefined}
                      onChange={(e) => set({ exclusions: e.target.value })}
                    />
                    {showProblems && problems.exclusions ? <span className={s.problem} id="sd-w-excl-p">{problems.exclusions}</span> : null}
                  </div>
                </>
              ) : null}
              <p className={s.legal}>האחריות שמוגדרת כאן היא אחריות מסחרית של העסק. היא לא מחליפה ולא מצמצמת את האחריות שהחוק מחייב, שחלה בכל מקרה.</p>
            </section>

            <section className={s.card} aria-label="בשלבים הבאים">
              <Later title="תנאי שירות" text="נוסח התנאים שהלקוח מאשר בקבלת המכשיר." />
              <Later title="תזכורות איסוף" text="תזכורות ללקוח כשהמכשיר מוכן — רק אחרי שיחובר ערוץ שליחה." />
            </section>

            {!readOnly ? (
              <div className={s.saveBar}>
                {saveError ? (
                  <div className={s.error} role="alert">
                    <span>{saveError.text}</span>
                    {saveError.reload ? (
                      <div>
                        <button type="button" className={s.button} onClick={() => { setSaveError(null); void load(); }}>לרענן</button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <button type="submit" className={`${s.button} ${s.primary}`} disabled={!dirty || saving}>
                  {saving ? "שומר…" : "שמירת ההגדרות"}
                </button>
              </div>
            ) : null}
          </form>
        )}
      </div>

      {toast ? <div className={s.toast} role="status" aria-live="polite">{toast}</div> : null}

      <AdaptiveOverlay className={s.theme} variant="confirm" open={leaving !== null} onClose={() => setLeaving(null)} labelledBy="sd-leave-q">
        <div className={s.confirm} role="alertdialog" aria-labelledby="sd-leave-q" aria-describedby="sd-leave-d">
          <strong id="sd-leave-q">יש שינויים שלא נשמרו.</strong>
          <span id="sd-leave-d">לצאת בלי לשמור? השינויים יאבדו.</span>
          <div className={s.confirmRow}>
            <button type="button" className={`${s.button} ${s.primary}`} autoFocus onClick={() => setLeaving(null)}>להישאר</button>
            <button type="button" className={s.button} onClick={() => { const go = leaving; setLeaving(null); go?.(); }}>לצאת בלי לשמור</button>
          </div>
        </div>
      </AdaptiveOverlay>
    </main>
  );
}
