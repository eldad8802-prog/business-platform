"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import BackButton from "@/components/ui/back-button";
import { categoryToneCss } from "@/features/tools/category-tones";
import { redirectToLogin } from "@/lib/client-session";
import {
  ReportRequestError,
  buildReportForm,
  fetchRevenueReports,
  postReport,
  type ConflictDecision,
  type ReportKind,
} from "@/lib/revenue-report-uploads/client";
import type {
  PreviewConflict,
  RevenueReportCommitResult,
  RevenueReportPreview,
  SettlementPreviewRow,
  ZPreviewRow,
} from "@/lib/revenue-sources/uploads/service";
import { KIND_TEXT, REPORTS_CSS, ROUTES, ROW_CODE_TEXT, TENDER_TEXT, WARNING_TEXT, dayText, money } from "./shared";

/**
 * Upload a Z report or a card settlement report — /money/revenue-reports/{z,settlement}/upload. Hebrew only.
 *
 *   1. file      the owner picks the file the source system exports. The file is checked and NOT kept (only its hash).
 *   2. preview   what was read: every report, NEW / already recorded / CONFLICT with one recorded with other numbers.
 *                A conflict is never decided for the owner: no default, the commit is refused without a decision.
 *   3. commit    one transaction; a repeated commit of the same file reports the first outcome.
 *
 * Until a parser for the owner's source system exists, the server answers FORMAT_NOT_SUPPORTED and the screen asks
 * for a sample. While the feature is OFF for the business the API answers 404 and the screen says it is not open.
 */

type Open = "loading" | "open" | "closed" | "signed-out" | "error";

const DECISION_TEXT: Record<ConflictDecision, string> = {
  SKIP: "להשאיר את מה שנקלט ולדלג",
  SUPERSEDE: "לקלוט כגרסה מתוקנת של הדוח שנקלט",
  ADD: "לקלוט כדוח Z נוסף של אותו יום (למשל משמרת שנייה)",
};

const CONFLICT_TEXT: Record<PreviewConflict["conflict"], string> = {
  SAME_Z: "דוח Z זה כבר נקלט עם מספרים אחרים.",
  SAME_DAY: "לקופה הזו כבר נקלט דוח Z אחר לאותו יום, עם מספרים אחרים.",
  SAME_SETTLEMENT: "הזיכוי הזה כבר נקלט עם סכומים אחרים. דוח סליקה לא מתוקן בדוביז — מה שנקלט נשאר.",
};

function messageOf(e: unknown): string {
  if (e instanceof ReportRequestError) {
    if (e.status === 401) return "פג תוקף ההתחברות. יש להתחבר מחדש.";
    if (e.status === 404) return "ההעלאה עדיין לא פתוחה לעסק הזה.";
    return e.serverMessage ?? "משהו השתבש. נסו שוב.";
  }
  return "משהו השתבש. נסו שוב.";
}

export function RevenueReportUploadScreen({ kind }: { kind: ReportKind }) {
  const text = KIND_TEXT[kind];
  const [open, setOpen] = useState<Open>("loading");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<RevenueReportPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<number, ConflictDecision>>({});
  const [result, setResult] = useState<RevenueReportCommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; unsupported: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRevenueReports<{ enabled: ReportKind[] }>()
      .then((r) => !cancelled && setOpen(r.enabled.includes(kind) ? "open" : "closed"))
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ReportRequestError && e.status === 404) setOpen("closed");
        else if (e instanceof ReportRequestError && e.status === 401) setOpen("signed-out");
        else setOpen("error");
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  async function analyze() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setPreview(null);
    try {
      setPreview(await postReport<RevenueReportPreview>(kind, "analyze", buildReportForm({ file })));
      setDecisions({});
    } catch (e) {
      const unsupported = e instanceof ReportRequestError && (e.code === "FORMAT_NOT_SUPPORTED" || e.code === "FORMAT_AMBIGUOUS");
      setError({ text: messageOf(e), unsupported });
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!file || !preview) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await postReport<RevenueReportCommitResult>(kind, "commit", buildReportForm({ file, token: preview.token, decisions })));
    } catch (e) {
      setError({ text: messageOf(e), unsupported: false });
    } finally {
      setBusy(false);
    }
  }

  const conflicts = preview ? (preview.rows as Array<ZPreviewRow | SettlementPreviewRow>).filter((r) => r.status === "CONFLICT") : [];
  const undecided = conflicts.filter((r) => !decisions[r.index]).length;
  const toRecord = preview
    ? preview.counts.new + conflicts.filter((r) => decisions[r.index] === "SUPERSEDE" || decisions[r.index] === "ADD").length
    : 0;
  const step = result ? 3 : preview ? 2 : 1;

  return (
    <main data-page-intent="content" className="dzrr tone-money" dir="rtl">
      <style>{categoryToneCss(".dzrr")}</style>
      <style>{REPORTS_CSS}</style>
      <div className="rwrap">
        <div className="rback">
          <BackButton />
        </div>
        <header className="rhead">
          <h1>{text.upload}</h1>
          <p>{text.what}</p>
        </header>

        <ol className="rsteps" aria-label="שלבים">
          <li className={step === 1 ? "on" : undefined}>1. בחירת קובץ</li>
          <li className={step === 2 ? "on" : undefined}>2. בדיקה ותצוגה מקדימה</li>
          <li className={step === 3 ? "on" : undefined}>3. קליטה</li>
        </ol>

        {open === "loading" ? <div className="rnote" aria-busy="true">בודקים אם ההעלאה פתוחה לעסק…</div> : null}
        {open === "closed" ? <div className="rnote">ההעלאה עדיין לא פתוחה לעסק הזה.</div> : null}
        {open === "error" ? <div className="rerr" role="alert">לא הצלחנו לבדוק כרגע אם ההעלאה פתוחה. רעננו את הדף.</div> : null}
        {open === "signed-out" ? (
          <div className="rerr" role="alert">
            צריך להתחבר כדי להעלות דוחות.{" "}
            <button type="button" className="rbtn" onClick={redirectToLogin}>
              להתחברות
            </button>
          </div>
        ) : null}

        {open === "open" && !result ? (
          <form
            className="rcard"
            onSubmit={(e) => {
              e.preventDefault();
              void analyze();
            }}
          >
            <label className="rlabel" htmlFor="rr-file">
              הקובץ שהמערכת מייצאת
            </label>
            <input
              id="rr-file"
              className="rfile"
              type="file"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
                setResult(null);
                setError(null);
              }}
            />
            <div className="rnote">
              <strong>הקובץ נבדק ולא נשמר בדוביז.</strong> נשמרת רק טביעת אצבע שלו, כדי לזהות אם אותו קובץ הועלה שוב. נקלטים רק
              הדוחות שתאשרו.
              <br />
              זהו <strong>דוח</strong> ולא רישום הכנסה: הוא לא נוסף להכנסות, לא נסכם עם החשבוניות ולא נרשם כתנועת בנק.
            </div>
            <div className="ractions">
              <button type="submit" className="rbtn rbtn-primary" disabled={busy || !file}>
                {busy && !preview ? "בודקים…" : "בדיקת הקובץ"}
              </button>
            </div>
          </form>
        ) : null}

        {error ? (
          error.unsupported ? (
            <div className="rwarn" role="alert">
              <strong>{error.text}</strong>
              <br />
              כדאי לצרף לפנייה את שם המערכת (הקופה או חברת האשראי) ואת הקובץ כפי שהיא מייצאת אותו.
            </div>
          ) : (
            <div className="rerr" role="alert">
              {error.text}
            </div>
          )
        ) : null}

        {preview && !result ? (
          <PreviewSection
            kind={kind}
            preview={preview}
            decisions={decisions}
            setDecision={(i, d) => setDecisions((cur) => ({ ...cur, [i]: d }))}
          />
        ) : null}

        {preview && !result ? (
          <div className="ractions">
            <button
              type="button"
              className="rbtn rbtn-primary"
              disabled={busy || undecided > 0 || (toRecord === 0 && conflicts.length === 0)}
              onClick={() => void commit()}
            >
              {busy
                ? "קולטים…"
                : undecided > 0
                  ? `נותרו ${undecided} החלטות`
                  : toRecord === 0 && conflicts.length === 0
                    ? "אין דוחות חדשים לקליטה"
                    : toRecord === 0
                      ? "אישור ההחלטות"
                      : `קליטת ${toRecord} ${toRecord === 1 ? text.name : text.plural}`}
            </button>
          </div>
        ) : null}

        {result ? (
          <section className="rok" aria-live="polite">
            {result.replayed
              ? `הקובץ הזה כבר נקלט. אז נקלטו ${result.recorded}, ולא נקלט שום דבר נוסף עכשיו.`
              : `נקלטו ${result.recorded} ${result.recorded === 1 ? text.name : text.plural}.` +
                (result.superseded ? ` ${result.superseded} מהם כגרסה מתוקנת.` : "") +
                (result.existing ? ` ${result.existing} כבר היו בדוביז.` : "") +
                (result.skippedByDecision ? ` ${result.skippedByDecision} דולגו לפי בחירתכם.` : "") +
                (result.invalid ? ` ${result.invalid} שורות לא נקראו ולא נקלטו.` : "")}{" "}
            <Link href={ROUTES.list}>לסגירות הקופה ודוחות הסליקה</Link>
          </section>
        ) : null}
      </div>
    </main>
  );
}

function StatusPill({ status }: { status: "NEW" | "EXISTING" | "CONFLICT" }) {
  if (status === "NEW") return <span className="rpill rpill-new">חדש</span>;
  if (status === "EXISTING") return <span className="rpill rpill-existing">כבר בדוביז</span>;
  return <span className="rpill rpill-conflict">סותר דוח שנקלט</span>;
}

function PreviewSection({
  kind,
  preview,
  decisions,
  setDecision,
}: {
  kind: ReportKind;
  preview: RevenueReportPreview;
  decisions: Record<number, ConflictDecision>;
  setDecision: (index: number, d: ConflictDecision) => void;
}) {
  const c = preview.counts;
  return (
    <section aria-label="תצוגה מקדימה" style={{ display: "grid", gap: 14, minWidth: 0 }}>
      <div className="rnote">
        הקובץ זוהה כקובץ של <strong>{preview.parser.label}</strong>.
        {preview.parser.capture === "FILE_EXTRACTED" ? " המספרים חולצו ממסמך (לא מקובץ נתונים), לכן כדאי לבדוק אותם מול הדוח עצמו." : ""}
      </div>
      {preview.previouslyImportedAt ? (
        <div className="rnote">
          הקובץ הזה כבר נקלט ב-{new Date(preview.previouslyImportedAt).toLocaleDateString("he-IL")}. מה שכבר נקלט לא ייקלט שוב.
        </div>
      ) : null}
      <div className="rfigs">
        <div className="rfig"><span>דוחות בקובץ</span><span>{c.reports}</span></div>
        <div className="rfig"><span>חדשים</span><span>{c.new}</span></div>
        <div className="rfig"><span>כבר בדוביז</span><span>{c.existing}</span></div>
        <div className="rfig"><span>סותרים דוח שנקלט</span><span>{c.conflicts}</span></div>
        {c.invalid ? <div className="rfig"><span>שורות שלא נקראו</span><span>{c.invalid}</span></div> : null}
        {c.repeatedInFile ? <div className="rfig"><span>כפולים בקובץ</span><span>{c.repeatedInFile}</span></div> : null}
      </div>

      {c.conflicts > 0 ? (
        <div className="rwarn">
          יש דוחות שסותרים דוח שכבר נקלט. לא נדרוס ולא נדלג בלי החלטה שלכם: בחרו לכל אחד מה לעשות.
        </div>
      ) : null}

      {preview.invalid.length > 0 ? (
        <div className="rcard">
          <h2 className="rlabel">שורות שלא נקראו ולא ייקלטו</h2>
          <ul className="rlist">
            {preview.invalid.map((i, n) => (
              <li key={n} className="rmeta">
                {i.sourceRow ? `שורה ${i.sourceRow}: ` : ""}
                {i.codes.map((code) => ROW_CODE_TEXT[code] ?? "השורה לא נקראה").join(" · ")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ul className="rlist">
        {kind === "z"
          ? (preview.rows as ZPreviewRow[]).map((r) => (
              <li key={r.index} className={`rrow${r.status === "CONFLICT" ? " rrow-conflict" : r.status === "EXISTING" ? " rrow-muted" : ""}`}>
                <div className="rrow-top">
                  <span className="rrow-title">
                    {dayText(r.businessDay)} · קופה <bdi dir="ltr">{r.registerKey}</bdi>
                    {r.zNumber ? <> · Z <bdi dir="ltr">{r.zNumber}</bdi></> : null}
                  </span>
                  <StatusPill status={r.status} />
                </div>
                <div className="rmeta">
                  <span>סה״כ <b>{money(r.totalMinor, r.currency)}</b></span>
                  <span>מכירות {money(r.grossMinor, r.currency)}</span>
                  {r.discountMinor ? <span>הנחות {money(r.discountMinor, r.currency)}</span> : null}
                  {r.refundMinor ? <span>החזרים {money(r.refundMinor, r.currency)}</span> : null}
                  {r.voidMinor ? <span>ביטולים {money(r.voidMinor, r.currency)}</span> : null}
                  <span>מע״מ {money(r.vatMinor, r.currency)}</span>
                  {r.transactionCount !== null ? <span>{r.transactionCount} עסקאות</span> : null}
                </div>
                {r.tenders.length ? (
                  <div className="rmeta">
                    {r.tenders.map((t) => (
                      <span key={`${t.method}|${t.label}`}>
                        {TENDER_TEXT[t.method] ?? t.method}
                        {t.label ? ` (${t.label})` : ""} {money(t.amountMinor, r.currency)}
                      </span>
                    ))}
                  </div>
                ) : null}
                <RowFooter warnings={r.warnings} conflict={r.conflict} index={r.index} decision={decisions[r.index]} setDecision={setDecision} />
              </li>
            ))
          : (preview.rows as SettlementPreviewRow[]).map((r) => (
              <li key={r.index} className={`rrow${r.status === "CONFLICT" ? " rrow-conflict" : r.status === "EXISTING" ? " rrow-muted" : ""}`}>
                <div className="rrow-top">
                  <span className="rrow-title">
                    {dayText(r.valueDate)} · <bdi dir="ltr">{r.acquirer}</bdi>
                  </span>
                  <StatusPill status={r.status} />
                </div>
                <div className="rmeta">
                  <span>נטו <b>{money(r.netMinor, r.currency)}</b></span>
                  <span>ברוטו {money(r.grossMinor, r.currency)}</span>
                  <span>עמלות {money(r.feeMinor, r.currency)}</span>
                  {r.otherDeductionsMinor ? <span>ניכויים {money(r.otherDeductionsMinor, r.currency)}</span> : null}
                  {r.installments ? <span>תשלום {r.installments.number} מתוך {r.installments.count}</span> : null}
                  <span>מזהה <bdi dir="ltr">{r.externalId}</bdi></span>
                </div>
                <RowFooter warnings={r.warnings} conflict={r.conflict} index={r.index} decision={decisions[r.index]} setDecision={setDecision} />
              </li>
            ))}
      </ul>
    </section>
  );
}

function RowFooter({
  warnings,
  conflict,
  index,
  decision,
  setDecision,
}: {
  warnings: string[];
  conflict: PreviewConflict | null;
  index: number;
  decision: ConflictDecision | undefined;
  setDecision: (index: number, d: ConflictDecision) => void;
}) {
  return (
    <>
      {warnings.length ? (
        <div className="rmeta">
          <span className="rpill rpill-info">לתשומת לב</span>
          {warnings.map((w) => WARNING_TEXT[w] ?? w).join(" · ")}
        </div>
      ) : null}
      {conflict ? (
        <fieldset className="rdecide">
          <legend className="rsr">החלטה לדוח {index + 1}</legend>
          <span style={{ flexBasis: "100%" }}>
            {CONFLICT_TEXT[conflict.conflict]} מה שנקלט:{" "}
            {conflict.existingTotals.map((t) => money(t.totalMinor, t.currency)).join(", ")}
          </span>
          {conflict.allowed.map((d) => (
            <label key={d}>
              <input type="radio" name={`rr-d-${index}`} checked={decision === d} onChange={() => setDecision(index, d)} />
              {DECISION_TEXT[d]}
            </label>
          ))}
        </fieldset>
      ) : null}
    </>
  );
}
