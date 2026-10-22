"use client";

import { useCallback, useEffect, useState } from "react";
import BackButton from "@/components/ui/back-button";
import { useI18n } from "@/components/i18n/I18nProvider";
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
  const { t } = useI18n();
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
        setError(e instanceof Error ? e.message : t("money.payables.list.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [scope, reloadToken, t]);

  function changed(message: string) {
    setNotice(message);
    reload();
  }

  return (
    <div className={styles.page} style={PAYABLES_THEME}>
      <div className={styles.backRow}>
        <BackButton />
      </div>

      <header className={styles.header}>
        <div style={{ minWidth: 0 }}>
          <h1 className={styles.title}>{t("money.payables.list.chequesAndAccounts")}</h1>
          <p className={styles.subtitle}>{t("money.payables.cheques.page.subtitle")}</p>
        </div>
      </header>

      {notice && <div className={styles.notice}>{notice}</div>}
      {error && (
        <div className={styles.error}>
          {error}
          <div className={styles.formActions}>
            <button type="button" className={styles.buttonQuiet} onClick={reload}>
              {t("money.common.retry")}
            </button>
          </div>
        </div>
      )}

      <div className={styles.work}>
      <section>
      <h2 className={styles.sectionTitle}>{t("money.payables.cheques.page.accountsTitle")}</h2>
      {accounts === null && !error ? (
        <div className={styles.empty}>{t("money.common.loading")}</div>
      ) : (
        accounts && (
          <BankAccountsSection accounts={accounts} configured={configured} onChanged={changed} />
        )
      )}
      </section>
      <section>

      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>{t("money.payables.cheques.page.chequesTitle")}</h2>
        <div className={styles.toolbar}>
          <button
            type="button"
            className={styles.buttonQuiet}
            onClick={() => setScope((s) => (s === "open" ? "all" : "open"))}
          >
            {scope === "open" ? t("money.payables.list.showAll") : t("money.payables.cheques.page.showOpenOnly")}
          </button>
          {accounts && accounts.some((a) => a.isActive) && (
            <button
              type="button"
              className={styles.buttonPrimary}
              onClick={() => setShowForm((v) => !v)}
              aria-expanded={showForm}
            >
              {showForm ? t("money.common.close") : t("money.payables.cheques.page.newCheque")}
            </button>
          )}
        </div>
      </div>

      {showForm && accounts && (
        <>
          <div className={styles.notice}>
            {t("money.payables.cheques.page.commitmentHint")}
          </div>
          <ChequeForm
            accounts={accounts}
            onCreated={(c) => {
              setShowForm(false);
              changed(t("money.payables.cheques.page.recorded", { number: c.chequeNumber }));
            }}
          />
        </>
      )}

      {cheques === null && !error && <div className={styles.empty}>{t("money.common.loading")}</div>}
      {cheques !== null && cheques.length === 0 && (
        <div className={styles.empty}>
          {scope === "open" ? t("money.payables.cheques.page.noneOpen") : t("money.payables.cheques.page.noneYet")}
        </div>
      )}
      {cheques !== null && cheques.length > 0 && accounts && (
        <div className={styles.timeline}>
          {cheques.map((c) => (
            <ChequeCard key={c.id} cheque={c} accounts={accounts} onChanged={changed} />
          ))}
        </div>
      )}
      </section>
      </div>
    </div>
  );
}
