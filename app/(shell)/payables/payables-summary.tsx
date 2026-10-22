"use client";

import { useEffect, useState } from "react";
import { fetchBusinessCostSummary, type BusinessCostSummaryApi } from "@/lib/business-cost/business-cost-client";
import { formatMoney } from "@/lib/ui/money";
import list from "./payables-list.module.css";

/**
 * The financial snapshot above the payables list — two separate boxes.
 *
 * Every figure is a field of GET /api/business-cost/summary, formatted and
 * nothing else: no sum, no rounding, no fallback number. The first box is what
 * is already recorded and unpaid; the second is a forecast and says so, in its
 * heading and in its dashed border, so it is never read as money owed.
 *
 * A failed fetch costs only this block — the list below keeps working.
 */
export function PayablesSummary() {
  const [summary, setSummary] = useState<BusinessCostSummaryApi | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchBusinessCostSummary(ctrl.signal)
      .then((s) => setSummary(s))
      .catch(() => {
        if (!ctrl.signal.aborted) setFailed(true);
      });
    return () => ctrl.abort();
  }, []);

  if (failed) {
    return (
      <p className={list.summaryError} role="status">
        לא הצלחנו לטעון את תמונת המצב הכספית. הרשימה למטה ממשיכה לעבוד.
      </p>
    );
  }

  if (!summary) {
    return (
      <div className={list.summary} aria-busy="true">
        <div className={`${list.box} ${list.skeletonBox}`} />
        <div className={`${list.box} ${list.skeletonBox}`} />
        <span className={list.srOnly}>טוען תמונת מצב…</span>
      </div>
    );
  }

  // Nothing recorded at all: two boxes of zeros would only look like a verdict.
  if (summary.baseline.completeness.state === "EMPTY") return null;

  const { upcoming, baseline, currency } = summary;
  // A count of the server's own overdue occurrences — never money.
  const overdueCount = upcoming.overdue.items.length;

  return (
    <div className={list.summary}>
      <section className={list.box} aria-labelledby="pay-sum-recorded">
        <h2 id="pay-sum-recorded" className={list.boxTitle}>מועדים רשומים שלא שולמו</h2>
        <p className={list.boxNote}>מועדים חודשיים שעוד לא נוצרו לא נכללים</p>
        <dl className={list.boxFigures}>
          <div className={list.boxFigure}>
            <dt>עבר המועד</dt>
            <dd>
              <span className={list.boxAmount}>{formatMoney(upcoming.overdue.total, currency)}</span>
              {overdueCount > 0 && (
                <span className={list.boxSub}>
                  {overdueCount === 1 ? "מועד אחד" : `${overdueCount} מועדים`}
                </span>
              )}
            </dd>
          </div>
          <div className={list.boxFigure}>
            <dt>ב־7 הימים הקרובים</dt>
            <dd>
              <span className={list.boxAmount}>{formatMoney(upcoming.next7Days.recorded, currency)}</span>
            </dd>
          </div>
          <div className={list.boxFigure}>
            <dt>ב־30 יום</dt>
            <dd>
              <span className={list.boxAmount}>{formatMoney(upcoming.next30Days.recorded, currency)}</span>
            </dd>
          </div>
        </dl>
      </section>

      <section className={`${list.box} ${list.boxForecast}`} aria-labelledby="pay-sum-forecast">
        <h2 id="pay-sum-forecast" className={list.boxTitle}>תחזית · לא חוב</h2>
        <p className={list.boxNote}>הערכה לפי ההתחייבויות המתחדשות. אינה סכום שחייבים.</p>
        <dl className={list.boxFigures}>
          <div className={list.boxFigure}>
            <dt>ב־30 יום</dt>
            <dd>
              <span className={list.boxAmount}>{formatMoney(upcoming.next30Days.projected, currency)}</span>
            </dd>
          </div>
          <div className={list.boxFigure}>
            <dt>עלות חודשית קבועה</dt>
            <dd>
              <span className={list.boxAmount}>{formatMoney(baseline.monthly, currency)}</span>
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
