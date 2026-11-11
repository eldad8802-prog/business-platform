"use client";

/**
 * Service Desk — the intake screen of one IN_SHOP case: the item's condition and accessories, photos and notes, the
 * owner's confirmation of the intake, the intake slip PDF, and the intake history. Hebrew, RTL, phone first.
 * Owner decision 2026-11-11: no customer signature and no legal-terms step — the owner (or an authorized user) confirms
 * the documented intake; the journal records who, when and the status change. Every action is offered only when the
 * server allows it (IntakeView.allowed) and the access is FULL; a refused action is explained.
 */
import { useCallback, useEffect, useState } from "react";

import { confirmIntake, createSlip, fetchIntakeBlob, getIntake, saveIntakeData, uploadPhoto, type IntakeView } from "./intake-client";
import { PHOTO_JPEG_QUALITY, confirmBlocker, currentSection, downscaleTarget, historyLine, israelDateTime } from "./intake-model";
import { errorView } from "./service-desk-errors";
import s from "./sd.module.css";
import { LoadError, Loading, NotOpen, ReadOnlyBanner, ScreenHead } from "./ui";
import { useServiceDeskAccess } from "./use-service-desk-access";

type Form = { conditionNote: string; accessoriesNote: string; conditionRecorded: boolean; accessoriesRecorded: boolean };
const formOf = (v: IntakeView): Form => ({
  conditionNote: v.intake?.conditionNote ?? "", accessoriesNote: v.intake?.accessoriesNote ?? "",
  conditionRecorded: v.intake?.conditionRecorded ?? false, accessoriesRecorded: v.intake?.accessoriesRecorded ?? false,
});

/** A blob from the server as an object URL, revoked when it changes or the screen leaves. */
function useBlobUrl(load: (() => Promise<Blob>) | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!load) return;
    let alive = true;
    let made: string | null = null;
    load().then((b) => { if (alive) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => undefined);
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [load]);
  return load ? url : null;
}

function Thumb({ caseId, id }: { caseId: number; id: number }) {
  const load = useCallback(() => fetchIntakeBlob(caseId, { kind: "photo", id }), [caseId, id]);
  const url = useBlobUrl(load);
  // eslint-disable-next-line @next/next/no-img-element -- a private blob: URL (fetched with the session header); next/image cannot load it
  return url ? <img className={s.photo} src={url} alt="תמונת קליטה" /> : <span className={`${s.photo} ${s.photoEmpty}`} aria-hidden="true" />;
}

/** Photos leave the phone downsized as JPEG (under the server's request cap). */
async function downsize(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const t = downscaleTarget(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = t.width; canvas.height = t.height;
  canvas.getContext("2d")?.drawImage(bmp, 0, 0, t.width, t.height);
  bmp.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", PHOTO_JPEG_QUALITY));
}

export function IntakeScreen({ caseId }: { caseId: number }) {
  const { access, retry } = useServiceDeskAccess();
  const [view, setView] = useState<IntakeView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [tick, setTick] = useState(0);
  /** Reload the intake from the server (after every action, and on "retry"). */
  const load = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (access.status !== "open") return;
    let alive = true;
    getIntake(caseId).then(
      (v) => { if (alive) { setLoadFailed(false); setView(v); setForm(formOf(v)); } },
      () => { if (alive) setLoadFailed(true); },
    );
    return () => { alive = false; };
  }, [access.status, caseId, tick]);

  const readOnly = access.status === "open" && access.mode === "READ_ONLY";
  const can = (k: keyof IntakeView["allowed"]) => !readOnly && !!view?.allowed[k];

  const act = async (label: string, run: () => Promise<unknown>, done: string) => {
    setBusy(label);
    setMessage(null);
    try {
      await run();
      setMessage(done);
    } catch (e) {
      const ev = errorView(e);
      setMessage(ev.text);
    } finally {
      setBusy(null);
      load();
    }
  };

  const section = view ? currentSection(view) : null;
  const blocker = view ? confirmBlocker(view) : null;

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead
          title={view ? `קליטה · תיק ${view.case.caseNumber}` : "קליטה"}
          subtitle="מצב הפריט, אביזרים, תמונות ואישור הקליטה"
          fallback="/service-desk"
          fallbackLabel="לשירות ואחריות"
        />
        {access.status === "loading" ? (
          <Loading />
        ) : access.status === "error" ? (
          <LoadError text="לא הצלחנו לבדוק אם מערכת השירות פתוחה לעסק." onRetry={retry} />
        ) : access.status === "none" ? (
          <NotOpen />
        ) : loadFailed ? (
          <LoadError text="לא הצלחנו לטעון את הקליטה." onRetry={load} />
        ) : !view || !form ? (
          <Loading />
        ) : (
          <>
            {readOnly ? <ReadOnlyBanner /> : null}
            {message ? <p className={s.toast} role="status" aria-live="polite">{message}</p> : null}

            <section className={s.card} aria-labelledby="in-data" data-current={section === "data" || undefined}>
              <h2 id="in-data" className={s.cardTitle}>מצב המכשיר בקליטה</h2>
              <label className={s.field}>
                <span className={s.label}>מצב חיצוני (שריטות, סדקים, נזק)</span>
                <textarea className={s.textarea} rows={3} maxLength={2000} value={form.conditionNote} disabled={!can("recordData") || !!busy}
                  onChange={(e) => setForm({ ...form, conditionNote: e.target.value })} />
              </label>
              <label className={s.check}>
                <input type="checkbox" checked={form.conditionRecorded} disabled={!can("recordData") || !!busy} onChange={(e) => setForm({ ...form, conditionRecorded: e.target.checked })} />
                <span>מצב המכשיר נבדק ותועד</span>
              </label>
              <label className={s.field}>
                <span className={s.label}>אביזרים שנמסרו (מטען, כיסוי, כבל)</span>
                <textarea className={s.textarea} rows={2} maxLength={2000} value={form.accessoriesNote} disabled={!can("recordData") || !!busy}
                  onChange={(e) => setForm({ ...form, accessoriesNote: e.target.value })} />
              </label>
              <label className={s.check}>
                <input type="checkbox" checked={form.accessoriesRecorded} disabled={!can("recordData") || !!busy} onChange={(e) => setForm({ ...form, accessoriesRecorded: e.target.checked })} />
                <span>האביזרים נבדקו ותועדו</span>
              </label>
              {can("recordData") ? (
                <div className={s.actions}>
                  <button type="button" className={`${s.button} ${s.primary}`} disabled={!!busy}
                    onClick={() => void act("data", () => saveIntakeData(caseId, {
                      conditionNote: form.conditionNote.trim() || null, accessoriesNote: form.accessoriesNote.trim() || null,
                      conditionRecorded: form.conditionRecorded, accessoriesRecorded: form.accessoriesRecorded, expectedVersion: view.case.version,
                    }), "פרטי הקליטה נשמרו.")}>
                    {busy === "data" ? "שומר…" : "שמירת פרטי הקליטה"}
                  </button>
                </div>
              ) : null}
            </section>

            <section className={s.card} aria-labelledby="in-photos">
              <h2 id="in-photos" className={s.cardTitle}>תמונות ({view.photos.length}/10)</h2>
              {view.photos.length === 0 ? <p className={s.hint}>לא צולמו תמונות. מומלץ לצלם את המכשיר מכל הצדדים.</p> : (
                <div className={s.photos}>{view.photos.map((p) => <Thumb key={p.id} caseId={caseId} id={p.id} />)}</div>
              )}
              {can("addPhoto") ? (
                <label className={`${s.button} ${s.fileButton}`}>
                  {busy === "photo" ? "מעלה…" : "צילום / הוספת תמונה"}
                  <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden disabled={!!busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      void act("photo", async () => uploadPhoto(caseId, await downsize(file), view.case.version, `${file.size}:${file.lastModified}:${file.name}`), "התמונה נוספה.");
                    }} />
                </label>
              ) : null}
            </section>

            <section className={s.card} aria-labelledby="in-confirm" data-current={section === "confirm" || undefined}>
              <h2 id="in-confirm" className={s.cardTitle}>אישור הקליטה</h2>
              {view.confirmation ? (
                <p className={s.cardSub}>הקליטה אושרה על ידי {view.confirmation.byName ?? "משתמש העסק"} · {israelDateTime(view.confirmation.at)}</p>
              ) : can("confirm") ? (
                <div className={s.actions}>
                  <p className={s.hint}>באישור הקליטה אתם מאשרים שמצב הפריט, האביזרים והתמונות תועדו, והפריט התקבל לטיפול. האישור נרשם ביומן התיק עם שמכם והשעה.</p>
                  <button type="button" className={`${s.button} ${s.primary}`} disabled={!!busy}
                    onClick={() => void act("confirm", () => confirmIntake(caseId, view.case.version), "הקליטה אושרה והפריט התקבל לטיפול.")}>
                    {busy === "confirm" ? "שומר…" : "אישור קליטה וקבלת הפריט"}
                  </button>
                </div>
              ) : (
                <p className={s.legal}>{blocker}</p>
              )}
            </section>

            {view.confirmation ? (
              <section className={s.card} aria-labelledby="in-slip">
                <h2 id="in-slip" className={s.cardTitle}>טופס קליטה</h2>
                {view.intake?.hasSlip ? (
                  <button type="button" className={s.button} disabled={!!busy}
                    onClick={() => void act("slip-open", async () => {
                      const url = URL.createObjectURL(await fetchIntakeBlob(caseId, { kind: "slip" }));
                      const a = document.createElement("a");
                      a.href = url; a.download = `intake-${view.case.caseNumber}.pdf`; a.click();
                      setTimeout(() => URL.revokeObjectURL(url), 30_000);
                    }, "הטופס הורד.")}>
                    הורדת טופס הקליטה (PDF)
                  </button>
                ) : can("createSlip") ? (
                  <button type="button" className={`${s.button} ${s.primary}`} disabled={!!busy}
                    onClick={() => void act("slip", () => createSlip(caseId, view.case.version), "טופס הקליטה נשמר.")}>
                    {busy === "slip" ? "יוצר…" : "יצירת טופס קליטה (PDF)"}
                  </button>
                ) : <p className={s.hint}>טופס הקליטה ייווצר כאן.</p>}
              </section>
            ) : null}

            <section className={s.card} aria-labelledby="in-history">
              <h2 id="in-history" className={s.cardTitle}>היסטוריית הקליטה</h2>
              {view.history.length === 0 ? <p className={s.hint}>עדיין לא נרשם דבר.</p> : (
                <ol className={s.history}>
                  {view.history.map((h) => (
                    <li key={h.seq}><span>{historyLine(h.step)}</span> <span className={s.rowSub}>{israelDateTime(h.occurredAt)}</span></li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
