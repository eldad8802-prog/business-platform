"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CONFIDENCE_LABEL,
  attachBankLine,
  completePreparationFromBankLine,
  dismissBankLine,
  fetchBankAccounts,
  fetchBankLineSuggestions,
  fetchBankLines,
  formatDate,
  formatMoney,
  recordBankLine,
  recordPaymentFromBankLine,
  rejectBankLinePairing,
  revokeBankEvidence,
  uploadBankStatement,
  type BankAccountApi,
  type BankLineApi,
  type BankSuggestionApi,
} from "@/lib/payables/payables-client";
import { PAYABLES_THEME } from "../payables-theme";
import styles from "../payables.module.css";

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const toIso = (date: string) => new Date(`${date}T12:00:00`).toISOString();
const newKey = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const STATE_TEXT: Record<BankLineApi["state"], string> = {
  OPEN: "טרם שויך",
  MATCHED: "משויך לתשלום",
  DISMISSED: "סומן כלא-תשלום לספק",
  NOT_A_PAYABLE: "זיכוי (לא תשלום לספק)",
};

/**
 * Bank lines — what the owner's bank reported. An observation, never a payment:
 * attaching a line to a payment that already exists moves no money; a new
 * payment from a line is an explicit decision; nothing is inferred from an
 * amount alone. There is no bank feed — lines arrive only from the owner.
 */
export default function BankLinesPage() {
  const router = useRouter();
  const [lines, setLines] = useState<BankLineApi[] | null>(null);
  const [accounts, setAccounts] = useState<BankAccountApi[]>([]);
  const [scope, setScope] = useState<"open" | "all">("open");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"none" | "manual" | "upload">("none");
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchBankLines(scope), fetchBankAccounts().then((r) => r.accounts).catch(() => [] as BankAccountApi[])])
      .then(([l, a]) => {
        if (cancelled) return;
        setLines(l);
        setAccounts(a);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "טעינה נכשלה"));
    return () => {
      cancelled = true;
    };
  }, [scope, reloadToken]);

  function changed(message: string) {
    setNotice(message);
    reload();
  }

  return (
    <div className={styles.page} style={PAYABLES_THEME} dir="rtl">
      <button type="button" className={styles.backLink} onClick={() => router.push("/payables")}>
        ← כל ההתחייבויות
      </button>
      <header className={styles.header}>
        <div style={{ minWidth: 0 }}>
          <h1 className={styles.title}>תנועות בנק</h1>
          <p className={styles.subtitle}>מה ירד מהחשבון — ולאיזה תשלום זה שייך.</p>
        </div>
        <div className={styles.toolbar}>
          <button type="button" className={styles.buttonQuiet} onClick={() => setMode(mode === "manual" ? "none" : "manual")}>
            {mode === "manual" ? "סגור" : "הוסף תנועה"}
          </button>
          <button type="button" className={styles.buttonPrimary} onClick={() => setMode(mode === "upload" ? "none" : "upload")}>
            {mode === "upload" ? "סגור" : "העלה דף חשבון (CSV)"}
          </button>
        </div>
      </header>

      <div className={styles.notice}>
        אין חיבור ישיר לבנק. התנועות כאן הן מה שהזנת או העלית. שיוך תנועה לתשלום קיים הוא ראיה בלבד — הוא לא
        רושם תשלום נוסף.
      </div>
      {notice && <div className={styles.notice}>{notice}</div>}
      {error && <div className={styles.error}>{error}</div>}

      {mode === "manual" && <ManualLineForm accounts={accounts} onDone={(m) => { setMode("none"); changed(m); }} />}
      {mode === "upload" && <UploadForm accounts={accounts} onDone={(m) => { setMode("none"); changed(m); }} />}

      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>תנועות</h2>
        <div className={styles.toolbar}>
          <button type="button" className={styles.buttonQuiet} onClick={() => setScope((s) => (s === "open" ? "all" : "open"))}>
            {scope === "open" ? "הצג הכול" : "הצג פתוחות בלבד"}
          </button>
        </div>
      </div>

      {lines === null && !error && <div className={styles.empty}>טוען…</div>}
      {lines !== null && lines.length === 0 && (
        <div className={styles.empty}>{scope === "open" ? "אין תנועות שממתינות לשיוך." : "עוד לא נרשמו תנועות."}</div>
      )}
      {lines !== null && lines.length > 0 && (
        <div className={styles.timeline}>
          {lines.map((l) => (
            <BankLineCard key={l.id} line={l} onChanged={changed} />
          ))}
        </div>
      )}
    </div>
  );
}

function BankLineCard({ line, onChanged }: { line: BankLineApi; onChanged: (m: string) => void }) {
  const [sugs, setSugs] = useState<{ list: BankSuggestionApi[]; ambiguous: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : "הפעולה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.installment}>
      <div className={styles.installmentHead}>
        <span className={styles.installmentSeq}>
          {line.direction === "DEBIT" ? "חיוב" : "זיכוי"} · {formatMoney(line.amount, line.currency)} · {formatDate(line.bookedAt)}
        </span>
        <span className={styles.badges}>
          <span className={`${styles.badge} ${line.state === "MATCHED" ? styles.badgePaid : line.state === "OPEN" ? styles.badgeDue : styles.badgeQuiet}`}>
            {STATE_TEXT[line.state]}
          </span>
        </span>
      </div>
      <span className={styles.nextLine}>
        {[line.counterpartyName, line.description].filter(Boolean).join(" · ") || "ללא תיאור"}
        {line.reference ? <> · אסמכתא <bdi dir="ltr">{line.reference}</bdi></> : null}
        {line.sourceAccount ? <> · <bdi dir="ltr">••••{line.sourceAccount.last4}</bdi></> : null}
      </span>
      {line.matchedPayment && (
        <span className={styles.nextLine}>
          משויך כראיה לתשלום ל{line.matchedPayment.payeeName}. השיוך לא הזיז כסף.
        </span>
      )}
      {error && <div className={styles.error}>{error}</div>}

      {line.state === "OPEN" && (
        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.buttonQuiet}
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await fetchBankLineSuggestions(line.id);
                setSugs({ list: r.suggestions, ambiguous: r.ambiguous });
                return r.suggestions.length ? "הוצגו התאמות אפשריות. ההחלטה שלך." : "לא נמצאה התאמה שאפשר להציע.";
              })
            }
          >
            הצע התאמות
          </button>
          <button
            type="button"
            className={styles.buttonQuiet}
            disabled={busy}
            onClick={() => run(async () => { await dismissBankLine(line.id, "לא תשלום לספק"); return "התנועה סומנה כלא-תשלום לספק."; })}
          >
            לא תשלום לספק
          </button>
        </div>
      )}
      {line.state === "MATCHED" && line.matchedPayment && (
        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.buttonQuiet}
            disabled={busy}
            onClick={() => {
              if (window.confirm("לנתק את התנועה מהתשלום? התשלום עצמו לא ישתנה.")) {
                run(async () => { await revokeBankEvidence(line.matchedPayment!.evidenceId); return "התנועה נותקה. התשלום לא השתנה."; });
              }
            }}
          >
            נתק שיוך
          </button>
        </div>
      )}

      {sugs && sugs.ambiguous && (
        <div className={styles.notice}>יש כמה התאמות שאי אפשר להבדיל ביניהן לפי הנתונים — בחר בעצמך, או אל תשייך.</div>
      )}
      {sugs && sugs.list.map((s) => (
        <div key={`${s.kind}-${s.id}`} className={styles.allocation}>
          <span>
            <strong>{s.kind === "PAYMENT" ? "תשלום קיים" : s.kind === "PREPARATION" ? "תשלום שהוכן" : "תשלום פתוח"}</strong> ·{" "}
            {s.payeeName} · {s.commitmentTitle} · {formatMoney(s.amount)} · {formatDate(s.date)} · {CONFIDENCE_LABEL[s.confidence]} ·{" "}
            {s.reasons.join(", ")}
          </span>
          <span className={styles.formActions}>
            <button
              type="button"
              className={styles.buttonQuiet}
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (s.kind === "PAYMENT") {
                    await attachBankLine(line.id, s.id);
                    return "התנועה שויכה כראיה לתשלום הקיים. לא נרשם תשלום נוסף.";
                  }
                  if (s.kind === "PREPARATION") {
                    await completePreparationFromBankLine(line.id, s.id);
                    return "התשלום שהוכן נרשם כבוצע, לפי התנועה.";
                  }
                  try {
                    await recordPaymentFromBankLine(line.id, { commitmentId: s.commitmentId, installmentId: s.installmentId });
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : "";
                    if (/already recorded/.test(msg) && window.confirm("כבר רשום תשלום בסכום הזה להתחייבות. זה תשלום אחר ונפרד?")) {
                      await recordPaymentFromBankLine(line.id, { commitmentId: s.commitmentId, installmentId: s.installmentId, acknowledgeSimilarPayment: true });
                    } else throw e;
                  }
                  return "נרשם תשלום חדש לפי התנועה.";
                })
              }
            >
              {s.kind === "PAYMENT" ? "זו ראיה לתשלום הזה" : s.kind === "PREPARATION" ? "זה התשלום שהוכן" : "רשום תשלום חדש"}
            </button>
            {s.kind !== "PREPARATION" && (
              <button
                type="button"
                className={styles.buttonQuiet}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await rejectBankLinePairing(line.id, s.kind === "PAYMENT" ? { paymentId: s.id } : { installmentId: s.installmentId ?? s.id });
                    setSugs((cur) => (cur ? { ...cur, list: cur.list.filter((x) => x !== s) } : cur));
                    return "ההתאמה נדחתה ולא תוצע שוב.";
                  })
                }
              >
                לא זה
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function ManualLineForm({ accounts, onDone }: { accounts: BankAccountApi[]; onDone: (m: string) => void }) {
  const [bookedAt, setBookedAt] = useState(todayISO());
  const [amount, setAmount] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [reference, setReference] = useState("");
  const [accountId, setAccountId] = useState<number | null>(accounts.find((a) => a.isActive && a.isDefault)?.id ?? null);
  const [clientKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className={styles.form}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await recordBankLine({ clientKey, bookedAt: toIso(bookedAt), amount, direction: "DEBIT", counterpartyName: counterparty || null, reference: reference || null, sourceBankAccountId: accountId });
          onDone(r.inserted ? "התנועה נרשמה." : "התנועה כבר רשומה — לא נוספה שוב.");
        } catch (err) {
          setError(err instanceof Error ? err.message : "הרישום נכשל");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="bl-date">תאריך</label>
          <input id="bl-date" className={styles.input} type="date" value={bookedAt} max={todayISO()} onChange={(e) => setBookedAt(e.target.value)} required />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="bl-amount">סכום החיוב</label>
          <input id="bl-amount" className={styles.input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>
      </div>
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="bl-cp">לטובת / תיאור</label>
          <input id="bl-cp" className={styles.input} value={counterparty} maxLength={200} onChange={(e) => setCounterparty(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="bl-ref">אסמכתא</label>
          <input id="bl-ref" className={styles.input} dir="ltr" value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} />
        </div>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="bl-acc">מחשבון</label>
        <select id="bl-acc" className={styles.select} value={accountId ?? ""} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">לא לציין</option>
          {accounts.filter((a) => a.isActive).map((a) => (
            <option key={a.id} value={a.id}>{a.label} · {a.masked}</option>
          ))}
        </select>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.formActions}>
        <button type="submit" className={styles.buttonPrimary} disabled={busy}>{busy ? "רושם…" : "רשום תנועה"}</button>
      </div>
    </form>
  );
}

function UploadForm({ accounts, onDone }: { accounts: BankAccountApi[]; onDone: (m: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [accountId, setAccountId] = useState<number | null>(accounts.find((a) => a.isActive && a.isDefault)?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className={styles.form}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text) return;
        setBusy(true);
        setError(null);
        try {
          const r = await uploadBankStatement(text, accountId);
          const skipped = r.errors.length ? ` ${r.errors.length} שורות לא נקראו (${r.errors.slice(0, 5).map((x) => `שורה ${x.lineNumber}`).join(", ")}).` : "";
          onDone(`נקלטו ${r.inserted} תנועות חדשות; ${r.alreadyKnown} כבר היו רשומות.${skipped}`);
        } catch (err) {
          setError(err instanceof Error ? err.message : "ההעלאה נכשלה");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor="bl-file">קובץ CSV מהבנק</label>
        <input
          id="bl-file"
          className={styles.input}
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setFileName(f.name);
            setText(await f.text());
          }}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="bl-uacc">של איזה חשבון</label>
        <select id="bl-uacc" className={styles.select} value={accountId ?? ""} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">לא לציין</option>
          {accounts.filter((a) => a.isActive).map((a) => (
            <option key={a.id} value={a.id}>{a.label} · {a.masked}</option>
          ))}
        </select>
      </div>
      <div className={styles.notice}>
        נדרשות עמודות תאריך וסכום (או חובה/זכות); תיאור ואסמכתא מומלצים. העלאה חוזרת של אותו דף לא תכפיל תנועות.
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.formActions}>
        <button type="submit" className={styles.buttonPrimary} disabled={busy || !text}>
          {busy ? "מעלה…" : fileName ? `העלה את ${fileName}` : "בחר קובץ"}
        </button>
      </div>
    </form>
  );
}
