"use client";

/**
 * The issuer declaration screen (#1081), in the approved design (owner, 2026-11-17):
 *   - COMPLETE (screen 2): the identity from signup, read-only; only the MISSING details that are not locked can be
 *     completed here, saved through the one profile write path (PATCH /api/billing/invoice-profile, which keeps both
 *     the legal-identity lock and the declaration lock);
 *   - REVIEW (screen 3): what is being confirmed, the exact statement, and "send the confirmation link";
 *   - DECLARED (screen 6): the status, the declared details, and the controlled correction path;
 *   - NEEDS_DESIGNATION: a business with more than one user — Dubiz designates who may declare.
 * Nothing is declared on this screen: the declaration is recorded only from the emailed link (confirm page).
 */

import { useCallback, useEffect, useState } from "react";

import { SUPPORT_EMAIL } from "@/components/settings/settings-hub";
import type { IssuerDetailField, IssuerDetailProblem } from "@/lib/billing/issuer-declaration/details";
import { DECLARANT_NAME_MISSING_MESSAGE, LEGAL_IDENTITY_CORRECTION_PATH } from "@/lib/billing/issuer-declaration/messages";
import { COMPLETION_FIELD, declarationScreenFor } from "@/lib/billing/issuer-declaration/screen-model";
import type { IssuerStatement } from "@/lib/billing/issuer-declaration/statement";
import { TOKEN } from "@/lib/design/billing-theme";

import {
  authHeaders,
  BackToBilling,
  BUSINESS_KIND_LABEL,
  Card,
  CardTitle,
  CheckIcon,
  InfoGrid,
  LinkButton,
  LockIcon,
  Muted,
  Page,
  PageHead,
  PrimaryButton,
  SecondaryButton,
  StatementTable,
  TRACK_LABEL,
} from "./shared";

type Details = Record<IssuerDetailField, string | null>;

type CurrentDeclaration = {
  track: string;
  legalName: string;
  idNumber: string;
  vatRegistrationNumber: string | null;
  createdAt: string;
};

type State = {
  details: Details;
  problems: IssuerDetailProblem[];
  declared: boolean;
  current: CurrentDeclaration | null;
  precondition: "ALREADY_DECLARED" | "INCOMPLETE" | "NEEDS_DESIGNATION" | null;
  statement: IssuerStatement | null;
  declarantNameMissing: boolean;
  lockedFields: IssuerDetailField[];
  editableFields: IssuerDetailField[];
  accountEmail: string | null;
  correctionAvailable: boolean;
};

const inputStyle = {
  minHeight: 44,
  borderRadius: TOKEN.radius.input,
  border: `1px solid ${TOKEN.border.hover}`,
  background: "#ffffff",
  padding: "0 12px",
  fontFamily: "inherit",
  fontSize: 15,
  boxSizing: "border-box" as const,
  width: "100%",
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" });
}

function CorrectionLine({ available }: { available: boolean }) {
  return available ? (
    <Muted>
      פרט בזהות לא נכון? אפשר לתקן אותו רק דרך <a href={LEGAL_IDENTITY_CORRECTION_PATH} style={{ color: TOKEN.brand.mid }}>בקשת תיקון פרטים</a>, שנבדקת בידי צוות דוביז.
    </Muted>
  ) : (
    <Muted>
      פרט בזהות לא נכון? תיקון נעשה רק בבקשה מבוקרת שנבדקת בידי צוות דוביז — לפנייה:{" "}
      <a href={`mailto:${SUPPORT_EMAIL}`} dir="ltr" style={{ color: TOKEN.brand.mid }}>{SUPPORT_EMAIL}</a>
    </Muted>
  );
}

function IdentityCard({ state }: { state: State }) {
  const d = state.details;
  const rows: { label: string; value: string; ltr?: boolean }[] = [
    { label: "סוג העסק", value: BUSINESS_KIND_LABEL[String(d.billingBusinessKind)] ?? "—" },
    { label: "השם הרשמי", value: d.billingLegalName || "—" },
    { label: d.billingBusinessKind === "LTD_COMPANY" ? "מספר חברה" : "מספר זהות", value: d.billingTaxId || "—", ltr: true },
  ];
  const locked = state.lockedFields.length > 0;
  return (
    <Card label="פרטי הזהות מההרשמה" testId="issuer-identity">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <CardTitle>פרטי הזהות{locked ? " (מההרשמה)" : ""}</CardTitle>
        {locked ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: TOKEN.ink.secondary }}>
            <LockIcon />
            לקריאה בלבד
          </span>
        ) : null}
      </div>
      <InfoGrid rows={rows} />
    </Card>
  );
}

export default function DeclarationScreen() {
  const [state, setState] = useState<State | "loading" | "error">("loading");
  const [values, setValues] = useState<Partial<Record<IssuerDetailField, string>>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "urgent" | "attention"; text: string } | null>(null);
  const [sent, setSent] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/billing/issuer-declaration", { headers: authHeaders(), credentials: "same-origin", cache: "no-store" });
      const body = (await res.json()) as State;
      if (!res.ok) {
        setState("error");
        return;
      }
      setState(body);
      const next: Partial<Record<IssuerDetailField, string>> = {};
      for (const f of body.editableFields ?? []) next[f] = body.details[f] ?? "";
      setValues(next);
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveMissing = async () => {
    if (state === "loading" || state === "error") return;
    setBusy(true);
    setNotice(null);
    try {
      const payload: Record<string, string> = {};
      for (const f of state.editableFields) payload[f] = (values[f] ?? "").trim();
      const res = await fetch("/api/billing/invoice-profile", {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice({ tone: "urgent", text: body.error ?? "הפרטים לא נשמרו. אפשר לנסות שוב." });
        return;
      }
      await load();
    } catch {
      setNotice({ tone: "urgent", text: "הפרטים לא נשמרו. אפשר לנסות שוב." });
    } finally {
      setBusy(false);
    }
  };

  const sendLink = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/billing/issuer-declaration/request", { method: "POST", headers: authHeaders(), credentials: "same-origin" });
      const body = (await res.json().catch(() => ({}))) as { outcome?: string; message?: string };
      if (body.outcome === "SENT") {
        setSent(true);
      } else if (body.outcome === "INCOMPLETE" || body.outcome === "ALREADY_DECLARED" || body.outcome === "NEEDS_DESIGNATION") {
        await load();
      } else {
        setNotice({ tone: "attention", text: body.message ?? "לא נשלח קישור. אפשר לנסות שוב." });
      }
    } catch {
      setNotice({ tone: "urgent", text: "לא נשלח קישור. אפשר לנסות שוב." });
    } finally {
      setBusy(false);
    }
  };

  if (state === "loading") return <Page><div aria-busy="true" style={{ minHeight: 200 }} /></Page>;
  if (state === "error") {
    return (
      <Page testId="issuer-declaration-screen" status="ERROR">
        <BackToBilling />
        <Card tone="urgent" label="שגיאה" role="alert">
          <CardTitle tone="urgent">לא הצלחנו לטעון את ההצהרה</CardTitle>
          <Muted>אפשר לנסות שוב בעוד רגע.</Muted>
          <SecondaryButton onClick={() => { setState("loading"); void load(); }}>ניסיון חוזר</SecondaryButton>
        </Card>
      </Page>
    );
  }

  const screen = declarationScreenFor({
    declared: state.declared,
    precondition: state.precondition,
    declarantNameMissing: state.declarantNameMissing,
    editableFields: state.editableFields,
    hasStatement: state.statement !== null,
  });
  const noticeCard = notice ? (
    <Card tone={notice.tone} label="הודעה" role={notice.tone === "urgent" ? "alert" : "status"} testId="issuer-request-notice">
      <p style={{ margin: 0, fontSize: 14 }}>{notice.text}</p>
    </Card>
  ) : null;

  if (screen === "DECLARED") {
    const c = state.current;
    return (
      <Page testId="issuer-declaration-screen" status="DECLARED">
        <BackToBilling />
        <Card tone="success" label="ההצהרה אושרה" role="status">
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <CheckIcon />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <h1 style={{ margin: 0, fontSize: 18, fontWeight: TOKEN.weight.semibold, color: TOKEN.semantic.success.ink }}>ההצהרה אושרה</h1>
              <p style={{ margin: 0, fontSize: 14 }}>
                {c ? `אושרה ב־${formatDate(c.createdAt)}. ` : ""}אין צורך להצהיר שוב — היא חלה על כל המסמכים מעכשיו.
              </p>
            </div>
          </div>
        </Card>
        {c ? (
          <Card label="הפרטים המוצהרים" testId="issuer-declared-details">
            <CardTitle>הפרטים המוצהרים</CardTitle>
            <InfoGrid
              rows={[
                { label: "מסלול", value: TRACK_LABEL[c.track] ?? c.track },
                { label: "השם הרשמי", value: c.legalName },
                { label: c.track === "COMPANY_AUTHORIZED_DEALER" ? "מספר חברה" : "מספר זהות", value: c.idNumber, ltr: true },
                ...(c.vatRegistrationNumber ? [{ label: "מספר עוסק מורשה", value: c.vatRegistrationNumber, ltr: true }] : []),
              ]}
            />
            <Muted>כתובת, טלפון ואימייל אפשר לעדכן כרגיל בפרטי העסק.</Muted>
            {state.correctionAvailable ? (
              <LinkButton href={LEGAL_IDENTITY_CORRECTION_PATH} testId="issuer-correction-link">בקשת תיקון פרטי זהות</LinkButton>
            ) : (
              <CorrectionLine available={false} />
            )}
          </Card>
        ) : null}
      </Page>
    );
  }

  if (screen === "NEEDS_DESIGNATION") {
    return (
      <Page testId="issuer-declaration-screen" status="NEEDS_DESIGNATION">
        <BackToBilling />
        <PageHead title="הצהרת המנפיק" />
        <Card tone="info" label="עסק עם כמה משתמשים">
          <CardTitle tone="info">צריך לקבוע מי מוסמך להצהיר</CardTitle>
          <p style={{ margin: 0, fontSize: 14 }}>
            בעסק שלך יש כמה משתמשים. מטעמי אבטחה, צוות דוביז קובע מי מוסמך להצהיר בשם העסק, לפי מסמך שמראה זאת (למשל ייפוי כוח או פרוטוקול חברה).
          </p>
          <LinkButton href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("מינוי מורשה להצהרת מנפיק")}`} primary>פנייה לצוות דוביז</LinkButton>
          <Muted small>בינתיים אפשר להמשיך להפיק מסמכים כרגיל.</Muted>
        </Card>
      </Page>
    );
  }

  if (screen === "COMPLETE" || screen === "BLOCKED") {
    const problemsFor = (f: IssuerDetailField) => state.problems.filter((p) => p.field === f);
    const lockedProblems = state.problems.filter((p) => !state.editableFields.includes(p.field));
    return (
      <Page testId="issuer-declaration-screen" status={screen === "COMPLETE" ? "INCOMPLETE" : "BLOCKED"}>
        <BackToBilling />
        <PageHead step="שלב 1 מתוך 2" title="הצהרת המנפיק" lead="כמעט הכול כבר מוכן מההרשמה. חסרים רק הפרטים המסומנים." />
        <IdentityCard state={state} />
        {state.editableFields.length > 0 ? (
          <Card tone="attention" label="פרטים להשלמה" testId="issuer-problems">
            <CardTitle>להשלמה</CardTitle>
            {state.editableFields.map((f) => {
              const meta = COMPLETION_FIELD[f] ?? { label: f };
              const errs = problemsFor(f);
              const id = `issuer-field-${f}`;
              return (
                <div key={f} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label htmlFor={id} style={{ fontSize: 14, fontWeight: TOKEN.weight.medium }}>{meta.label}</label>
                  <input
                    id={id}
                    data-testid={id}
                    type={meta.inputMode === "email" ? "email" : meta.inputMode === "tel" ? "tel" : "text"}
                    inputMode={meta.inputMode}
                    dir={meta.ltr ? "ltr" : undefined}
                    value={values[f] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                    aria-invalid={errs.length > 0}
                    aria-describedby={`${id}-help`}
                    style={{ ...inputStyle, borderColor: errs.length > 0 ? TOKEN.semantic.urgent.border : TOKEN.border.hover }}
                  />
                  <span id={`${id}-help`} style={{ fontSize: 12, color: errs.length > 0 ? TOKEN.semantic.urgent.ink : TOKEN.ink.secondary }}>
                    {errs.length > 0 ? errs.map((p) => p.message).join(" ") : meta.hint ?? ""}
                  </span>
                </div>
              );
            })}
            <PrimaryButton onClick={saveMissing} disabled={busy} testId="issuer-save-missing">
              {busy ? "שומרים…" : "שמירה והמשך"}
            </PrimaryButton>
          </Card>
        ) : null}
        {state.declarantNameMissing ? (
          <Card tone="attention" label="שם המצהיר" testId="issuer-declarant-missing">
            <CardTitle tone="attention">חסר שם מלא בחשבון</CardTitle>
            <p style={{ margin: 0, fontSize: 14 }}>{DECLARANT_NAME_MISSING_MESSAGE}</p>
            <a href={`mailto:${SUPPORT_EMAIL}`} dir="ltr" style={{ color: TOKEN.brand.mid, fontSize: 14 }}>{SUPPORT_EMAIL}</a>
          </Card>
        ) : null}
        {lockedProblems.length > 0 ? (
          <Card tone="attention" label="פרטים נעולים" testId="issuer-locked-problems">
            <CardTitle tone="attention">פרט נעול שצריך תיקון</CardTitle>
            <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 14 }}>
              {lockedProblems.map((p) => <li key={`${p.field}-${p.code}`}>{p.message}</li>)}
            </ul>
          </Card>
        ) : null}
        {noticeCard}
        <CorrectionLine available={state.correctionAvailable} />
      </Page>
    );
  }

  // REVIEW (screen 3)
  return (
    <Page testId="issuer-declaration-screen" status="READY">
      <BackToBilling />
      <PageHead step="שלב 2 מתוך 2" title="בדיקה ואישור" />
      <Card tone="brand" label="מה מאשרים כאן">
        <CardTitle>מה מאשרים כאן?</CardTitle>
        <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 14, lineHeight: 1.7 }}>
          <li>שהפרטים למטה נכונים, והם יופיעו על החשבוניות והקבלות שלך.</li>
          <li>שאת/ה מוסמך/ת להפיק מסמכים בשם העסק.</li>
          <li>אחרי האישור פרטי הזהות ננעלים. תיקון — רק בבקשה מבוקרת.</li>
        </ul>
      </Card>
      <Card label="הפרטים שיירשמו בהצהרה">
        <CardTitle>הפרטים שיירשמו בהצהרה</CardTitle>
        {state.statement ? <StatementTable s={state.statement} /> : null}
      </Card>
      {sent ? (
        <Card tone="success" label="הקישור נשלח" role="status" testId="issuer-request-sent">
          <CardTitle tone="success">הקישור נשלח</CardTitle>
          <p style={{ margin: 0, fontSize: 14 }}>
            פתח/י את המייל ממכשיר שבו את/ה מחובר/ת לדוביז ולחץ/י „לאישור ההצהרה”. לא הגיע? כדאי לבדוק בדואר הזבל, או לשלוח שוב.
          </p>
          <SecondaryButton onClick={sendLink} disabled={busy} testId="issuer-request-again">{busy ? "שולחים…" : "שליחה חוזרת"}</SecondaryButton>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <PrimaryButton onClick={sendLink} disabled={busy} testId="issuer-request-link">
            {busy ? "שולחים…" : "שליחת קישור אישור למייל"}
          </PrimaryButton>
          <p style={{ margin: 0, fontSize: 13, color: TOKEN.ink.secondary, textAlign: "center" }}>
            הקישור יישלח ל־{state.accountEmail ? <bdi dir="ltr">{state.accountEmail}</bdi> : "האימייל של החשבון"}, תקף ל־30 דקות ולשימוש אחד. יש לפתוח אותו כשהחשבון מחובר.
          </p>
        </div>
      )}
      {noticeCard}
    </Page>
  );
}
