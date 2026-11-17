"use client";

/**
 * Platform admin — designate who may make a business's issuer declaration (#1081; approved design, owner 2026-11-17,
 * screen 7). Read-only issuer details (from the business profile), the users of the business, a required evidence
 * reference and reason. Every call goes through the canonical admin request core, and the server requires MFA
 * elevation for this route, so the step-up dialog appears when needed. The record is permanent once written.
 */

import { useCallback, useEffect, useState } from "react";

import { consoleStyles } from "@/components/platform-admin/console/admin-console";
import {
  fetchIssuerDesignation,
  postIssuerDesignation,
  PlatformAdminFetchError,
  type IssuerDesignationView,
} from "@/lib/platform-admin/fetch-platform-admin";

const KIND_LABEL: Record<string, string> = { EXEMPT_DEALER: "עוסק פטור", AUTHORIZED_DEALER: "עוסק מורשה", LTD_COMPANY: "חברה בע״מ" };
const TRACK_LABEL: Record<string, string> = {
  EXEMPT_DEALER: "עוסק פטור",
  AUTHORIZED_DEALER_INDIVIDUAL: "עוסק מורשה",
  COMPANY_AUTHORIZED_DEALER: "חברה בע״מ הרשומה כעוסק מורשה",
};

function errorText(e: unknown): string {
  if (e instanceof PlatformAdminFetchError) {
    if (e.status === 404) return "מסך הצהרות המנפיק כבוי בסביבה הזו.";
    return e.message;
  }
  return "הפעולה נכשלה. אפשר לנסות שוב.";
}

export function IssuerDesignationSurface({ businessId }: { businessId: number }) {
  const [data, setData] = useState<IssuerDesignationView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  const [evidenceRef, setEvidenceRef] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setData(await fetchIssuerDesignation(businessId));
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [businessId]);

  useEffect(() => {
    if (Number.isInteger(businessId) && businessId > 0) void load();
  }, [businessId, load]);

  const submit = async () => {
    if (userId === null) {
      setResult({ ok: false, text: "יש לבחור את המשתמש המורשה להצהיר." });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const r = await postIssuerDesignation(businessId, { authorizedUserId: userId, evidenceRef, reason });
      setResult({ ok: true, text: r.mode === "INITIAL" ? "המינוי וההצהרה נרשמו." : "העברת ההרשאה נרשמה." });
      setEvidenceRef("");
      setReason("");
      await load();
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!Number.isInteger(businessId) || businessId <= 0) return <p role="alert" className={consoleStyles.error}>מזהה עסק לא תקין.</p>;
  if (loadError) return <p role="alert" className={consoleStyles.error}>{loadError}</p>;
  if (!data) return <div className={consoleStyles.skeleton} aria-busy="true" style={{ minHeight: 160 }} />;

  const d = data.details;
  const authorized = data.current ? data.users.find((u) => u.id === data.current?.authorizedUserId) : null;
  const candidates = data.users.filter((u) => u.id !== data.adminUserId);

  return (
    <div className={consoleStyles.grid} dir="rtl">
      <section className={consoleStyles.card} aria-labelledby="issuer-details-head">
        <div className={consoleStyles.cardHead}>
          <h2 id="issuer-details-head">פרטי המנפיק (מפרופיל העסק, לקריאה בלבד)</h2>
        </div>
        <dl style={{ display: "grid", gridTemplateColumns: "160px minmax(0, 1fr)", rowGap: 10, columnGap: 8, margin: 0, fontSize: 14 }}>
          <dt>סוג העסק</dt><dd style={{ margin: 0 }}>{KIND_LABEL[String(d.billingBusinessKind)] ?? "—"}</dd>
          <dt>השם הרשמי</dt><dd style={{ margin: 0 }}>{d.billingLegalName || "—"}</dd>
          <dt>{d.billingBusinessKind === "LTD_COMPANY" ? "מספר חברה" : "מספר זהות"}</dt><dd style={{ margin: 0 }}><bdi dir="ltr">{d.billingTaxId || "—"}</bdi></dd>
          {d.billingVatNumber ? (<><dt>מספר עוסק מורשה</dt><dd style={{ margin: 0 }}><bdi dir="ltr">{d.billingVatNumber}</bdi></dd></>) : null}
          <dt>כתובת · טלפון · אימייל</dt><dd style={{ margin: 0 }}>{[d.billingAddress, d.billingPhone, d.billingEmail].filter(Boolean).join(" · ") || "—"}</dd>
          <dt>מצב</dt>
          <dd style={{ margin: 0 }}>
            {data.current
              ? `קיימת הצהרה (${TRACK_LABEL[data.current.track] ?? data.current.track}); המורשה כיום: ${authorized?.name || authorized?.email || "—"}`
              : data.problems.length > 0
                ? "פרטים חסרים — אי אפשר לרשום הצהרה עד להשלמתם"
                : "כל הפרטים שלמים, אין עדיין הצהרה"}
          </dd>
        </dl>
        {data.problems.length > 0 && !data.current ? (
          <ul className={consoleStyles.note} style={{ margin: 0 }}>
            {data.problems.map((p) => <li key={`${p.field}-${p.code}`}>{p.message}</li>)}
          </ul>
        ) : null}
      </section>

      <section className={consoleStyles.card} aria-labelledby="issuer-designation-head">
        <div className={consoleStyles.cardHead}>
          <h2 id="issuer-designation-head">{data.current ? "העברת ההרשאה להצהיר" : "המינוי"}</h2>
        </div>
        <fieldset style={{ border: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          <legend style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>המשתמש המורשה להצהיר</legend>
          {candidates.map((u) => (
            <label key={u.id} style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 36, fontSize: 14 }}>
              <input type="radio" name="issuer-authorized-user" checked={userId === u.id} onChange={() => setUserId(u.id)} />
              {u.name || "—"} · <bdi dir="ltr">{u.email}</bdi>
            </label>
          ))}
        </fieldset>
        <label className={consoleStyles.field} htmlFor="issuer-evidence">
          אסמכתה (חובה)
          <input id="issuer-evidence" value={evidenceRef} maxLength={200} onChange={(e) => setEvidenceRef(e.target.value)}
            placeholder="למשל: פרוטוקול דירקטוריון מיום …, מס׳ פנייה" />
        </label>
        <label className={consoleStyles.field} htmlFor="issuer-reason">
          סיבה (חובה)
          <textarea id="issuer-reason" value={reason} maxLength={1000} rows={3} onChange={(e) => setReason(e.target.value)}
            style={{ font: "inherit", fontSize: 14, padding: "10px 12px", borderRadius: 12, resize: "vertical" }} />
        </label>
        <p className={consoleStyles.note}>
          הפעולה נרשמת לצמיתות: מי מינה, מתי, האסמכתה והסיבה. לא ניתן למחוק או לערוך אותה. מנהל אינו יכול למנות את עצמו.
        </p>
        {result ? <p role={result.ok ? "status" : "alert"} className={result.ok ? consoleStyles.note : consoleStyles.error}>{result.text}</p> : null}
        <button type="button" className={`${consoleStyles.btn} ${consoleStyles.btnPrimary}`} onClick={submit}
          disabled={busy || (!data.current && data.problems.length > 0)} data-testid="issuer-designation-submit">
          {busy ? "רושמים…" : data.current ? "רישום העברת ההרשאה" : "רישום המינוי וההצהרה"}
        </button>
      </section>
    </div>
  );
}
