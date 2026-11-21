"use client";

/**
 * Entry point for "מעבר לעוסק מורשה" inside the "פרטים משפטיים" card on the business details screen.
 *
 * Renders NOTHING unless the server says the feature is on (GET answers 404 while BUSINESS_KIND_TRANSITION_ENABLED is
 * off), so with the flag off the screen is exactly as before. What it shows is the server's answer:
 *   eligible       → the action row (a link to the flow);
 *   blocked        → the row, disabled, with the server's reason (e.g. several users, a live issuer declaration);
 *   already moved  → the history line instead of the action;
 *   always         → "שם או מספר שגוי?" (a new business file).
 * Hiding the row is never the protection: every route refuses on the server too.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import s from "@/app/business/legal-identity/kind-transition/kind-transition.module.css";
import { IconArrowStart, IconCheck, IconChevronStart, NewFileSheet, Note } from "@/components/legal-identity/kind-transition-parts";
import { displayDate, displayInstant, fetchKindTransitionInfo, KIND_TRANSITION_PAGE, type KindTransitionInfo } from "@/lib/legal-identity/kind-transition-client";

export function KindTransitionEntry() {
  const [info, setInfo] = useState<KindTransitionInfo | null>(null);
  const [sheet, setSheet] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchKindTransitionInfo().then((r) => { if (alive) setInfo(r.info); });
    return () => { alive = false; };
  }, []);

  if (!info) return null;
  const elig = info.eligibility;
  const blocked = !elig.eligible && elig.block !== "NOT_EXEMPT_DEALER" ? elig : null;
  const showAction = elig.eligible || blocked !== null;

  return (
    <div className={s.entry} data-testid="kt-entry">
      {info.history ? (
        <Note tone="ok" role="status">
          <IconCheck size={18} />
          <span>עבר לעוסק מורשה ב-{displayInstant(info.history.confirmedAt)}. המעמד ברשות המסים מ-{displayDate(info.history.statusEffectiveDate)}.</span>
        </Note>
      ) : null}

      {showAction && elig.eligible ? (
        <Link href={KIND_TRANSITION_PAGE} className={s.actionRow} data-testid="kt-entry-action">
          <span className={s.actionIcon}><IconArrowStart /></span>
          <span className={s.actionText}>
            <span className={s.actionTitle}>מעבר לעוסק מורשה</span>
            <span className={s.actionSub}>נרשמתם כעוסק מורשה ברשות המסים? עדכנו כאן את סוג העסק</span>
          </span>
          <IconChevronStart />
        </Link>
      ) : null}

      {blocked ? (
        <>
          <button type="button" className={`${s.actionRow} ${s.actionRowDisabled}`} disabled aria-describedby="kt-entry-blocked" data-testid="kt-entry-blocked">
            <span className={s.actionIcon}><IconArrowStart /></span>
            <span className={s.actionText}>
              <span className={s.actionTitle}>מעבר לעוסק מורשה</span>
              <span className={s.actionSub}>לא זמין כרגע לעסק הזה</span>
            </span>
          </button>
          <p id="kt-entry-blocked" className={s.help}>{blocked.message}</p>
        </>
      ) : null}

      <p className={s.help}>
        השם המשפטי ומספר העוסק לא משתנים אחרי ההרשמה.{" "}
        <button type="button" className={s.linkBtn} onClick={() => setSheet(true)}>שם או מספר שגוי?</button>
      </p>
      <NewFileSheet open={sheet} onClose={() => setSheet(false)} />
    </div>
  );
}
