"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  fetchBankAccounts,
  fetchCheques,
  type BankAccountApi,
  type ChequeApi,
} from "@/lib/payables/payables-client";
import { PAYABLES_THEME } from "../payables-theme";
import { BankAccountsSection, ChequeCard, ChequeForm } from "../cheque-parts";
import styles from "../payables.module.css";

/**
 * The cheque register and the accounts cheques are drawn on.
 *
 * Bank accounts appear here only as a label and four digits — that is all the
 * server ever returns. Cheques are listed by due date; "open" means not yet
 * settled either way (cleared, cancelled, replaced).
 */
export default function ChequesPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<BankAccountApi[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [cheques, setCheques] = useState<ChequeApi[] | null>(null);
  const [scope, setScope] = useState<"open" | "all">("open");
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchBankAccounts(true), fetchCheques({ scope })])
      .then(([bank, list]) => {
        if (cancelled) return;
        setAccounts(bank.accounts);
        setConfigured(bank.configured);
        setCheques(list);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "טעינה נכשלה");
      });
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
          <h1 className={styles.title}>צ׳קים וחשבונות בנק</h1>
          <p className={styles.subtitle}>אילו צ׳קים נכתבו, מאיזה חשבון, ומה מצבם.</p>
        </div>
      </header>

      {notice && <div className={styles.notice}>{notice}</div>}
      {error && (
        <div className={styles.error}>
          {error}
          <div className={styles.formActions}>
            <button type="button" className={styles.buttonQuiet} onClick={reload}>
              נסה שוב
            </button>
          </div>
        </div>
      )}

      <h2 className={styles.sectionTitle}>חשבונות הבנק של העסק</h2>
      {accounts === null && !error ? (
        <div className={styles.empty}>טוען…</div>
      ) : (
        accounts && (
          <BankAccountsSection accounts={accounts} configured={configured} onChanged={changed} />
        )
      )}

      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>צ׳קים</h2>
        <div className={styles.toolbar}>
          <button
            type="button"
            className={styles.buttonQuiet}
            onClick={() => setScope((s) => (s === "open" ? "all" : "open"))}
          >
            {scope === "open" ? "הצג הכול" : "הצג פתוחים בלבד"}
          </button>
          {accounts && accounts.some((a) => a.isActive) && (
            <button
              type="button"
              className={styles.buttonPrimary}
              onClick={() => setShowForm((v) => !v)}
              aria-expanded={showForm}
            >
              {showForm ? "סגור" : "צ׳ק חדש"}
            </button>
          )}
        </div>
      </div>

      {showForm && accounts && (
        <>
          <div className={styles.notice}>
            צ׳ק שנכתב עבור התחייבות מסוימת כדאי לרשום מתוך עמוד ההתחייבות, כדי שייספר עליה
            כשייפרע.
          </div>
          <ChequeForm
            accounts={accounts}
            onCreated={(c) => {
              setShowForm(false);
              changed(`צ׳ק #${c.chequeNumber} נרשם.`);
            }}
          />
        </>
      )}

      {cheques === null && !error && <div className={styles.empty}>טוען…</div>}
      {cheques !== null && cheques.length === 0 && (
        <div className={styles.empty}>
          {scope === "open" ? "אין צ׳קים פתוחים." : "עוד לא נרשמו צ׳קים."}
        </div>
      )}
      {cheques !== null && cheques.length > 0 && accounts && (
        <div className={styles.timeline}>
          {cheques.map((c) => (
            <ChequeCard key={c.id} cheque={c} accounts={accounts} onChanged={changed} />
          ))}
        </div>
      )}
    </div>
  );
}
