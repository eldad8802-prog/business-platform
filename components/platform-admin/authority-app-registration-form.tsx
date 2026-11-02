"use client";

/**
 * TEMPORARY — ITA PRODUCTION app registration form (Platform Admin only).
 *
 * Remove together with:
 *   - app/api/platform-admin/authority/production-app-registration/route.ts
 *   - app/(platform-admin)/admin/authority-app-registration/page.tsx
 *   - lib/platform-admin/fetch-platform-admin.ts (postPlatformAdminAuthorityAppRegistration)
 *
 * The secret lives only in this component's state while typed. It is sent once
 * in the POST body through the canonical request core (Bearer + elevation) and
 * cleared from state after EVERY submit, success or failure. Nothing is written
 * to localStorage/sessionStorage and the field has autocomplete off.
 */

import { useState, type CSSProperties, type FormEvent } from "react";
import {
  PlatformAdminFetchError,
  postPlatformAdminAuthorityAppRegistration,
  type AuthorityAppRegistrationSummaryView,
} from "@/lib/platform-admin/fetch-platform-admin";
import { PlatformAdminInlineError } from "./platform-admin-inline-error";
import { PA } from "./platform-admin-styles";

const CONFIRMATION_WORD = "REGISTER";

type Outcome =
  | { kind: "none" }
  | { kind: "summary"; summary: AuthorityAppRegistrationSummaryView }
  | { kind: "error"; code: string; status: number | null };

const label: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: PA.inkSecondary };
const input: CSSProperties = {
  height: 40,
  padding: "0 12px",
  borderRadius: 8,
  border: `1px solid ${PA.border}`,
  background: PA.cardBg,
  color: PA.ink,
  fontSize: 14,
  direction: "ltr",
  textAlign: "left",
  fontFamily: "ui-monospace, monospace",
};

function buttonStyle(primary: boolean, disabled: boolean): CSSProperties {
  return {
    height: 40,
    padding: "0 18px",
    borderRadius: 8,
    border: primary ? "none" : `1px solid ${PA.border}`,
    fontSize: 14,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    background: primary ? PA.ink : PA.cardBg,
    color: primary ? "var(--dz-text-on-brand)" : PA.ink,
  };
}

const SUMMARY_ROWS: Array<[keyof AuthorityAppRegistrationSummaryView, string]> = [
  ["mode", "מצב"],
  ["environment", "סביבה"],
  ["itaClientId", "מזהה לקוח (מוסתר)"],
  ["accountingSoftwareNumber", "מספר תוכנה (מוסתר)"],
  ["portalApplicationId", "מזהה אפליקציה בפורטל"],
  ["keyCheck", "בדיקת מפתח הצפנה"],
  ["created", "נוצרה רשומה"],
];

export function AuthorityAppRegistrationForm() {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [softwareNumber, setSoftwareNumber] = useState("270901");
  const [portalAppId, setPortalAppId] = useState("16650");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "none" });

  const canApply = confirmation === CONFIRMATION_WORD;

  async function submit(mode: "dry-run" | "apply") {
    if (busy) return;
    if (mode === "apply" && !canApply) return;
    setBusy(true);
    setOutcome({ kind: "none" });
    const secret = clientSecret;
    // Clear the secret from state immediately — it is re-typed for every submit.
    setClientSecret("");
    // One id per click. It travels in the body; the request core serialises the
    // body once and re-sends that identical string after a step-up, so the
    // step-up refusal and the final result are audited under the same id.
    const attemptId = crypto.randomUUID();
    try {
      const summary = await postPlatformAdminAuthorityAppRegistration({
        mode,
        attemptId,
        itaClientId: clientId,
        clientSecret: secret,
        accountingSoftwareNumber: softwareNumber,
        ...(portalAppId.trim() ? { portalApplicationId: portalAppId } : {}),
        ...(mode === "apply" ? { confirmation } : {}),
      });
      setOutcome({ kind: "summary", summary });
    } catch (error) {
      if (error instanceof PlatformAdminFetchError) {
        setOutcome({ kind: "error", code: error.code ?? error.message, status: error.status });
      } else {
        setOutcome({ kind: "error", code: "NETWORK_ERROR", status: null });
      }
    } finally {
      setClientSecret("");
      setConfirmation("");
      setBusy(false);
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
  };

  return (
    <section aria-labelledby="pa-authority-app-registration-heading">
      <form
        onSubmit={onSubmit}
        autoComplete="off"
        style={{
          padding: 20,
          borderRadius: PA.radius,
          border: `1px solid ${PA.border}`,
          background: PA.cardBg,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          maxWidth: 560,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 id="pa-authority-app-registration-heading" style={{ margin: 0, fontSize: 16, fontWeight: 600, color: PA.ink }}>
            רישום אפליקציית רשות המסים — ייצור
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: PA.inkMuted, lineHeight: 1.5 }}>
            כלי זמני. הסוד מוצפן בשרת עם מפתח ההצפנה הקיים של סביבת הייצור ואינו נשמר בדפדפן. ניתן ליצור את הרשומה
            פעם אחת בלבד — רשומה קיימת לעולם לא תידרס.
          </p>
        </div>

        <label style={label}>
          מזהה לקוח
          <input
            style={input}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            name="pa-ita-client-id"
          />
        </label>

        <label style={label}>
          סוד לקוח
          <input
            style={input}
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            name="pa-ita-client-secret"
          />
        </label>

        <label style={label}>
          מספר תוכנה
          <input
            style={input}
            value={softwareNumber}
            onChange={(e) => setSoftwareNumber(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
          />
        </label>

        <label style={label}>
          מזהה אפליקציה בפורטל (לא חובה)
          <input
            style={input}
            value={portalAppId}
            onChange={(e) => setPortalAppId(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
          />
        </label>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" disabled={busy} onClick={() => void submit("dry-run")} style={buttonStyle(false, busy)}>
            בדיקה בלבד (ללא כתיבה)
          </button>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: "12px 14px",
            borderRadius: 8,
            border: `1px solid ${PA.attention.border}`,
            background: PA.attention.bg,
          }}
        >
          <label style={{ ...label, color: PA.attention.ink }}>
            לאישור הרישום הקלד {CONFIRMATION_WORD}
            <input
              style={input}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div>
            <button
              type="button"
              disabled={busy || !canApply}
              onClick={() => void submit("apply")}
              style={buttonStyle(true, busy || !canApply)}
            >
              {busy ? "שולח…" : "רישום האפליקציה"}
            </button>
          </div>
        </div>

        {outcome.kind === "summary" ? (
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", fontSize: 13 }}>
            {SUMMARY_ROWS.map(([key, text]) => (
              <div key={key} style={{ display: "contents" }}>
                <dt style={{ color: PA.inkMuted }}>{text}</dt>
                <dd style={{ margin: 0, color: PA.ink, fontFamily: "ui-monospace, monospace", direction: "ltr", textAlign: "left" }}>
                  {String(outcome.summary[key] ?? "—")}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {outcome.kind === "error" ? (
          <PlatformAdminInlineError
            message={`נכשל: ${outcome.code}${outcome.status !== null ? ` (HTTP ${outcome.status})` : ""}`}
          />
        ) : null}
      </form>
    </section>
  );
}
