"use client";

/**
 * The day-cost drawer: what the "עלות יומית" card is made of. It says first that this is a calculated operating
 * cost, not money that left the account, then shows the existing cost card with its breakdown open — the
 * commitments, their monthly amounts and what is left out (loans, one-offs, unreadable items), from the
 * business-cost engine. Nothing is computed here.
 *
 * The canonical AdaptiveOverlay: a bottom sheet on a phone, a dialog from 640px; focus trap, Escape and scroll
 * lock come with it.
 */

import { BusinessCostCard, formatIls } from "@/components/business-cost/BusinessCostCard";
import { useI18n } from "@/components/i18n/I18nProvider";
import { AdaptiveOverlay } from "@/components/ui/adaptive-overlay";
import type { BusinessCostSummaryApi } from "@/lib/business-cost/business-cost-client";
import { secretaryVars } from "./secretary-ui";
import s from "./secretary-hub.module.css";

export function SecretaryCostDrawer({ open, onClose, summary }: { open: boolean; onClose: () => void; summary: BusinessCostSummaryApi | null }) {
  const { locale } = useI18n();
  const day = summary?.baseline.calendarDay ?? null;
  return (
    <AdaptiveOverlay open={open} onClose={onClose} variant="form" labelledBy="hub-cost-title">
      {/* The overlay portals outside the page, so the Secretary variables are set here again. */}
      <div className={s.drawer} style={secretaryVars()} dir="rtl">
        <div className={s.drawerHead}>
          <h2 id="hub-cost-title" className={s.drawerTitle}>מה מרכיב את העלות היומית</h2>
          <button type="button" className={s.navBtn} onClick={onClose} aria-label="סגירה">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <p className={s.calcNote}>
          <strong>זו עלות תפעול מחושבת, לא כסף ששולם.</strong>{" "}
          {day && summary
            ? `ההוצאות הקבועות של החודש (${formatIls(summary.baseline.monthly, locale)}) מחולקות ל־${day.daysInMonth.toLocaleString("he-IL")} ימי החודש. מה ששולם בפועל מופיע בהתחייבויות.`
            : "מה ששולם בפועל מופיע בהתחייבויות."}
        </p>
        <BusinessCostCard embedded breakdownOpen />
      </div>
    </AdaptiveOverlay>
  );
}
