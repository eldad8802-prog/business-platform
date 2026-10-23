"use client";

import { use, useCallback, useEffect, useState } from "react";
import BackButton from "@/components/ui/back-button";
import { useI18n } from "@/components/i18n/I18nProvider";
import {
  confidenceLabel,
  attachEvidence,
  fetchSuggestions,
  formatDate,
  formatMoney,
  minorToDisplay,
  recordPaymentFromDocument,
  rejectMatch,
  revokeEvidence,
  type CandidateApi,
  type SuggestionApi,
} from "@/lib/payables/payables-client";
import { PAYABLES_THEME } from "../../payables-theme";
import styles from "../../payables.module.css";

const CONFIDENCE_CLASS: Record<string, string> = {
  STRONG: styles.badgePaid,
  POSSIBLE: styles.badgeDue,
  WEAK: styles.badgeQuiet,
};

export default function MatchDocumentPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const { documentId } = use(params);
  const docId = Number(documentId);
  const { t, locale } = useI18n();

  const [data, setData] = useState<SuggestionApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetchSuggestions(docId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : t("money.payables.list.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [docId, reloadToken, t]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("money.common.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return (
      <div className={styles.page} style={PAYABLES_THEME}>
        <div className={styles.backRow}>
          <BackButton />
        </div>
        <div className={styles.error}>{error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className={styles.page} style={PAYABLES_THEME}>
        <div className={styles.backRow}>
          <BackButton />
        </div>
        <div className={styles.empty}>{t("money.common.loading")}</div>
      </div>
    );
  }

  return (
    <div className={styles.page} style={PAYABLES_THEME}>
      <div className={styles.backRow}>
        <BackButton />
      </div>

      <header className={styles.header}>
        <div style={{ minWidth: 0 }}>
          <h1 className={styles.title}>{t("money.payables.match.title")}</h1>
          <p className={styles.payee}>{data.document.vendorName}</p>
        </div>
      </header>

      <div className={styles.work}>
      <section>
      <div className={styles.figures}>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>{t("money.payables.match.documentAmount")}</span>
          <span className={styles.figureValue}>{formatMoney(data.document.amount, undefined, locale)}</span>
        </span>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>{t("money.payables.match.date")}</span>
          <span className={styles.figureValue}>{formatDate(data.document.date, locale)}</span>
        </span>
      </div>

      {notice && <div className={styles.notice}>{notice}</div>}
      {error && <div className={styles.error}>{error}</div>}

      {data.attachedTo && (
        <div className={styles.notice}>
          {t("money.payables.match.alreadyAttached", { paymentId: data.attachedTo.paymentId })}
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.buttonQuiet}
              disabled={busy}
              onClick={() =>
                run(
                  () => revokeEvidence(data.attachedTo!.evidenceId, "שויך בטעות"),
                  t("money.payables.match.revoked"),
                )
              }
            >
              {t("money.payables.match.revoke")}
            </button>
          </div>
        </div>
      )}

      {/* Ambiguity is stated, never resolved by picking the first row. */}
      {data.ambiguous && (
        <div className={styles.notice}>
          {t("money.payables.match.ambiguous")}
        </div>
      )}

      {data.candidates.length === 0 && !data.attachedTo && (
        <div className={styles.empty}>
          {t("money.payables.match.none")}
        </div>
      )}
      </section>
      <section>

      <div className={styles.timeline}>
        {data.candidates.map((c) => (
          <CandidateRow
            key={
              c.target.kind === "PAYMENT"
                ? `p-${c.target.paymentId}`
                : `i-${c.target.installmentId}`
            }
            candidate={c}
            busy={busy}
            onAttach={(paymentId) =>
              run(
                () => attachEvidence(docId, paymentId),
                t("money.payables.match.attached"),
              )
            }
            onRecord={(commitmentId, installmentId) =>
              run(
                () =>
                  recordPaymentFromDocument(docId, {
                    commitmentId,
                    installmentIds: installmentId ? [installmentId] : null,
                  }),
                t("money.payables.match.recorded"),
              )
            }
            onReject={(target) =>
              run(
                () => rejectMatch(docId, target),
                t("money.payables.match.rejected"),
              )
            }
          />
        ))}
      </div>
      </section>
      </div>
    </div>
  );
}

function CandidateRow({
  candidate,
  busy,
  onAttach,
  onRecord,
  onReject,
}: {
  candidate: CandidateApi;
  busy: boolean;
  onAttach: (paymentId: number) => void;
  onRecord: (commitmentId: number, installmentId: number | null) => void;
  onReject: (target: {
    commitmentId?: number | null;
    installmentId?: number | null;
    paymentId?: number | null;
  }) => void;
}) {
  const i18n = useI18n();
  const t = candidate.target;
  const isPayment = t.kind === "PAYMENT";

  return (
    <div className={styles.installment}>
      <div className={styles.installmentHead}>
        <span className={styles.installmentSeq}>{t.commitmentTitle}</span>
        <span className={styles.badges}>
          <span
            className={`${styles.badge} ${CONFIDENCE_CLASS[candidate.confidence] ?? styles.badgeQuiet}`}
          >
            {confidenceLabel(i18n.t, candidate.confidence)}
          </span>
        </span>
      </div>

      <span className={styles.payee}>{t.payeeNameSnapshot}</span>

      <div className={styles.figures}>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>{isPayment ? i18n.t("money.payables.match.recordedPayment") : i18n.t("money.payables.match.remainingDue")}</span>
          <span className={styles.figureValue}>
            {minorToDisplay(isPayment ? t.amountMinor : t.remainingMinor, undefined, i18n.locale)}
          </span>
        </span>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>{isPayment ? i18n.t("money.payables.match.paidOn") : i18n.t("money.payables.match.dueDate")}</span>
          <span className={styles.figureValueMuted}>
            {formatDate(isPayment ? t.paidAt : t.dueAt, i18n.locale)}
          </span>
        </span>
      </div>

      {/* The reasons, not the number. The owner judges the evidence. */}
      <span className={styles.nextLine}>{candidate.reasons.join(" · ")}</span>

      <div className={styles.formActions}>
        <button
          type="button"
          className={styles.buttonQuiet}
          disabled={busy}
          onClick={() =>
            onReject(
              isPayment
                ? { commitmentId: t.commitmentId, paymentId: t.paymentId }
                : { commitmentId: t.commitmentId, installmentId: t.installmentId },
            )
          }
        >
          {i18n.t("money.payables.match.notThis")}
        </button>
        {isPayment ? (
          <button
            type="button"
            className={styles.buttonPrimary}
            disabled={busy}
            onClick={() => onAttach(t.paymentId)}
          >
            {i18n.t("money.payables.match.thisIsReceipt")}
          </button>
        ) : (
          <button
            type="button"
            className={styles.buttonPrimary}
            disabled={busy}
            onClick={() => onRecord(t.commitmentId, t.installmentId)}
          >
            {i18n.t("money.payables.match.recordIt")}
          </button>
        )}
      </div>

      {isPayment && (
        <span className={styles.nextLine}>
          {i18n.t("money.payables.match.evidenceNote")}
        </span>
      )}
    </div>
  );
}
