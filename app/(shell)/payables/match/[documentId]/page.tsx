"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CONFIDENCE_LABEL,
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
  const router = useRouter();

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
        setError(e instanceof Error ? e.message : "טעינה נכשלה");
      });
    return () => {
      cancelled = true;
    };
  }, [docId, reloadToken]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "הפעולה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return (
      <div className={styles.page} style={PAYABLES_THEME} dir="rtl">
        <div className={styles.error}>{error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className={styles.page} style={PAYABLES_THEME} dir="rtl">
        <div className={styles.empty}>טוען…</div>
      </div>
    );
  }

  return (
    <div className={styles.page} style={PAYABLES_THEME} dir="rtl">
      <button
        type="button"
        className={styles.backLink}
        onClick={() => router.push("/payables")}
      >
        ← כל ההתחייבויות
      </button>

      <header className={styles.header}>
        <div style={{ minWidth: 0 }}>
          <h1 className={styles.title}>שיוך מסמך</h1>
          <p className={styles.payee}>{data.document.vendorName}</p>
        </div>
      </header>

      <div className={styles.figures}>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>סכום במסמך</span>
          <span className={styles.figureValue}>{formatMoney(data.document.amount)}</span>
        </span>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>תאריך</span>
          <span className={styles.figureValue}>{formatDate(data.document.date)}</span>
        </span>
      </div>

      {notice && <div className={styles.notice}>{notice}</div>}
      {error && <div className={styles.error}>{error}</div>}

      {data.attachedTo && (
        <div className={styles.notice}>
          המסמך כבר משויך כראיה לתשלום #{data.attachedTo.paymentId}. הוא אינו נספר
          כתשלום נוסף.
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.buttonQuiet}
              disabled={busy}
              onClick={() =>
                run(
                  () => revokeEvidence(data.attachedTo!.evidenceId, "שויך בטעות"),
                  "השיוך בוטל. המסמך פנוי לשיוך מחדש, והביטול תועד.",
                )
              }
            >
              בטל שיוך
            </button>
          </div>
        </div>
      )}

      {/* Ambiguity is stated, never resolved by picking the first row. */}
      {data.ambiguous && (
        <div className={styles.notice}>
          יש כמה אפשרויות שנראות זהות מבחינת הנתונים הקיימים. המערכת אינה יכולה
          להכריע ביניהן — הבחירה שלך.
        </div>
      )}

      {data.candidates.length === 0 && !data.attachedTo && (
        <div className={styles.empty}>
          לא נמצאה התאמה. סכום זהה לבדו אינו מספיק כדי להציע שיוך — נדרשת גם
          התאמה בשם הספק או בתאריך.
        </div>
      )}

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
                "המסמך שויך כראיה. לא נוצר תשלום נוסף ולא השתנה שום סכום.",
              )
            }
            onRecord={(commitmentId, installmentId) =>
              run(
                () =>
                  recordPaymentFromDocument(docId, {
                    commitmentId,
                    installmentIds: installmentId ? [installmentId] : null,
                  }),
                "נרשם תשלום חדש מתוך המסמך, והמסמך צורף אליו כראיה.",
              )
            }
            onReject={(target) =>
              run(
                () => rejectMatch(docId, target),
                "ההצעה נדחתה ולא תוצע שוב.",
              )
            }
          />
        ))}
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
            {CONFIDENCE_LABEL[candidate.confidence]}
          </span>
        </span>
      </div>

      <span className={styles.payee}>{t.payeeNameSnapshot}</span>

      <div className={styles.figures}>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>{isPayment ? "תשלום שנרשם" : "נותר לתשלום"}</span>
          <span className={styles.figureValue}>
            {minorToDisplay(isPayment ? t.amountMinor : t.remainingMinor)}
          </span>
        </span>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>{isPayment ? "שולם בתאריך" : "מועד פירעון"}</span>
          <span className={styles.figureValueMuted}>
            {formatDate(isPayment ? t.paidAt : t.dueAt)}
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
          לא זה
        </button>
        {isPayment ? (
          <button
            type="button"
            className={styles.buttonPrimary}
            disabled={busy}
            onClick={() => onAttach(t.paymentId)}
          >
            זו הקבלה לתשלום הזה
          </button>
        ) : (
          <button
            type="button"
            className={styles.buttonPrimary}
            disabled={busy}
            onClick={() => onRecord(t.commitmentId, t.installmentId)}
          >
            זהו תשלום שביצעתי — רשום אותו
          </button>
        )}
      </div>

      {isPayment && (
        <span className={styles.nextLine}>
          שיוך כראיה לא ישנה אף סכום — התשלום כבר רשום.
        </span>
      )}
    </div>
  );
}
