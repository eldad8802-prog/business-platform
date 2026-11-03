"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import BackButton from "@/components/ui/back-button";
import { categoryToneCss } from "@/features/tools/category-tones";
import { redirectToLogin } from "@/lib/client-session";
import { ReportRequestError, fetchRevenueReports, type ReportKind } from "@/lib/revenue-report-uploads/client";
import type { RecordedSettlement, RecordedZ } from "@/lib/revenue-sources/uploads/service";
import { KIND_TEXT, REPORTS_CSS, ROUTES, TENDER_TEXT, WARNING_TEXT, dayText, money } from "./shared";

/**
 * סגירות קופה ודוחות סליקה — /money/revenue-reports. READ-ONLY: what was recorded from uploaded Z reports and card
 * settlement reports. These are REPORTS (evidence of the register's day and of the acquirer's credit), never income
 * records — the screen says so, shows no "total income", and sums nothing across reports. Hebrew only.
 */

type Data = { enabled: ReportKind[]; z: RecordedZ[] | null; settlement: RecordedSettlement[] | null };
type Load = { state: "loading" } | { state: "closed" } | { state: "signed-out" } | { state: "error" } | { state: "ready"; data: Data };

export function RevenueReportsListScreen() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<ReportKind>("z");
  const retry = useCallback(() => {
    setLoad({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchRevenueReports<Data>()
      .then((data) => {
        if (cancelled) return;
        setLoad({ state: "ready", data });
        if (!data.enabled.includes("z") && data.enabled.includes("settlement")) setTab("settlement");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ReportRequestError && e.status === 404) setLoad({ state: "closed" });
        else if (e instanceof ReportRequestError && e.status === 401) setLoad({ state: "signed-out" });
        else setLoad({ state: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const enabled = load.state === "ready" ? load.data.enabled : [];

  return (
    <main data-page-intent="content" className="dzrr tone-money" dir="rtl">
      <style>{categoryToneCss(".dzrr")}</style>
      <style>{REPORTS_CSS}</style>
      <div className="rwrap">
        <div className="rback">
          <BackButton />
        </div>
        <header className="rhead">
          <h1>סגירות קופה ודוחות סליקה</h1>
          <p>מה שנקלט מדוחות Z ומדוחות סליקה שהעליתם.</p>
        </header>
        <div className="rnote">
          <strong>אלה דוחות, לא רישומי הכנסה.</strong> הם לא נוספים להכנסות, לא נסכמים עם החשבוניות שהפקתם ולא נרשמים כתנועות
          בנק. קבצי המקור לא נשמרים בדוביז.
        </div>

        {load.state === "loading" ? <div className="rnote" aria-busy="true">טוענים…</div> : null}
        {load.state === "closed" ? <div className="rnote">העלאת דוחות Z ודוחות סליקה עדיין לא פתוחה לעסק הזה.</div> : null}
        {load.state === "signed-out" ? (
          <div className="rerr" role="alert">
            צריך להתחבר כדי לראות את הדוחות.{" "}
            <button type="button" className="rbtn" onClick={redirectToLogin}>
              להתחברות
            </button>
          </div>
        ) : null}
        {load.state === "error" ? (
          <div className="rerr" role="alert">
            לא הצלחנו לטעון את הדוחות.{" "}
            <button type="button" className="rbtn" onClick={retry}>
              לנסות שוב
            </button>
          </div>
        ) : null}

        {load.state === "ready" ? (
          <>
            {enabled.length > 1 ? (
              <div className="rtabs" role="group" aria-label="סוג דוח">
                {(["z", "settlement"] as const).map((k) => (
                  <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>
                    {KIND_TEXT[k].plural}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="ractions">
              {enabled.includes(tab) ? (
                <Link className="rbtn rbtn-primary" href={ROUTES.upload(tab)}>
                  {KIND_TEXT[tab].upload}
                </Link>
              ) : null}
            </div>
            {tab === "z" && load.data.z ? <ZList rows={load.data.z} /> : null}
            {tab === "settlement" && load.data.settlement ? <SettlementList rows={load.data.settlement} /> : null}
          </>
        ) : null}
      </div>
    </main>
  );
}

function ZList({ rows }: { rows: RecordedZ[] }) {
  if (rows.length === 0) return <p className="rempty">עוד לא נקלטו דוחות Z.</p>;
  return (
    <ul className="rlist">
      {rows.map((r) => (
        <li key={r.id} className={`rrow${r.superseded ? " rrow-muted" : ""}`}>
          <div className="rrow-top">
            <span className="rrow-title">
              {dayText(r.businessDay)} · קופה <bdi dir="ltr">{r.registerKey}</bdi>
              {r.zNumber ? <> · Z <bdi dir="ltr">{r.zNumber}</bdi></> : null}
            </span>
            {r.superseded ? (
              <span className="rpill rpill-existing">הוחלף בגרסה מתוקנת</span>
            ) : r.revision > 1 ? (
              <span className="rpill rpill-info">גרסה מתוקנת {r.revision}</span>
            ) : null}
          </div>
          <div className="rmeta">
            <span>סה״כ <b>{money(r.totalMinor, r.currency)}</b></span>
            <span>מכירות {money(r.grossMinor, r.currency)}</span>
            {r.discountMinor ? <span>הנחות {money(r.discountMinor, r.currency)}</span> : null}
            {r.refundMinor ? <span>החזרים {money(r.refundMinor, r.currency)}</span> : null}
            {r.voidMinor ? <span>ביטולים {money(r.voidMinor, r.currency)}</span> : null}
            <span>מע״מ {money(r.vatMinor, r.currency)}</span>
            {r.transactionCount !== null ? <span>{r.transactionCount} עסקאות</span> : null}
          </div>
          {r.tenders.length ? (
            <div className="rmeta">
              {r.tenders.map((t) => (
                <span key={`${t.method}|${t.label}`}>
                  {TENDER_TEXT[t.method] ?? t.method}
                  {t.label ? ` (${t.label})` : ""} {money(t.amountMinor, r.currency)}
                </span>
              ))}
            </div>
          ) : null}
          {r.validationCodes.length ? (
            <div className="rmeta">{r.validationCodes.map((w) => WARNING_TEXT[w] ?? w).join(" · ")}</div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function SettlementList({ rows }: { rows: RecordedSettlement[] }) {
  if (rows.length === 0) return <p className="rempty">עוד לא נקלטו דוחות סליקה.</p>;
  return (
    <ul className="rlist">
      {rows.map((r) => (
        <li key={r.id} className="rrow">
          <div className="rrow-top">
            <span className="rrow-title">
              תאריך ערך {dayText(r.valueDate)} · <bdi dir="ltr">{r.acquirer}</bdi>
            </span>
          </div>
          <div className="rmeta">
            <span>נטו <b>{money(r.netMinor, r.currency)}</b></span>
            <span>ברוטו {money(r.grossMinor, r.currency)}</span>
            <span>עמלות {money(r.feeMinor, r.currency)}</span>
            {r.otherDeductionsMinor ? <span>ניכויים {money(r.otherDeductionsMinor, r.currency)}</span> : null}
            {r.installments ? <span>תשלום {r.installments.number} מתוך {r.installments.count}</span> : null}
          </div>
          {r.validationCodes.length ? (
            <div className="rmeta">{r.validationCodes.map((w) => WARNING_TEXT[w] ?? w).join(" · ")}</div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
