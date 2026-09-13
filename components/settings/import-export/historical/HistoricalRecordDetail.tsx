"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { SettingsSection } from "@/components/settings/SettingsSection";
import {
  EXTERNAL_ORIGIN_BADGE,
  EXTERNAL_ORIGIN_EXPLANATION,
  documentTypeLabel,
  failureText,
} from "@/lib/data-transfer/historical/historical-owner-language";

/**
 * One historical fiscal record.
 *
 * # What a detail view of a historical record is for
 *
 * Reading the fiscal facts the ORIGINAL document carried, and the reversal
 * relationships it participates in. That is the whole surface. There is no
 * action here because there is no action a historical record supports: the
 * table is written once at import and never revised, so there is nothing to
 * edit, nothing to delete, and no Dubiz lifecycle for it to enter.
 *
 * # The relationships are shown, and they are historical relationships
 *
 * A credit points at the historical document it reverses, and a document lists
 * the historical credits that reverse it. Both sides stay inside the historical
 * universe — a credit imported from a previous system does not credit a
 * document Dubiz issued, and this screen offers no route by which it could.
 *
 * # The number the source wrote is always preserved
 *
 * When a credit's reference never resolved, the raw number is still shown, and
 * it is stated plainly that no link was found. Hiding it would lose the only
 * evidence of what the original system recorded.
 */

type Relation = {
  id: number;
  documentTypeCode: string;
  originalDocumentNumber: string | null;
  originalIssueDate: string | null;
};

type RecordDetail = {
  id: number;
  documentTypeCode: string;
  originalDocumentNumber: string | null;
  originalIssueDate: string | null;
  totalAmount: string | null;
  subtotalAmount: string | null;
  vatAmount: string | null;
  currency: string | null;
  customerNameSnapshot: string | null;
  customerTaxIdSnapshot: string | null;
  sourceSystemCode: string;
  sourceSystemNameRaw: string | null;
  sourceDocumentTypeRaw: string | null;
  importedAt: string;
  reversesLinked: boolean;
  reversesOriginalNumberRaw: string | null;
  reverses: Relation | null;
  reversedBy: Relation[];
};

type Props = {
  recordId: number;
  /** Base path a record id is appended to, for the related-record links. */
  recordsBase: string;
};

/** What one fetch produced. Returned rather than written, see `fetchRecord`. */
type Outcome =
  | { kind: "record"; value: RecordDetail }
  | { kind: "missing" }
  | { kind: "error"; message: string };

function authHeader(): Record<string, string> | null {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : null;
}

function formatDay(day: string | null): string | null {
  if (!day) return null;
  const [y, m, d] = day.split("-");
  return y && m && d ? `${d}/${m}/${y}` : day;
}

function formatMoney(amount: string | null, currency: string | null): string | null {
  if (amount === null) return null;
  const number = Number(amount);
  const text = Number.isFinite(number)
    ? number.toLocaleString("he-IL", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : amount;
  return currency === "ILS" ? `${text} ₪` : currency ? `${text} ${currency}` : text;
}

/** One labelled fact. Rendered only when there is something to say. */
function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="py-2">
      <dt className="text-[11px] text-[var(--dz-text-muted)]">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-semibold text-[var(--dz-text-primary)]">
        {value}
      </dd>
    </div>
  );
}

function RelationRow({
  relation,
  recordsBase,
}: {
  relation: Relation;
  recordsBase: string;
}) {
  const day = formatDay(relation.originalIssueDate);
  return (
    <li>
      <Link
        href={`${recordsBase}/${relation.id}`}
        className="flex min-h-[44px] w-full items-center gap-3 rounded-2xl border border-transparent px-2 py-3 text-right transition hover:border-[var(--dz-border-subtle)] hover:bg-[var(--dz-surface-muted)]"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-[var(--dz-text-primary)]">
            {documentTypeLabel(relation.documentTypeCode)}
          </span>
          <span className="mt-0.5 block break-words text-xs text-[var(--dz-text-muted)]">
            {[relation.originalDocumentNumber, day].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span
          className="shrink-0 text-lg text-[var(--dz-text-muted)]"
          aria-hidden
        >
          ←
        </span>
      </Link>
    </li>
  );
}

export function HistoricalRecordDetail({ recordId, recordsBase }: Props) {
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  /**
   * Fetch the record and RETURN what happened.
   *
   * It sets no state; `applyOutcome` does, from the promise callback. Updating
   * state synchronously inside an effect body causes a cascading render, and
   * reading an endpoint is an external system being read rather than state being
   * synchronized.
   *
   * A missing record and another business's record are the SAME answer here — a
   * 404 — because the endpoint deliberately cannot tell them apart.
   *
   * "Not signed in" is not pre-checked: the server answers 401 and that answer
   * is handled with all the others.
   */
  const fetchRecord = useCallback(async (): Promise<Outcome> => {
    try {
      const response = await fetch(
        `/api/data-transfer/historical/records/${recordId}`,
        { headers: authHeader() ?? {} }
      );
      const body = await response.json().catch(() => null);

      if (response.status === 404) return { kind: "missing" };
      if (response.status === 401) {
        return { kind: "error", message: "צריך להתחבר מחדש כדי להמשיך." };
      }
      if (!response.ok || !body?.ok) {
        return {
          kind: "error",
          message: failureText(body?.code, body?.message ?? body?.error),
        };
      }
      return { kind: "record", value: body.record as RecordDetail };
    } catch {
      return { kind: "error", message: "שגיאת רשת — בדקו את החיבור ונסו שוב." };
    }
  }, [recordId]);

  function applyOutcome(outcome: Outcome) {
    setLoading(false);
    if (outcome.kind === "missing") {
      setMissing(true);
      return;
    }
    if (outcome.kind === "error") {
      setError(outcome.message);
      return;
    }
    setRecord(outcome.value);
  }

  useEffect(() => {
    let cancelled = false;
    void fetchRecord().then((outcome) => {
      if (!cancelled) applyOutcome(outcome);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchRecord]);

  function retry() {
    setLoading(true);
    setError(null);
    setMissing(false);
    void fetchRecord().then(applyOutcome);
  }

  if (loading) {
    return (
      <SettingsSection>
        <div className="flex flex-col gap-2" aria-label="טוען מסמך">
          <div className="h-6 w-2/3 animate-pulse rounded-full bg-[var(--dz-background)]" />
          <div className="h-24 animate-pulse rounded-2xl bg-[var(--dz-background)]" />
          <div className="h-24 animate-pulse rounded-2xl bg-[var(--dz-background)]" />
        </div>
      </SettingsSection>
    );
  }

  if (missing) {
    return (
      <SettingsSection>
        <p className="text-sm font-bold text-[var(--dz-text-primary)]">
          המסמך לא נמצא.
        </p>
        <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">
          ייתכן שהקישור ישן. חזרו לרשימה כדי למצוא את המסמך.
        </p>
        <Link
          href={recordsBase}
          className="mt-3 inline-flex min-h-[44px] items-center rounded-2xl border border-[var(--dz-border-subtle)] px-4 text-xs font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)]"
        >
          חזרה לרשימה
        </Link>
      </SettingsSection>
    );
  }

  if (error || !record) {
    return (
      <SettingsSection>
        <p className="text-xs font-semibold leading-5 text-[var(--dz-danger,#b3261e)]">
          {error ?? "טעינת המסמך נכשלה."}
        </p>
        <button
          type="button"
          onClick={retry}
          className="mt-2 min-h-[44px] rounded-full border border-[var(--dz-border-subtle)] px-4 text-xs font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)]"
        >
          נסו שוב
        </button>
      </SettingsSection>
    );
  }

  const imported = new Date(record.importedAt);
  const importedText = Number.isNaN(imported.getTime())
    ? null
    : imported.toLocaleDateString("he-IL");

  return (
    <>
      <SettingsSection>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-bold text-[var(--dz-text-primary)]">
            {documentTypeLabel(record.documentTypeCode)}
          </h2>
          <span className="rounded-full bg-[var(--dz-surface-muted)] px-2 py-0.5 text-[11px] font-semibold text-[var(--dz-text-muted)]">
            {EXTERNAL_ORIGIN_BADGE}
          </span>
        </div>
        <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">
          {EXTERNAL_ORIGIN_EXPLANATION}
        </p>
      </SettingsSection>

      <div className="mt-4">
        <SettingsSection title="פרטי המסמך המקורי">
          <dl className="grid grid-cols-1 divide-y divide-[var(--dz-border-subtle)] sm:grid-cols-2 sm:gap-x-6 sm:divide-y-0">
            <Fact label="מספר מסמך מקורי" value={record.originalDocumentNumber} />
            <Fact label="תאריך המסמך" value={formatDay(record.originalIssueDate)} />
            <Fact
              label="סכום כולל"
              value={formatMoney(record.totalAmount, record.currency)}
            />
            <Fact
              label="סכום לפני מע״מ"
              value={formatMoney(record.subtotalAmount, record.currency)}
            />
            <Fact label="מע״מ" value={formatMoney(record.vatAmount, record.currency)} />
            <Fact label="מטבע" value={record.currency} />
          </dl>
          {record.subtotalAmount === null ? (
            <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">
              המערכת הקודמת לא רשמה סכום לפני מע״מ. הסכומים נשמרו בדיוק כפי
              שהתקבלו, בלי חישוב מחדש.
            </p>
          ) : null}
        </SettingsSection>
      </div>

      {record.customerNameSnapshot || record.customerTaxIdSnapshot ? (
        <div className="mt-4">
          <SettingsSection
            title="הלקוח, כפי שהופיע על המסמך"
            description="תצלום מהמסמך המקורי. לא מקושר לכרטיס לקוח בדוביז ולא מעדכן אותו."
          >
            <dl className="grid grid-cols-1 divide-y divide-[var(--dz-border-subtle)] sm:grid-cols-2 sm:gap-x-6 sm:divide-y-0">
              <Fact label="שם לקוח" value={record.customerNameSnapshot} />
              <Fact
                label="מספר עוסק / ח.פ."
                value={record.customerTaxIdSnapshot}
              />
            </dl>
          </SettingsSection>
        </div>
      ) : null}

      <div className="mt-4">
        <SettingsSection title="מאיפה הגיע">
          <dl className="grid grid-cols-1 divide-y divide-[var(--dz-border-subtle)] sm:grid-cols-2 sm:gap-x-6 sm:divide-y-0">
            <Fact
              label="מערכת מקור"
              value={record.sourceSystemNameRaw || record.sourceSystemCode}
            />
            <Fact
              label="סוג המסמך במערכת המקור"
              value={record.sourceDocumentTypeRaw}
            />
            <Fact label="נקלט לדוביז בתאריך" value={importedText} />
          </dl>
        </SettingsSection>
      </div>

      {record.reverses ||
      record.reversesOriginalNumberRaw ||
      record.reversedBy.length > 0 ? (
        <div className="mt-4">
          <SettingsSection title="קשרי זיכוי">
            {record.reverses ? (
              <>
                <p className="text-xs font-semibold text-[var(--dz-text-primary)]">
                  המסמך הזה מזכה את:
                </p>
                <ul className="mt-1 flex flex-col divide-y divide-[var(--dz-border-subtle)]">
                  <RelationRow relation={record.reverses} recordsBase={recordsBase} />
                </ul>
              </>
            ) : record.reversesOriginalNumberRaw ? (
              <>
                <p className="text-xs font-semibold text-[var(--dz-text-primary)]">
                  המסמך הזה מזכה את מספר {record.reversesOriginalNumberRaw}
                </p>
                <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                  המסמך המקורי לא נמצא בהיסטוריה, ולכן המספר נשמר כפי שנכתב, בלי
                  קישור למסמך.
                </p>
              </>
            ) : null}

            {record.reversedBy.length > 0 ? (
              <>
                <p className="mt-4 text-xs font-semibold text-[var(--dz-text-primary)]">
                  מסמכים שמזכים את המסמך הזה:
                </p>
                <ul className="mt-1 flex flex-col divide-y divide-[var(--dz-border-subtle)]">
                  {record.reversedBy.map((relation) => (
                    <RelationRow
                      key={relation.id}
                      relation={relation}
                      recordsBase={recordsBase}
                    />
                  ))}
                </ul>
              </>
            ) : null}
          </SettingsSection>
        </div>
      ) : null}

      <div className="mt-4">
        <SettingsSection>
          <p className="text-xs leading-5 text-[var(--dz-text-muted)]">
            מסמך היסטורי נשמר לצפייה בלבד. אי אפשר לערוך אותו, לשלוח אותו, להפיק
            ממנו מסמך בדוביז או לדווח עליו.
          </p>
        </SettingsSection>
      </div>
    </>
  );
}
