"use client";

/**
 * Service Desk 1.3b-C — the intake screen of one IN_SHOP case: device condition and accessories, photos, the service
 * terms shown to the customer, the customer's signature, the intake slip PDF, and the intake history. Hebrew, RTL,
 * phone first. Every action is offered only when the server allows it (IntakeView.allowed) and the access is FULL; a
 * refused action is explained, never hidden behind a fake success. Without legally approved terms the screen says so and
 * offers no signature (owner rule: no signed intake without approved terms).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createSlip, fetchIntakeBlob, getIntake, presentTerms, saveIntakeData, signIntake, uploadPhoto, type IntakeView,
} from "./intake-client";
import { PHOTO_JPEG_QUALITY, currentSection, downscaleTarget, historyLine, israelDateTime, signBlocker, signatureLooksDrawn } from "./intake-model";
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

function SignaturePad({ disabled, onChange }: { disabled: boolean; onChange: (pngBase64: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const strokes = useRef<{ x: number; y: number }[][]>([]);
  const drawing = useRef(false);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * e.currentTarget.width) / r.width, y: ((e.clientY - r.top) * e.currentTarget.height) / r.height };
  };
  const finish = () => {
    drawing.current = false;
    const c = ref.current;
    onChange(c && signatureLooksDrawn(strokes.current) ? c.toDataURL("image/png").replace(/^data:image\/png;base64,/, "") : null);
  };
  const clear = () => {
    const c = ref.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    strokes.current = [];
    onChange(null);
  };

  return (
    <div className={s.padWrap}>
      <canvas
        ref={ref}
        className={s.pad}
        width={900}
        height={300}
        aria-label="אזור חתימת הלקוח"
        onPointerDown={(e) => {
          if (disabled) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          strokes.current.push([point(e)]);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = e.currentTarget.getContext("2d");
          const stroke = strokes.current[strokes.current.length - 1];
          const p = point(e);
          const prev = stroke[stroke.length - 1];
          stroke.push(p);
          if (ctx && prev) { ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.strokeStyle = "#1f1b16"; ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(p.x, p.y); ctx.stroke(); }
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
      />
      <button type="button" className={s.button} onClick={clear} disabled={disabled}>ניקוי</button>
    </div>
  );
}

export function IntakeScreen({ caseId }: { caseId: number }) {
  const { access, retry } = useServiceDeskAccess();
  const [view, setView] = useState<IntakeView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

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

  const sigLoad = useCallback(() => fetchIntakeBlob(caseId, { kind: "signature" }), [caseId]);
  const signatureUrl = useBlobUrl(view?.intake?.hasSignature ? sigLoad : null);
  const section = view ? currentSection(view) : null;
  const blocker = view ? signBlocker(view) : null;

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead
          title={view ? `קליטה · תיק ${view.case.caseNumber}` : "קליטה"}
          subtitle="מצב המכשיר, תמונות, תנאי השירות וחתימת הלקוח"
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

            <section className={s.card} aria-labelledby="in-terms" data-current={section === "terms" || undefined}>
              <h2 id="in-terms" className={s.cardTitle}>תנאי השירות</h2>
              {view.terms ? (
                <>
                  <p className={s.cardSub}>הוצג ללקוח · גרסה {view.terms.termsVersion} · {israelDateTime(view.terms.presentedAt)}</p>
                  <div className={s.termsBody} tabIndex={0} aria-label="נוסח תנאי השירות">{view.terms.termsBody}</div>
                  <h3 className={s.label}>הודעה לפי דין (גרסה {view.terms.statutoryVersion})</h3>
                  <div className={s.termsBody} tabIndex={0} aria-label="הודעה לפי דין">{view.terms.statutoryBody}</div>
                </>
              ) : can("presentTerms") ? (
                <div className={s.actions}>
                  <p className={s.hint}>הציגו ללקוח את תנאי השירות המאושרים לפני החתימה. הנוסח נשמר בתיק כפי שהוצג.</p>
                  <button type="button" className={`${s.button} ${s.primary}`} disabled={!!busy}
                    onClick={() => void act("terms", () => presentTerms(caseId, view.case.version), "התנאים הוצגו ונשמרו בתיק.")}>
                    {busy === "terms" ? "שומר…" : "הצגת התנאים ללקוח"}
                  </button>
                </div>
              ) : (
                <p className={s.legal}>{view.activeTerms.approved ? "אי אפשר להציג תנאים במצב הנוכחי של התיק." : "אין עדיין נוסח תנאים שאושר משפטית. אי אפשר להציג תנאים או להחתים לקוח עד לאישור."}</p>
              )}
            </section>

            <section className={s.card} aria-labelledby="in-sign" data-current={section === "sign" || undefined}>
              <h2 id="in-sign" className={s.cardTitle}>חתימת הלקוח</h2>
              {view.intake?.signed ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- a private blob: URL; next/image cannot load it */}
                  {signatureUrl ? <img className={s.signature} src={signatureUrl} alt="חתימת הלקוח" /> : null}
                  <p className={s.cardSub}>נחתם {view.intake.signedAt ? israelDateTime(view.intake.signedAt) : ""} · תנאים {view.intake.termsVersion}</p>
                </>
              ) : can("sign") ? (
                <>
                  <p className={s.hint}>הלקוח חותם כאן. בחתימה הוא מאשר את מצב המכשיר, האביזרים והתנאים שהוצגו לו.</p>
                  <SignaturePad disabled={!!busy} onChange={setSignature} />
                  <div className={s.actions}>
                    <button type="button" className={`${s.button} ${s.primary}`} disabled={!!busy || !signature}
                      onClick={() => signature && void act("sign", () => signIntake(caseId, signature, view.case.version), "הקליטה נחתמה.")}>
                      {busy === "sign" ? "שומר…" : "אישור וחתימה"}
                    </button>
                  </div>
                </>
              ) : (
                <p className={s.legal}>{blocker}</p>
              )}
            </section>

            {view.intake?.signed ? (
              <section className={s.card} aria-labelledby="in-slip">
                <h2 id="in-slip" className={s.cardTitle}>טופס קליטה</h2>
                {view.intake.hasSlip ? (
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
