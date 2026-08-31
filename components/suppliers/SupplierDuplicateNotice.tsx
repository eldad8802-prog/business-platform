"use client";

/**
 * Duplicate-supplier advisory.
 *
 * The server has ALWAYS computed `possibleMatches` and returned them from
 * `POST /api/inventory/suppliers`. The client read only `data.supplier` and
 * discarded them, which is why two suppliers with the same name and the same
 * phone could be created with no warning whatsoever. Nothing about the matching
 * is re-implemented here — this only renders what the server already said.
 *
 * DELIBERATELY NON-BLOCKING. Two suppliers may legitimately share a name (two
 * branches, a renamed entity, a person and their company), so the supplier is
 * created first and the advisory is shown after. The owner then makes the call:
 * keep the new one, or open the existing one instead. Refusing the create would
 * make the system wrong in exactly the cases where the owner knows better.
 */

import type {
  PossibleSupplierMatch,
  SupplierMatchReason,
} from "@/lib/api/suppliers";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";

const REASON_LABEL: Record<SupplierMatchReason, string> = {
  TAX_ID: "אותו מספר עוסק / ח.פ.",
  PHONE: "אותו טלפון",
  EMAIL: "אותו אימייל",
  NAME: "שם זהה",
};

/** The identifier is proof of identity; a name is only a hint. */
function isStrong(match: PossibleSupplierMatch): boolean {
  return match.reasons.includes("TAX_ID");
}

function describe(match: PossibleSupplierMatch): string {
  return match.reasons.map((r) => REASON_LABEL[r]).join(" · ");
}

export function SupplierDuplicateNotice({
  matches,
  createdName,
  onOpenExisting,
  onKeepNew,
}: {
  matches: PossibleSupplierMatch[];
  createdName: string;
  onOpenExisting: (id: number) => void;
  onKeepNew: () => void;
}) {
  if (matches.length === 0) return null;

  const strong = matches.some(isStrong);

  return (
    <div className="crm-modal__backdrop">
      <div
        className="crm-modal"
        role="dialog"
        aria-modal="true"
        aria-label="ייתכן שהספק כבר קיים"
      >
        <h2 className="crm-modal__title">ייתכן שהספק כבר קיים</h2>

        <p className="crm-panel__body">
          {strong ? (
            <>
              קיים כבר ספק עם אותו מספר עסקי כמו <bdi>{createdName}</bdi>. סביר
              מאוד שמדובר באותו עסק.
            </>
          ) : (
            <>
              מצאנו ספקים שנראים דומים ל<bdi>{createdName}</bdi>. אפשר להמשיך עם
              הספק החדש או לעבור לקיים.
            </>
          )}
        </p>

        <div className="crm-rows" style={{ marginTop: 12 }}>
          {matches.map((match) => (
            <button
              key={match.id}
              type="button"
              className="crm-row"
              style={{ width: "100%", textAlign: "start", cursor: "pointer" }}
              onClick={() => onOpenExisting(match.id)}
            >
              <span className="crm-row__body">
                <span className="crm-row__name">
                  <bdi>{match.name}</bdi>
                  {!match.isActive ? (
                    <span
                      className="crm-badge"
                      style={{ marginInlineStart: 8, verticalAlign: "middle" }}
                    >
                      לא פעיל
                    </span>
                  ) : null}
                </span>
                <span className="crm-row__meta">
                  {describe(match)}
                  {match.phone ? ` · ${formatPhoneForDisplay(match.phone)}` : ""}
                </span>
              </span>
              <span className="crm-row__chevron" aria-hidden>
                ‹
              </span>
            </button>
          ))}
        </div>

        <div className="crm-modal__actions">
          <button
            type="button"
            className="crm-btn crm-btn--ghost crm-btn--full"
            onClick={onKeepNew}
          >
            להמשיך עם הספק החדש
          </button>
        </div>
      </div>
    </div>
  );
}
