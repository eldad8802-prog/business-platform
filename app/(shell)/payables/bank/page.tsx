"use client";

import { useCallback, useEffect, useState } from "react";
import BackButton from "@/components/ui/back-button";
import { useI18n } from "@/components/i18n/I18nProvider";
import {
  confidenceLabel,
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


/**
 * Bank lines — what the owner's bank reported. An observation, never a payment:
 * attaching a line to a payment that already exists moves no money; a new
 * payment from a line is an explicit decision; nothing is inferred from an
 * amount alone. There is no bank feed — lines arrive only from the owner.
 */
export default function BankLinesPage() {
  const { t } = useI18n();
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
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : t("money.payables.list.loadFailed")));
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
          <h1 className={styles.title}>{t("money.payables.list.bankLines")}</h1>
          <p className={styles.subtitle}>{t("money.payables.bank.subtitle")}</p>
        </div>
        <div className={styles.toolbar}>
          <button type="button" className={styles.buttonQuiet} onClick={() => setMode(mode === "manual" ? "none" : "manual")}>
            {mode === "manual" ? t("money.common.close") : t("money.payables.bank.addLine")}
          </button>
          <button type="button" className={styles.buttonPrimary} onClick={() => setMode(mode === "upload" ? "none" : "upload")}>
            {mode === "upload" ? t("money.common.close") : t("money.payables.bank.upload")}
          </button>
        </div>
      </header>

      <div className={styles.work}>
      <section>
      <div className={styles.notice}>
        {t("money.payables.bank.noFeed")}
      </div>
      {notice && <div className={styles.notice}>{notice}</div>}
      {error && <div className={styles.error}>{error}</div>}

      {mode === "manual" && <ManualLineForm accounts={accounts} onDone={(m) => { setMode("none"); changed(m); }} />}
      {mode === "upload" && <UploadForm accounts={accounts} onDone={(m) => { setMode("none"); changed(m); }} />}
      </section>
      <section>

      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>{t("money.payables.bank.linesTitle")}</h2>
        <div className={styles.toolbar}>
          <button type="button" className={styles.buttonQuiet} onClick={() => setScope((s) => (s === "open" ? "all" : "open"))}>
            {scope === "open" ? t("money.payables.list.showAll") : t("money.payables.list.showOpenOnly")}
          </button>
        </div>
      </div>

      {lines === null && !error && <div className={styles.empty}>{t("money.common.loading")}</div>}
      {lines !== null && lines.length === 0 && (
        <div className={styles.empty}>{scope === "open" ? t("money.payables.bank.noneOpen") : t("money.payables.bank.noneYet")}</div>
      )}
      {lines !== null && lines.length > 0 && (
        <div className={styles.timeline}>
          {lines.map((l) => (
            <BankLineCard key={l.id} line={l} onChanged={changed} />
          ))}
        </div>
      )}
      </section>
      </div>
    </div>
  );
}

function BankLineCard({ line, onChanged }: { line: BankLineApi; onChanged: (m: string) => void }) {
  const { t, locale } = useI18n();
  const [sugs, setSugs] = useState<{ list: BankSuggestionApi[]; ambiguous: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : t("money.common.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.installment}>
      <div className={styles.installmentHead}>
        <span className={styles.installmentSeq}>
          {line.direction === "DEBIT" ? t("money.payables.bank.debit") : t("money.payables.bank.credit")} · {formatMoney(line.amount, line.currency, locale)} ·{" "}
          {formatDate(line.bookedAt, locale)}
        </span>
        <span className={styles.badges}>
          <span className={`${styles.badge} ${line.state === "MATCHED" ? styles.badgePaid : line.state === "OPEN" ? styles.badgeDue : styles.badgeQuiet}`}>
            {t(`money.payables.bank.state.${line.state}`)}
          </span>
        </span>
      </div>
      <span className={styles.nextLine}>
        {[line.counterpartyName, line.description].filter(Boolean).join(" · ") || t("money.payables.bank.noDescription")}
        {line.reference ? <> · {t("money.payables.bank.reference")} <bdi dir="ltr">{line.reference}</bdi></> : null}
        {line.sourceAccount ? <> · <bdi dir="ltr">••••{line.sourceAccount.last4}</bdi></> : null}
      </span>
      {line.matchedPayment && (
        <span className={styles.nextLine}>
          {t("money.payables.bank.matchedTo", { payee: line.matchedPayment.payeeName })}
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
                return r.suggestions.length ? t("money.payables.bank.suggestionsShown") : t("money.payables.bank.noSuggestion");
              })
            }
          >
            {t("money.payables.bank.suggest")}
          </button>
          <button
            type="button"
            className={styles.buttonQuiet}
            disabled={busy}
            onClick={() => run(async () => { await dismissBankLine(line.id, "לא תשלום לספק"); return t("money.payables.bank.dismissed"); })}
          >
            {t("money.payables.bank.dismiss")}
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
              if (window.confirm(t("money.payables.bank.unlinkConfirm"))) {
                run(async () => { await revokeBankEvidence(line.matchedPayment!.evidenceId); return t("money.payables.bank.unlinked"); });
              }
            }}
          >
            {t("money.payables.bank.unlink")}
          </button>
        </div>
      )}

      {sugs && sugs.ambiguous && (
        <div className={styles.notice}>{t("money.payables.bank.ambiguous")}</div>
      )}
      {sugs && sugs.list.map((s) => (
        <div key={`${s.kind}-${s.id}`} className={styles.allocation}>
          <span>
            <strong>
              {s.kind === "PAYMENT"
                ? t("money.payables.bank.kindPayment")
                : s.kind === "PREPARATION"
                  ? t("money.payables.bank.kindPreparation")
                  : t("money.payables.bank.kindInstallment")}
            </strong>{" "}
            · {s.payeeName} · {s.commitmentTitle} · {formatMoney(s.amount, undefined, locale)} · {formatDate(s.date, locale)} ·{" "}
            {confidenceLabel(t, s.confidence)} ·{" "}
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
                    return t("money.payables.bank.attachedExisting");
                  }
                  if (s.kind === "PREPARATION") {
                    await completePreparationFromBankLine(line.id, s.id);
                    return t("money.payables.bank.preparationDone");
                  }
                  try {
                    await recordPaymentFromBankLine(line.id, { commitmentId: s.commitmentId, installmentId: s.installmentId });
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : "";
                    if (/already recorded/.test(msg) && window.confirm(t("money.payables.bank.similarConfirm"))) {
                      await recordPaymentFromBankLine(line.id, { commitmentId: s.commitmentId, installmentId: s.installmentId, acknowledgeSimilarPayment: true });
                    } else throw e;
                  }
                  return t("money.payables.bank.recordedNew");
                })
              }
            >
              {s.kind === "PAYMENT"
                ? t("money.payables.bank.actionPayment")
                : s.kind === "PREPARATION"
                  ? t("money.payables.bank.actionPreparation")
                  : t("money.payables.bank.actionInstallment")}
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
                    return t("money.payables.bank.rejected");
                  })
                }
              >
                {t("money.payables.match.notThis")}
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function ManualLineForm({ accounts, onDone }: { accounts: BankAccountApi[]; onDone: (m: string) => void }) {
  const { t } = useI18n();
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
          onDone(r.inserted ? t("money.payables.bank.lineRecorded") : t("money.payables.bank.lineKnown"));
        } catch (err) {
          setError(err instanceof Error ? err.message : t("money.payables.bank.recordFailed"));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="bl-date">{t("money.payables.bank.date")}</label>
          <input id="bl-date" className={styles.input} type="date" value={bookedAt} max={todayISO()} onChange={(e) => setBookedAt(e.target.value)} required />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="bl-amount">{t("money.payables.bank.debitAmount")}</label>
          <input id="bl-amount" className={styles.input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>
      </div>
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="bl-cp">{t("money.payables.bank.counterparty")}</label>
          <input id="bl-cp" className={styles.input} value={counterparty} maxLength={200} onChange={(e) => setCounterparty(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="bl-ref">{t("money.payables.bank.reference")}</label>
          <input id="bl-ref" className={styles.input} dir="ltr" value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} />
        </div>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="bl-acc">{t("money.payables.cheques.form.fromAccount")}</label>
        <select id="bl-acc" className={styles.select} value={accountId ?? ""} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">{t("money.payables.prepare.form.notSpecified")}</option>
          {accounts.filter((a) => a.isActive).map((a) => (
            <option key={a.id} value={a.id}>{a.label} · {a.masked}</option>
          ))}
        </select>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.formActions}>
        <button type="submit" className={styles.buttonPrimary} disabled={busy}>{busy ? t("money.common.recording") : t("money.payables.bank.submitLine")}</button>
      </div>
    </form>
  );
}

function UploadForm({ accounts, onDone }: { accounts: BankAccountApi[]; onDone: (m: string) => void }) {
  const { t } = useI18n();
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
          const skipped = r.errors.length
            ? ` ${t("money.payables.bank.uploadSkipped", {
                count: r.errors.length,
                lines: r.errors
                  .slice(0, 5)
                  .map((x) => t("money.payables.bank.rowN", { n: x.lineNumber }))
                  .join(", "),
              })}`
            : "";
          onDone(`${t("money.payables.bank.uploadResult", { inserted: r.inserted, known: r.alreadyKnown })}${skipped}`);
        } catch (err) {
          setError(err instanceof Error ? err.message : t("money.payables.bank.uploadFailed"));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor="bl-file">{t("money.payables.bank.csvFile")}</label>
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
        <label className={styles.label} htmlFor="bl-uacc">{t("money.payables.bank.whichAccount")}</label>
        <select id="bl-uacc" className={styles.select} value={accountId ?? ""} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">{t("money.payables.prepare.form.notSpecified")}</option>
          {accounts.filter((a) => a.isActive).map((a) => (
            <option key={a.id} value={a.id}>{a.label} · {a.masked}</option>
          ))}
        </select>
      </div>
      <div className={styles.notice}>
        {t("money.payables.bank.csvNotice")}
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.formActions}>
        <button type="submit" className={styles.buttonPrimary} disabled={busy || !text}>
          {busy ? t("money.payables.bank.uploading") : fileName ? t("money.payables.bank.uploadFile", { name: fileName }) : t("money.payables.bank.chooseFile")}
        </button>
      </div>
    </form>
  );
}
