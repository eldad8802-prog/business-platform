"use client";

/**
 * "מעבר לעוסק מורשה" — the three-step flow, as the owner approved it (artifact YYDWFcaJCm6HRpqb6bYs4Q, 2026-11-21).
 *
 *   1. explain + the Tax Authority status date      (date checked here and again on the server)
 *   2. retype the id number + password / Google     (re-authentication is server-side: an httpOnly proof cookie)
 *   3. summary, effects, warnings, five confirmations, confirm
 *   → success (+ the history line on the business screen)
 *
 * The screen explains; the server decides: OFF → every call answers 404 and this page says so; eligibility, the id
 * number match, the re-authentication, the digest and the transition itself are all re-checked on the server, and
 * the database function writes nothing unless every check passes.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import {
  GoogleMark, IconAlert, IconBack, IconCheck, IconDoc, IconInfo, IconLock, IconPercent, IconPlus, IconSpinner, IconWarn,
  NewFileSheet, Note,
} from "@/components/legal-identity/kind-transition-parts";
import {
  checkIdentity, confirmKindTransition, confirmOutcome, dateState, decodeDraft, digitsOnly, displayDate, displayInstant, DRAFT_KEY, encodeDraft,
  fetchKindTransitionInfo, GOOGLE_RETURN_MESSAGES, googleReturnOf, israelTodayClient, previewKindTransition,
  reauthWithPassword, sameTaxId, startedBeforeConfirmation, startGoogleReauth, type KindTransitionInfo,
} from "@/lib/legal-identity/kind-transition-client";

import s from "./kind-transition.module.css";

type Screen = "loading" | "off" | "loadError" | "blocked" | "done" | "step1" | "step2" | "step3" | "working" | "success";

const BUSINESS_PAGE = "/business";

function readDraft() {
  try { return decodeDraft(window.sessionStorage.getItem(DRAFT_KEY)); } catch { return null; }
}
function saveDraft(date: string, taxInput: string) {
  try { window.sessionStorage.setItem(DRAFT_KEY, encodeDraft({ date, taxInput })); } catch { /* private mode: the owner retypes */ }
}
function clearDraft() {
  try { window.sessionStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clear */ }
}

export default function KindTransitionPage() {
  useHideShellChrome(true);
  const router = useRouter();
  const [screen, setScreen] = useState<Screen>("loading");
  const [info, setInfo] = useState<KindTransitionInfo | null>(null);
  const [today] = useState(() => israelTodayClient());
  const [date, setDate] = useState("");
  const [taxInput, setTaxInput] = useState("");
  const [taxError, setTaxError] = useState("");
  const [dateError, setDateError] = useState("");
  const [password, setPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [verified, setVerified] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState("");
  const [busy, setBusy] = useState(false);
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [confirmError, setConfirmError] = useState("");
  const [needsReverify, setNeedsReverify] = useState(false);
  const [blockMessage, setBlockMessage] = useState("");
  const [sheet, setSheet] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    const r = await fetchKindTransitionInfo();
    if (r.status === 404) { setScreen("off"); return null; }
    if (!r.info) { setScreen("loadError"); return null; }
    setInfo(r.info);
    return r.info;
  }, []);

  // First load: the server's answer, then (after a Google round-trip) what the owner had typed.
  useEffect(() => {
    let alive = true;
    (async () => {
      const ret = googleReturnOf(window.location.search);
      const i = await load();
      if (!alive || !i) return;
      if (i.history && !i.eligibility.eligible) { setScreen("done"); return; }
      if (!i.eligibility.eligible) { setBlockMessage(i.eligibility.message); setScreen("blocked"); return; }
      if (ret) {
        const d = readDraft();
        window.history.replaceState(null, "", window.location.pathname);
        if (d) { setDate(d.date); setTaxInput(d.taxInput); }
        if (ret === "ok") setVerified(true);
        else setGoogleError(GOOGLE_RETURN_MESSAGES[ret]);
        setScreen(d ? "step2" : "step1");
        return;
      }
      setScreen("step1");
    })();
    return () => { alive = false; };
  }, [load]);

  // Each new screen: move focus to its heading (keyboard and screen reader users land at the top of the step).
  useEffect(() => { headingRef.current?.focus(); }, [screen]);

  const ds = dateState(date, today);
  const stepNo = screen === "step1" ? 1 : screen === "step2" ? 2 : screen === "step3" ? 3 : 0;
  const isGoogle = info?.reauthMethod === "GOOGLE";
  const legalName = info?.identity.legalName ?? "";
  const taxOnFile = info?.identity.taxId ?? "";
  const acknowledgements = info?.acknowledgements ?? [];
  const allAcks = acknowledgements.length > 0 && acknowledgements.every((a) => acks[a.id]);
  const early = ds === "early";
  const input = (acknowledged: string[]) => ({ confirmTaxId: digitsOnly(taxInput), vatNumber: digitsOnly(taxInput), statusEffectiveDate: date, acknowledged });

  const back = () => {
    if (screen === "step2") setScreen("step1");
    else if (screen === "step3") setScreen("step2");
    else router.push(BUSINESS_PAGE);
  };
  const leave = () => { clearDraft(); router.push(BUSINESS_PAGE); };

  // ── step 2 → 3: id number, re-authentication, server-side validation of what was typed so far ──
  const continueFromStep2 = async () => {
    setTaxError(""); setPwError(""); setConfirmError(""); setNeedsReverify(false);
    if (!sameTaxId(taxInput, taxOnFile)) { setTaxError("המספר לא תואם למספר העוסק בתיק."); return; }
    setBusy(true);
    try {
      if (!isGoogle && !verified) {
        const r = await reauthWithPassword(password);
        if (r.status !== 200) {
          setPwError(r.body.code === "INVALID_PASSWORD" ? "הסיסמה שגויה. אפשר לנסות שוב."
            : r.body.code === "SIGN_IN_AGAIN" ? "צריך להתחבר מחדש לדוביז ולנסות שוב."
            : r.body.error || "האימות לא הושלם. אפשר לנסות שוב.");
          return;
        }
        setVerified(true);
        setPassword("");
      }
      const p = await checkIdentity({ confirmTaxId: digitsOnly(taxInput), vatNumber: digitsOnly(taxInput), statusEffectiveDate: date });
      if (p.status === 409) { setBlockMessage(p.body.error || ""); setScreen("blocked"); return; }
      const problems = p.body.problems ?? [];
      if (p.status !== 200 && p.status !== 400) { setPwError("האימות לא הושלם. אפשר לנסות שוב."); return; }
      const taxProblem = problems.find((x) => x.field === "confirmTaxId" || x.field === "vatNumber");
      const dateProblem = problems.find((x) => x.field === "statusEffectiveDate");
      if (taxProblem) { setTaxError(taxProblem.message); return; }
      if (dateProblem) { setDateError(dateProblem.message); setScreen("step1"); return; }
      setScreen("step3");
    } catch {
      setPwError("אין חיבור כרגע. אפשר לנסות שוב.");
    } finally {
      setBusy(false);
    }
  };

  const verifyWithGoogle = async () => {
    setGoogleError(""); setTaxError("");
    if (!sameTaxId(taxInput, taxOnFile)) { setTaxError("המספר לא תואם למספר העוסק בתיק."); return; }
    setGoogleBusy(true);
    try {
      const r = await startGoogleReauth();
      if (r.status !== 200 || !r.body.url) { setGoogleError(r.body.error || GOOGLE_RETURN_MESSAGES.error); return; }
      saveDraft(date, taxInput);
      window.location.assign(String(r.body.url));
    } catch {
      setGoogleError(GOOGLE_RETURN_MESSAGES.error);
    } finally {
      setGoogleBusy(false);
    }
  };

  // ── step 3: the digest of exactly what is confirmed, then the transition ──
  const confirm = async () => {
    setConfirmError(""); setNeedsReverify(false);
    setScreen("working");
    try {
      const ids = acknowledgements.filter((a) => acks[a.id]).map((a) => a.id);
      const p = await previewKindTransition(input(ids));
      const sha = p.body.statementSha256;
      const r = p.status === 200 && sha ? await confirmKindTransition({ ...input(ids), statementSha256: sha }) : p;
      const o = confirmOutcome(r.status, r.body.code, r.body.error);
      if (o.kind === "success") {
        clearDraft();
        await load();
        setScreen("success");
        return;
      }
      if (o.kind === "reverify") { setVerified(false); setNeedsReverify(true); }
      if (o.kind === "restart") { clearDraft(); }
      setConfirmError(o.message);
      setScreen(o.kind === "restart" ? "step1" : "step3");
    } catch {
      setConfirmError("המעבר לא בוצע, ושום דבר לא השתנה. אפשר לנסות שוב בעוד רגע.");
      setScreen("step3");
    }
  };

  const header = (title = "מעבר לעוסק מורשה") => (
    <header className={s.header}>
      <div className={s.headerRow}>
        <button type="button" className={s.iconBtn} aria-label={stepNo > 1 ? "חזרה לשלב הקודם" : "חזרה לפרטי העסק"} onClick={back} data-testid="kt-back">
          <IconBack />
        </button>
        <h1 className={s.headerTitle}>{title}</h1>
        {stepNo > 0 ? <span className={s.stepOf}>שלב {stepNo} מתוך 3</span> : null}
      </div>
      {stepNo > 0 ? (
        <div className={s.progress} aria-hidden="true">
          {[1, 2, 3].map((n) => <span key={n} className={`${s.seg} ${stepNo >= n ? s.segOn : ""}`} />)}
        </div>
      ) : null}
    </header>
  );

  return (
    <div className={s.page} dir="rtl" lang="he">
      <div className={s.column}>
        {/* ── loading / off / error / blocked / already done ── */}
        {screen === "loading" ? (<>{header()}<div className={s.center} role="status"><IconSpinner size={32} className={s.spin} /><span className={s.lead}>טוען…</span></div></>) : null}

        {screen === "off" || screen === "loadError" ? (
          <>{header()}
            <div className={s.body}>
              <h2 ref={headingRef} tabIndex={-1} className={s.h2}>{screen === "off" ? "האפשרות לא זמינה כרגע" : "לא הצלחנו לטעון את הפרטים"}</h2>
              <p className={s.lead}>{screen === "off" ? "מעבר לעוסק מורשה עדיין לא פתוח בחשבון שלכם." : "בדקו את החיבור ונסו שוב."}</p>
              <Link href={BUSINESS_PAGE} className={s.link}>חזרה לפרטי העסק</Link>
            </div>
          </>
        ) : null}

        {screen === "blocked" ? (
          <>{header()}
            <div className={s.body}>
              <h2 ref={headingRef} tabIndex={-1} className={s.h2}>המעבר לא זמין כרגע לעסק הזה</h2>
              <Note tone="info" role="status"><IconInfo /><span data-testid="kt-blocked-message">{blockMessage || "המעבר לא זמין כרגע."}</span></Note>
              <Link href={BUSINESS_PAGE} className={s.link}>חזרה לפרטי העסק</Link>
            </div>
          </>
        ) : null}

        {screen === "done" && info?.history ? (
          <>{header()}
            <div className={s.body}>
              <h2 ref={headingRef} tabIndex={-1} className={s.h2}>העסק כבר עבר לעוסק מורשה</h2>
              <Note tone="ok" role="status"><IconCheck size={18} /><span>עבר לעוסק מורשה ב-{displayInstant(info.history.confirmedAt)}. המעמד ברשות המסים מ-{displayDate(info.history.statusEffectiveDate)}.</span></Note>
              <Link href={BUSINESS_PAGE} className={s.link}>חזרה לפרטי העסק</Link>
            </div>
          </>
        ) : null}

        {/* ── step 1 ── */}
        {screen === "step1" ? (
          <>{header()}
            <main className={s.body}>
              <div>
                <h2 ref={headingRef} tabIndex={-1} className={s.h2}>מה המעבר עושה</h2>
                <p className={s.lead}>המעבר מעדכן את סוג העסק בדוביז לעוסק מורשה — באותו תיק עסק, עם אותם פרטים.</p>
              </div>
              {confirmError ? <Note tone="err" role="alert"><IconAlert size={18} /><span>{confirmError}</span></Note> : null}
              <section className={s.card} aria-labelledby="kt-same">
                <h3 id="kt-same" className={s.cardTitle}>מה נשאר כמו שהוא</h3>
                <ul className={s.list}>
                  <li className={s.li}><IconCheck className={`${s.liIcon} ${s.ok}`} /><span>השם המשפטי<small>{legalName}</small></span></li>
                  <li className={s.li}><IconCheck className={`${s.liIcon} ${s.ok}`} /><span>מספר העוסק<small className={s.ltr}>{taxOnFile}</small></span></li>
                  <li className={s.li}><IconCheck className={`${s.liIcon} ${s.ok}`} /><span>מסמכים שכבר הפקתם<small>נשארים בדיוק כפי שהופקו</small></span></li>
                </ul>
              </section>
              <section className={s.card} aria-labelledby="kt-change">
                <h3 id="kt-change" className={s.cardTitle}>מה משתנה</h3>
                <ul className={s.list}>
                  <li className={s.li}><IconDoc className={`${s.liIcon} ${s.brand}`} /><span>מסמכים חדשים יופקו כעוסק מורשה</span></li>
                  <li className={s.li}><IconPlus className={`${s.liIcon} ${s.brand}`} /><span>אפשר יהיה להפיק חשבונית מס וחשבונית מס-קבלה</span></li>
                  <li className={s.li}><IconPercent className={`${s.liIcon} ${s.brand}`} /><span>במסמכים חדשים יתווסף מע״מ</span></li>
                </ul>
              </section>
              <Note tone="info"><IconInfo /><span>דוביז לא משנה את הרישום ברשות המסים. בצעו את המעבר רק אחרי שנרשמתם שם כעוסק מורשה.</span></Note>
              <div className={s.field}>
                <label htmlFor="kt-date" className={s.label}>מאיזה תאריך אתם עוסק מורשה ברשות המסים?</label>
                <input
                  id="kt-date" type="date" max={today} value={date}
                  onChange={(e) => { setDate(e.target.value); setDateError(""); }}
                  className={`${s.input} ${ds === "future" || ds === "invalid" || dateError ? s.inputError : ""}`}
                  aria-invalid={ds === "future" || ds === "invalid" || Boolean(dateError)}
                  aria-describedby="kt-date-help kt-date-err"
                  data-testid="kt-date"
                />
                <p id="kt-date-help" className={s.help}>התאריך שמופיע באישור הרישום מרשות המסים.</p>
                <div id="kt-date-err" aria-live="polite">
                  {ds === "future" ? <p className={s.err} role="alert"><IconAlert />אפשר לעבור רק מהתאריך שבו המעמד נכנס לתוקף. חזרו לכאן ביום הזה.</p> : null}
                  {ds === "invalid" ? <p className={s.err} role="alert"><IconAlert />התאריך אינו תקין.</p> : null}
                  {dateError && ds !== "future" && ds !== "invalid" ? <p className={s.err} role="alert"><IconAlert />{dateError}</p> : null}
                </div>
              </div>
              {early ? (
                <Note tone="warn" role="status">
                  <IconWarn />
                  <span data-testid="kt-early-warning"><strong>התאריך מוקדם מהיום.</strong> מסמכים שהפקתם מאז {displayDate(date)} כעוסק פטור לא ישתנו. כדאי לבדוק עם רואה החשבון איך לטפל בהם.</span>
                </Note>
              ) : null}
            </main>
            <div className={s.footer}>
              <button type="button" className={s.btnPrimary} disabled={ds !== "today" && ds !== "early"} onClick={() => { setConfirmError(""); setScreen("step2"); }} data-testid="kt-step1-next">המשך</button>
            </div>
          </>
        ) : null}

        {/* ── step 2 ── */}
        {screen === "step2" ? (
          <>{header()}
            <main className={s.body} style={{ gap: 20 }}>
              <div>
                <h2 ref={headingRef} tabIndex={-1} className={s.h2}>אימות זהות</h2>
                <p className={s.lead}>כדי לוודא שזה אתם, נבקש לאמת שני דברים.</p>
              </div>
              <div className={s.field}>
                <label htmlFor="kt-tax" className={s.label}>הקלידו את מספר העוסק שלכם</label>
                <input
                  id="kt-tax" type="text" inputMode="numeric" autoComplete="off" maxLength={11} placeholder="9 ספרות"
                  value={taxInput} onChange={(e) => { setTaxInput(e.target.value); setTaxError(""); }}
                  className={`${s.input} ${s.numberInput} ${taxError ? s.inputError : ""}`}
                  aria-invalid={Boolean(taxError)} aria-describedby="kt-tax-help kt-tax-err"
                  data-testid="kt-tax"
                />
                <p id="kt-tax-help" className={s.help}>המספר שמופיע בפרטי העסק. כך מוודאים שמדובר באותו עסק.</p>
                <div id="kt-tax-err" aria-live="polite">
                  {taxError ? (
                    <p className={s.err} role="alert"><IconAlert /><span>{taxError} <button type="button" className={s.linkBtn} onClick={() => setSheet(true)}>מה עושים?</button></span></p>
                  ) : null}
                </div>
              </div>

              {!isGoogle ? (
                verified ? null : (
                  <div className={s.field}>
                    <label htmlFor="kt-pw" className={s.label}>הסיסמה שלכם בדוביז</label>
                    <input
                      id="kt-pw" type="password" autoComplete="current-password" value={password}
                      onChange={(e) => { setPassword(e.target.value); setPwError(""); }}
                      onKeyDown={(e) => { if (e.key === "Enter" && taxInput && password && !busy) void continueFromStep2(); }}
                      className={`${s.input} ${pwError ? s.inputError : ""}`}
                      aria-invalid={Boolean(pwError)} aria-describedby="kt-pw-err"
                      data-testid="kt-password"
                    />
                    <div id="kt-pw-err" aria-live="polite">{pwError ? <p className={s.err} role="alert"><IconAlert />{pwError}</p> : null}</div>
                    <Link href="/forgot-password" className={s.link}>שכחתי סיסמה</Link>
                  </div>
                )
              ) : (
                <div className={s.field}>
                  <span className={s.label}>אימות עם Google</span>
                  <p className={s.help}>נרשמתם עם Google, לכן האימות נעשה שם. ייפתח מסך של Google, ואחרי האימות תחזרו לכאן.</p>
                  {!verified ? (
                    <button type="button" className={s.btnGoogle} onClick={verifyWithGoogle} disabled={googleBusy} data-testid="kt-google">
                      {googleBusy ? <><IconSpinner className={s.spin} />עוברים ל-Google…</> : <><GoogleMark />אימות עם Google</>}
                    </button>
                  ) : null}
                  {googleError ? <Note tone="err" role="alert"><IconAlert size={18} /><span>{googleError}</span></Note> : null}
                </div>
              )}

              {verified ? (
                <Note tone="ok" role="status"><IconCheck size={18} /><span>{isGoogle ? "אומת עם Google." : "הזהות אומתה."} האימות תקף לכמה דקות — אם תתעכבו, נבקש שוב.</span></Note>
              ) : null}
            </main>
            <div className={s.footer}>
              <button
                type="button" className={s.btnPrimary} onClick={continueFromStep2} data-testid="kt-step2-next"
                disabled={busy || digitsOnly(taxInput).length === 0 || (isGoogle ? !verified : !verified && password.length === 0)}
              >
                {busy ? <><IconSpinner className={s.spin} />בודקים…</> : "המשך"}
              </button>
            </div>
          </>
        ) : null}

        {/* ── step 3 ── */}
        {screen === "step3" ? (
          <>{header()}
            <main className={s.body}>
              <div>
                <h2 ref={headingRef} tabIndex={-1} className={s.h2}>בדיקה ואישור</h2>
                <p className={s.lead}>עברו על הפרטים לפני שמאשרים.</p>
              </div>
              {confirmError ? (
                <Note tone="err" column role="alert">
                  <span data-testid="kt-confirm-error">{confirmError}</span>
                  {needsReverify ? <button type="button" className={s.linkBtn} style={{ alignSelf: "flex-start" }} onClick={() => { setConfirmError(""); setNeedsReverify(false); setScreen("step2"); }} data-testid="kt-reverify">לאימות מחדש</button> : null}
                </Note>
              ) : null}
              <section className={s.card} aria-labelledby="kt-sum">
                <h3 id="kt-sum" className={s.cardTitle}>סיכום</h3>
                <div className={s.row}><span className={s.lbl}>סוג העסק</span><span className={s.val}>עוסק פטור <span className={s.arrow} aria-hidden="true">←</span><span className={s.visuallyHidden}>יהפוך ל</span> <strong className={s.strongBrand}>עוסק מורשה</strong></span></div>
                <div className={s.row}><span className={s.lbl}>שם משפטי</span><span className={s.val}>{legalName}</span></div>
                <div className={s.row}><span className={s.lbl}>מספר עוסק מורשה</span><span className={`${s.val} ${s.ltr}`}>{taxOnFile}</span></div>
                <div className={s.row}><span className={s.lbl}>תחילת המעמד ברשות המסים</span><span className={`${s.val} ${s.ltr}`}>{displayDate(date)}</span></div>
                <div className={s.row}><span className={s.lbl}>העדכון בדוביז</span><span className={s.val}>מיד עם האישור</span></div>
              </section>
              <section className={s.card} aria-labelledby="kt-mean">
                <h3 id="kt-mean" className={s.cardTitle}>מה זה אומר בפועל</h3>
                <ul className={s.list}>
                  <li className={s.li}><IconDoc className={`${s.liIcon} ${s.brand}`} /><span>חשבוניות<small>אפשר להפיק חשבונית מס וחשבונית מס-קבלה. המספור שלהן מתחיל מ-1. מספור הקבלות ממשיך כרגיל.</small></span></li>
                  <li className={s.li}><IconPercent className={`${s.liIcon} ${s.brand}`} /><span>מע״מ<small>במסמכים חדשים יתווסף מע״מ בשיעור הרגיל.</small></span></li>
                  <li className={s.li}><IconLock className={`${s.liIcon} ${s.brand}`} /><span>מסמכים קודמים<small>כל מה שהופק עד היום נשאר כמו שהוא — גם אם מפיקים ממנו PDF שוב.</small></span></li>
                </ul>
              </section>
              {early ? <Note tone="warn"><IconWarn /><span>מסמכים שהופקו כעוסק פטור מאז {displayDate(date)} לא ישתנו — כדאי לבדוק אותם עם רואה החשבון.</span></Note> : null}
              <Note tone="warn"><IconWarn /><span>טיוטות פתוחות בלי מע״מ: אחרי המעבר נבקש לבדוק כל אחת לפני שמפיקים אותה.</span></Note>
              <section className={s.card} aria-labelledby="kt-acks">
                <h3 id="kt-acks" className={s.cardTitle}>אישורים</h3>
                {acknowledgements.map((a) => (
                  <label key={a.id} className={s.ack}>
                    <input type="checkbox" checked={Boolean(acks[a.id])} onChange={(e) => setAcks((p) => ({ ...p, [a.id]: e.target.checked }))} data-testid={`kt-ack-${a.id}`} />
                    <span>{a.text}</span>
                  </label>
                ))}
              </section>
            </main>
            <div className={s.footer}>
              <button type="button" className={s.btnPrimary} onClick={confirm} disabled={!allAcks} data-testid="kt-confirm">אישור ומעבר לעוסק מורשה</button>
              <button type="button" className={s.btnGhost} onClick={leave} data-testid="kt-cancel">ביטול</button>
            </div>
          </>
        ) : null}

        {/* ── working ── */}
        {screen === "working" ? (
          <>{header()}<div className={s.center} role="status" aria-live="polite"><IconSpinner size={40} className={`${s.spin} ${s.brand}`} /><p className={s.lead}>מעדכנים את סוג העסק…</p></div></>
        ) : null}

        {/* ── success ── */}
        {screen === "success" ? (
          <>
            <main className={s.body} style={{ paddingTop: 40, gap: 20 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 12 }}>
                <span className={s.successIcon}><IconCheck size={36} strokeWidth={2.4} /></span>
                <h1 ref={headingRef} tabIndex={-1} className={s.successTitle} data-testid="kt-success">עברתם לעוסק מורשה</h1>
                <p className={s.lead} style={{ maxWidth: 320 }}>מעכשיו מסמכים חדשים יופקו כעוסק מורשה. מה שהופק עד היום נשאר כמו שהוא.</p>
              </div>
              <section className={s.card} aria-labelledby="kt-next">
                <h2 id="kt-next" className={s.cardTitle}>מה עכשיו</h2>
                <ol className={s.list}>
                  <li className={s.li} style={{ alignItems: "center" }}><span className={`${s.stepNum} ${s.stepNumWarn}`}>1</span><span style={{ flex: 1 }}>לבדוק טיוטות פתוחות בלי מע״מ</span><Link href="/billing" className={s.link}>לטיוטות</Link></li>
                  {info?.history && startedBeforeConfirmation(info.history.statusEffectiveDate, info.history.confirmedAt) ? (
                    <li className={s.li} style={{ alignItems: "center" }}><span className={`${s.stepNum} ${s.stepNumWarn}`}>2</span><span style={{ flex: 1 }}>לעבור עם רואה החשבון על המסמכים מאז {displayDate(info.history.statusEffectiveDate)}</span><Link href="/billing" className={s.link}>למסמכים</Link></li>
                  ) : null}
                  <li className={s.li} style={{ alignItems: "center" }}><span className={`${s.stepNum} ${s.stepNumBrand}`}>{info?.history && startedBeforeConfirmation(info.history.statusEffectiveDate, info.history.confirmedAt) ? 3 : 2}</span><span style={{ flex: 1 }}>להפיק חשבונית מס ראשונה</span><Link href="/billing" className={s.link}>להפקה</Link></li>
                </ol>
              </section>
              {info?.history ? (
                <p className={s.help} style={{ textAlign: "center" }}>השינוי נשמר בהיסטוריית העסק: עוסק מורשה מ-{displayInstant(info.history.confirmedAt)} (המעמד ברשות המסים מ-{displayDate(info.history.statusEffectiveDate)}).</p>
              ) : null}
            </main>
            <div className={s.footer}>
              <button type="button" className={s.btnPrimary} onClick={() => router.push(BUSINESS_PAGE)} data-testid="kt-finish">חזרה לפרטי העסק</button>
            </div>
          </>
        ) : null}
      </div>
      <NewFileSheet open={sheet} onClose={() => setSheet(false)} />
    </div>
  );
}
