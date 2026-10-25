"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import BackButton from "@/components/ui/back-button";
import { fetchBankAccounts, type BankAccountApi } from "@/lib/payables/payables-client";
import { PAYABLES_THEME } from "../../payables-theme";
import styles from "../../payables.module.css";
import own from "./bank-import.module.css";

/**
 * Bank file import (revenue truth milestone B1) — upload a bank statement as CSV or Excel, see exactly what
 * it holds and what is new, then confirm. Behind the bank_file_import flag: every /api/payables/bank-import
 * route answers 404 while it is OFF, and this screen then says so. Hebrew only (owner decision, 2026-10-22).
 *
 * Nothing is written until the owner confirms; a line Dubiz already holds (from this screen or from the
 * statement upload on the bank lines screen) is never written twice.
 */

type Field = "date" | "valueDate" | "amount" | "debit" | "credit" | "description" | "reference" | "counterparty" | "balance";
type Mapping = Partial<Record<Field, number>>;

/** The header was found but the required columns were not all recognised: the owner completes the mapping. */
type MappingRequired = {
  status: "MAPPING_REQUIRED";
  headers: string[];
  mapping: Mapping;
  lockedFields: Field[];
  ambiguous: Field[];
  missing: Array<"date" | "amount">;
  problem: string | null;
  field: Field | null;
  samples: string[][];
};

type Preview = {
  status: "READY";
  token: string;
  headers: string[];
  mapping: Mapping;
  lockedFields: Field[];
  ambiguous: Field[];
  counts: { lines: number; new: number; existing: number; suspected: number; invalid: number; repeatedInFile: number; warnings: number };
  newTotals: { currency: "ILS"; creditMinor: number; debitMinor: number };
  dateRange: { from: string; to: string } | null;
  balance: { status: "NOT_AVAILABLE" } | { status: "OK"; checked: number } | { status: "BROKEN"; checked: number; breaks: number[] };
  errors: Array<{ rowNumber: number; field: string }>;
  warnings: Array<{ rowNumber: number; field: string }>;
  previouslyImportedAt: string | null;
  suspected: PreviewLine[];
  lines: PreviewLine[];
  truncatedLines: boolean;
};

type PreviewLine = {
    rowNumber: number;
    status: "NEW" | "EXISTING" | "SUSPECTED";
    bookedAt: string;
    valueDate: string | null;
    direction: "DEBIT" | "CREDIT";
    amountMinor: number;
    description: string | null;
    reference: string | null;
    counterpartyName: string | null;
    balanceMinor: number | null;
};

type Decision = "IMPORT" | "SKIP";
type CommitResult = {
  replayed: boolean;
  inserted: number;
  existing: number;
  suspectedImported: number;
  suspectedSkipped: number;
  invalid: number;
  committedAt: string;
};

const FIELD_LABEL: Record<Field, string> = {
  date: "תאריך",
  valueDate: "תאריך ערך",
  amount: "סכום (חיובי / שלילי)",
  debit: "חובה",
  credit: "זכות",
  description: "תיאור",
  reference: "אסמכתא",
  counterparty: "שם / מוטב",
  balance: "יתרה",
};
const FIELDS: Field[] = ["date", "valueDate", "amount", "debit", "credit", "description", "reference", "counterparty", "balance"];

const ROW_FIELD: Record<string, string> = { date: "תאריך", amount: "סכום", valueDate: "תאריך ערך", balance: "יתרה" };

const ERROR_TEXT: Record<string, string> = {
  FILE_UNREADABLE: "לא הצלחנו לקרוא את הקובץ. שמרו אותו כ-CSV או כ-Excel (XLSX) ונסו שוב.",
  HEADER_NOT_FOUND: "לא מצאנו בקובץ טבלת תנועות עם שורת כותרות. בדקו שזה קובץ התנועות שהבנק מייצא, ולא קובץ אחר.",
  MAPPING_INVALID: "שיוך העמודות לא תקין. חייבים תאריך, וסכום או חובה / זכות, וכל עמודה פעם אחת.",
  TOO_MANY_LINES: "בקובץ יותר מדי תנועות. פצלו אותו לתקופות קצרות יותר.",
  NO_LINES: "לא נמצאו תנועות בקובץ.",
  ACCOUNT_REQUIRED: "בחרו לאיזה חשבון בנק שייך הקובץ.",
  ACCOUNT_NOT_FOUND: "חשבון הבנק לא נמצא. רעננו את הדף ובחרו שוב.",
  TOKEN_INVALID: "הבדיקה פגה או לא תקפה. בדקו את הקובץ שוב לפני הקליטה.",
  FILE_CHANGED: "הקובץ או השיוך השתנו מאז הבדיקה. בדקו את הקובץ שוב לפני הקליטה.",
  DECISIONS_REQUIRED: "יש תנועות שאולי כבר קיימות ועדיין לא החלטתם עליהן. בחרו לכל אחת אם לקלוט או לדלג.",
  DECISIONS_INVALID: "מאז הבדיקה השתנו התנועות שאולי כבר קיימות. בדקו את הקובץ שוב.",
};

const money = (minor: number) =>
  new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", minimumFractionDigits: 2 }).format(minor / 100);
const date = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

async function send(path: string, file: File, accountId: number, mapping: Mapping | null, token?: string, decisions?: Record<number, Decision>) {
  const body = new FormData();
  body.set("file", file);
  body.set("accountId", String(accountId));
  if (mapping) body.set("mapping", JSON.stringify(mapping));
  if (token) body.set("token", token);
  if (decisions && Object.keys(decisions).length) body.set("decisions", JSON.stringify(decisions));
  const res = await fetch(path, { method: "POST", body, credentials: "same-origin" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof json.error === "string" ? json.error : "";
    throw new Error(res.status === 404 ? "הקליטה עדיין לא פתוחה לעסק הזה." : ERROR_TEXT[code] ?? "משהו השתבש. נסו שוב.");
  }
  return json;
}

export default function BankImportPage() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<BankAccountApi[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [needsMapping, setNeedsMapping] = useState<MappingRequired | null>(null);
  const [draft, setDraft] = useState<Mapping>({});
  const [result, setResult] = useState<CommitResult | null>(null);
  // No default: a suspected line is imported or skipped only when the owner says so.
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/payables/bank-import", { credentials: "same-origin" })
      .then((r) => !cancelled && setEnabled(r.ok))
      .catch(() => !cancelled && setEnabled(false));
    fetchBankAccounts()
      .then((r) => {
        if (cancelled) return;
        const active = r.accounts.filter((a) => a.isActive);
        setAccounts(active);
        const preferred = active.find((a) => a.isDefault) ?? (active.length === 1 ? active[0] : null);
        if (preferred) setAccountId(preferred.id);
      })
      .catch(() => !cancelled && setAccounts([]));
    return () => {
      cancelled = true;
    };
  }, []);

  async function analyze(nextMapping: Mapping | null) {
    if (!file || !accountId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const p = (await send("/api/payables/bank-import/analyze", file, accountId, nextMapping)) as Preview | MappingRequired;
      if (p.status === "MAPPING_REQUIRED") {
        setNeedsMapping(p);
        setDraft(p.mapping);
        setPreview(null);
        setMapping(nextMapping);
        return;
      }
      setNeedsMapping(null);
      setPreview(p);
      setDecisions({});
      setMapping(nextMapping);
    } catch (e) {
      setError(e instanceof Error ? e.message : "משהו השתבש. נסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!file || !accountId || !preview) return;
    setBusy(true);
    setError(null);
    try {
      setResult((await send("/api/payables/bank-import/commit", file, accountId, mapping, preview.token, decisions)) as CommitResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "משהו השתבש. נסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  function changeField(field: Field, value: string) {
    if (!preview) return;
    const next: Mapping = { ...(mapping ?? {}) };
    if (value === "") next[field] = null as unknown as number;
    else next[field] = Number(value);
    void analyze(next);
  }

  // A complete draft, sent as an explicit mapping (unset fields as null), for the server to check again.
  function submitDraft() {
    const next: Mapping = {};
    for (const f of FIELDS) next[f] = (draft[f] ?? null) as unknown as number;
    void analyze(next);
  }

  const step = result ? 3 : preview ? 2 : 1;
  const undecided = preview ? preview.suspected.filter((l) => !decisions[l.rowNumber]).length : 0;
  const toImport = preview ? preview.counts.new + preview.suspected.filter((l) => decisions[l.rowNumber] === "IMPORT").length : 0;
  const decideAll = (d: Decision) => {
    if (preview) setDecisions(Object.fromEntries(preview.suspected.map((l) => [l.rowNumber, d])));
  };

  return (
    <div className={styles.page} style={PAYABLES_THEME}>
      <div className={styles.backRow}>
        <BackButton />
      </div>
      <header className={styles.header}>
        <div style={{ minWidth: 0 }}>
          <h1 className={styles.title}>קליטת קובץ בנק</h1>
          <p className={styles.subtitle}>מעלים את קובץ התנועות שהבנק מייצא, רואים מה חדש, ורק אז קולטים.</p>
        </div>
      </header>

      <ol className={own.steps} aria-label="שלבים">
        <li className={step === 1 ? own.stepOn : undefined}>1. חשבון וקובץ</li>
        <li className={step === 2 ? own.stepOn : undefined}>2. בדיקה ותצוגה מקדימה</li>
        <li className={step === 3 ? own.stepOn : undefined}>3. קליטה</li>
      </ol>

      {enabled === false && <div className={styles.notice}>הקליטה עדיין לא פתוחה לעסק הזה.</div>}

      {enabled && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void analyze(null);
          }}
        >
          <div className={styles.field}>
            <label className={styles.label} htmlFor="bi-account">חשבון הבנק של הקובץ</label>
            <select
              id="bi-account"
              className={styles.select}
              value={accountId ?? ""}
              onChange={(e) => {
                setAccountId(e.target.value ? Number(e.target.value) : null);
                setPreview(null);
                setNeedsMapping(null);
                setResult(null);
              }}
            >
              <option value="">בחרו חשבון</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.label} · {a.masked}</option>
              ))}
            </select>
            {accounts.length === 0 && (
              <span className={styles.subtitle}>
                אין עדיין חשבון בנק בדוביז. מוסיפים אותו במסך <Link href="/payables/cheques">המחאות</Link>, בחלק חשבונות הבנק.
              </span>
            )}
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="bi-file">קובץ התנועות (CSV או Excel)</label>
            <input
              id="bi-file"
              className={styles.input}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
                setNeedsMapping(null);
                setResult(null);
                setMapping(null);
              }}
            />
          </div>
          <div className={styles.notice}>
            הקובץ נבדק ולא נשמר. נשמרות רק התנועות שתאשרו. תנועה שכבר נמצאת בדוביז, גם אם הועלתה במסך תנועות הבנק, לא תיקלט פעמיים.
          </div>
          <div className={styles.formActions}>
            <button type="submit" className={styles.buttonPrimary} disabled={busy || !file || !accountId}>
              {busy && !preview ? "בודקים…" : "בדיקת הקובץ"}
            </button>
          </div>
        </form>
      )}

      {error && <div className={styles.error} role="alert">{error}</div>}

      {needsMapping && !preview && !result && (
        <section aria-label="שיוך עמודות" style={{ display: "grid", gap: 12, minWidth: 0 }}>
          <div className={styles.notice}>
            לא זיהינו לבד את כל העמודות בקובץ. בחרו לכל שדה את העמודה המתאימה. חובה לבחור תאריך, ואת הסכום: עמודה אחת עם סכום
            חיובי ושלילי, או עמודות נפרדות של חובה וזכות. אל תבחרו עמודת יתרה או עמלה בתור הסכום.
          </div>
          {needsMapping.problem && <div className={styles.error}>השיוך לא תקין: כל עמודה יכולה להיות משויכת לשדה אחד בלבד. בדקו את הבחירות.</div>}
          {needsMapping.ambiguous.length > 0 && (
            <div className={styles.notice}>
              יותר מעמודה אחת יכולה להתאים ל: {needsMapping.ambiguous.map((f) => FIELD_LABEL[f]).join(", ")}. בחרו את הנכונה.
            </div>
          )}
          <div className={own.mapping}>
            {FIELDS.map((f) => {
              const locked = needsMapping.lockedFields.includes(f);
              const isMissing = (f === "date" && needsMapping.missing.includes("date")) || (f === "amount" && needsMapping.missing.includes("amount"));
              return (
                <div className={styles.field} key={f}>
                  <label className={styles.label} htmlFor={`bi-req-${f}`}>
                    {FIELD_LABEL[f]}{isMissing ? " (חובה)" : ""}
                  </label>
                  <select
                    id={`bi-req-${f}`}
                    className={styles.select}
                    value={draft[f] ?? ""}
                    disabled={busy || locked}
                    onChange={(e) => setDraft((d) => {
                      const next = { ...d };
                      if (e.target.value === "") delete next[f];
                      else next[f] = Number(e.target.value);
                      return next;
                    })}
                  >
                    <option value="">לא בקובץ</option>
                    {needsMapping.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {(h || `עמודה ${i + 1}`) + (needsMapping.samples[i]?.length ? ` (למשל: ${needsMapping.samples[i].join(", ")})` : "")}
                      </option>
                    ))}
                  </select>
                  {locked && <span className={own.lockNote}>קבוע: כך גם מסך תנועות הבנק קורא את הקובץ</span>}
                </div>
              );
            })}
          </div>
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.buttonPrimary}
              disabled={busy || draft.date === undefined || (draft.amount === undefined && draft.debit === undefined && draft.credit === undefined)}
              onClick={submitDraft}
            >
              {busy ? "בודקים…" : "בדיקת הקובץ עם השיוך הזה"}
            </button>
          </div>
        </section>
      )}

      {preview && !result && (
        <section aria-label="תצוגה מקדימה" style={{ display: "grid", gap: 14, minWidth: 0 }}>
          {preview.previouslyImportedAt && (
            <div className={styles.notice}>
              הקובץ הזה כבר נקלט ב-{new Date(preview.previouslyImportedAt).toLocaleDateString("he-IL")}. התנועות שכבר נקלטו לא ייקלטו שוב.
            </div>
          )}

          <div className={styles.figures}>
            <div className={styles.figure}><span className={styles.figureLabel}>תנועות בקובץ</span><span className={styles.figureValue}>{preview.counts.lines}</span></div>
            <div className={styles.figure}><span className={styles.figureLabel}>חדשות</span><span className={styles.figureValue}>{preview.counts.new}</span></div>
            <div className={styles.figure}><span className={styles.figureLabel}>כבר בדוביז</span><span className={styles.figureValue}>{preview.counts.existing}</span></div>
            {preview.counts.suspected > 0 && (
              <div className={styles.figure}><span className={styles.figureLabel}>אולי כבר קיימות</span><span className={styles.figureValue}>{preview.counts.suspected}</span></div>
            )}
            <div className={styles.figure}><span className={styles.figureLabel}>שורות שלא נקראו</span><span className={styles.figureValue}>{preview.counts.invalid}</span></div>
            {preview.dateRange && (
              <div className={styles.figure}><span className={styles.figureLabel}>תקופה</span><span className={styles.figureValue}>{date(preview.dateRange.from)} – {date(preview.dateRange.to)}</span></div>
            )}
            <div className={styles.figure}><span className={styles.figureLabel}>זכות בתנועות החדשות</span><span className={styles.figureValue}>{money(preview.newTotals.creditMinor)}</span></div>
            <div className={styles.figure}><span className={styles.figureLabel}>חובה בתנועות החדשות</span><span className={styles.figureValue}>{money(preview.newTotals.debitMinor)}</span></div>
          </div>

          {preview.counts.repeatedInFile > 0 && (
            <div className={styles.notice}>
              {preview.counts.repeatedInFile} תנועות זהות לתנועה אחרת באותו יום בקובץ. הן נשמרות כתנועות נפרדות, כמו שהבנק הציג אותן.
            </div>
          )}

          {preview.balance.status === "OK" && <div className={styles.notice}>היתרות בקובץ מסתדרות שורה אחרי שורה. לא חסרה תנועה.</div>}
          {preview.balance.status === "BROKEN" && (
            <div className={styles.error}>
              היתרה לא מסתדרת בשורות {preview.balance.breaks.slice(0, 10).join(", ")}. ייתכן שחסרה תנועה או שהקובץ חלקי. בדקו מול הבנק לפני הקליטה.
            </div>
          )}

          {preview.suspected.length > 0 && (
            <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
              <h2 className={styles.sectionTitle}>תנועות שאולי כבר קיימות</h2>
              <div className={styles.notice}>
                בעבר הועלה במסך תנועות הבנק קובץ בלי לבחור חשבון, ובו תנועות זהות לאלה: אותו תאריך, סכום, תיאור ואסמכתא.
                אין לנו דרך לדעת אם זו אותה תנועה, או תנועה אמיתית נוספת מחשבון אחר (למשל אותה עמלה באותו יום).
                החליטו לכל תנועה אם לקלוט אותה או לדלג עליה. לא נקלוט ולא נדלג בלי החלטה שלכם.
              </div>
              <div className={styles.toolbar}>
                <button type="button" className={styles.button} disabled={busy} onClick={() => decideAll("IMPORT")}>קליטת כולן</button>
                <button type="button" className={styles.button} disabled={busy} onClick={() => decideAll("SKIP")}>דילוג על כולן</button>
              </div>
              <div className={own.tableWrap}>
                <table className={own.table}>
                  <thead>
                    <tr><th>שורה</th><th>תאריך</th><th>סכום</th><th>תיאור</th><th>אסמכתא</th><th>החלטה</th></tr>
                  </thead>
                  <tbody>
                    {preview.suspected.map((l) => (
                      <tr key={"s" + l.rowNumber}>
                        <td>{l.rowNumber}</td>
                        <td>{date(l.bookedAt)}</td>
                        <td className={l.direction === "CREDIT" ? own.credit : undefined}>{l.direction === "CREDIT" ? "+" : "−"}{money(l.amountMinor)}</td>
                        <td className={own.wrapText}>{l.description ?? ""}</td>
                        <td>{l.reference ?? ""}</td>
                        <td>
                          <fieldset className={own.decision}>
                            <legend className={styles.srOnly}>החלטה לשורה {l.rowNumber}</legend>
                            <label>
                              <input type="radio" name={"d" + l.rowNumber} checked={decisions[l.rowNumber] === "IMPORT"} onChange={() => setDecisions((d) => ({ ...d, [l.rowNumber]: "IMPORT" }))} /> לקלוט
                            </label>
                            <label>
                              <input type="radio" name={"d" + l.rowNumber} checked={decisions[l.rowNumber] === "SKIP"} onChange={() => setDecisions((d) => ({ ...d, [l.rowNumber]: "SKIP" }))} /> לדלג
                            </label>
                          </fieldset>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {undecided > 0 && <p className={styles.subtitle}>נותרו {undecided} תנועות בלי החלטה.</p>}
            </div>
          )}

          {preview.ambiguous.length > 0 && (
            <div className={styles.notice}>
              שימו לב: בקובץ יותר מעמודה אחת שיכולה להתאים ל: {preview.ambiguous.map((f) => FIELD_LABEL[f]).join(", ")}. בדקו בשיוך
              העמודות שנבחרה העמודה הנכונה לפני הקליטה.
            </div>
          )}

          <div>
            <h2 className={styles.sectionTitle}>שיוך עמודות</h2>
            <div className={own.mapping}>
              {FIELDS.map((f) => {
                const locked = preview.lockedFields.includes(f);
                return (
                  <div className={styles.field} key={f}>
                    <label className={styles.label} htmlFor={`bi-map-${f}`}>{FIELD_LABEL[f]}</label>
                    <select
                      id={`bi-map-${f}`}
                      className={styles.select}
                      value={preview.mapping[f] ?? ""}
                      disabled={busy || locked}
                      onChange={(e) => changeField(f, e.target.value)}
                    >
                      <option value="">לא בקובץ</option>
                      {preview.headers.map((h, i) => (
                        <option key={i} value={i}>{h || `עמודה ${i + 1}`}</option>
                      ))}
                    </select>
                    {locked && <span className={own.lockNote}>קבוע: כך גם מסך תנועות הבנק קורא את הקובץ</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {(preview.errors.length > 0 || preview.warnings.length > 0) && (
            <div>
              <h2 className={styles.sectionTitle}>שורות שדורשות תשומת לב</h2>
              <ul className={own.problems}>
                {preview.errors.slice(0, 20).map((e) => (
                  <li key={`e${e.rowNumber}${e.field}`}>שורה {e.rowNumber}: {ROW_FIELD[e.field] ?? e.field} לא נקרא. השורה לא תיקלט.</li>
                ))}
                {preview.warnings.slice(0, 20).map((w) => (
                  <li key={`w${w.rowNumber}${w.field}`}>שורה {w.rowNumber}: {ROW_FIELD[w.field] ?? w.field} לא נקרא. התנועה תיקלט בלעדיו.</li>
                ))}
              </ul>
              <p className={styles.subtitle}>מספרי השורות סופרים את השורות שאינן ריקות בקובץ.</p>
            </div>
          )}

          <div className={own.tableWrap}>
            <table className={own.table}>
              <thead>
                <tr>
                  <th>שורה</th><th>מצב</th><th>תאריך</th><th>תאריך ערך</th><th>סכום</th><th>תיאור</th><th>אסמכתא</th><th>יתרה</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((l) => (
                  <tr key={l.rowNumber}>
                    <td>{l.rowNumber}</td>
                    <td>
                      <span className={`${styles.badge} ${l.status === "NEW" ? styles.badgePaid : l.status === "SUSPECTED" ? styles.badgeDue : styles.badgeQuiet}`}>
                        {l.status === "NEW" ? "חדשה" : l.status === "SUSPECTED" ? "אולי כבר קיימת" : "כבר בדוביז"}
                      </span>
                    </td>
                    <td>{date(l.bookedAt)}</td>
                    <td>{l.valueDate ? date(l.valueDate) : ""}</td>
                    <td className={l.direction === "CREDIT" ? own.credit : undefined}>
                      {l.direction === "CREDIT" ? "+" : "−"}{money(l.amountMinor)}
                    </td>
                    <td className={own.wrapText}>{l.description ?? ""}</td>
                    <td>{l.reference ?? ""}</td>
                    <td>{l.balanceMinor === null ? "" : money(l.balanceMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.truncatedLines && <p className={styles.subtitle}>מוצגות {preview.lines.length} התנועות הראשונות.</p>}

          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.buttonPrimary}
              disabled={busy || undecided > 0 || (toImport === 0 && preview.suspected.length === 0)}
              onClick={() => void commit()}
            >
              {busy
                ? "קולטים…"
                : undecided > 0
                  ? "החליטו על התנועות שאולי כבר קיימות"
                  : toImport === 0 && preview.suspected.length === 0
                    ? "אין תנועות חדשות לקליטה"
                    : `קליטת ${toImport} תנועות`}
            </button>
          </div>
        </section>
      )}

      {result && (
        <section className={styles.notice} aria-live="polite">
          {result.replayed
            ? `הקובץ הזה כבר נקלט. אז נקלטו ${result.inserted} תנועות חדשות, ולא נקלט שום דבר נוסף עכשיו.`
            : `נקלטו ${result.inserted} תנועות. ${result.existing} לא נקלטו${result.suspectedSkipped ? `, מהן ${result.suspectedSkipped} שבחרתם לדלג עליהן` : " כי כבר היו בדוביז"}.`}{" "}
          <Link href="/payables/bank">למסך תנועות הבנק</Link>
        </section>
      )}
    </div>
  );
}
