"use client";

/**
 * ITA PRODUCTION pilot gate — read-only self-check panel.
 *
 * Shows what the DEPLOYED gate decides for a business + user, per operation,
 * by calling GET /api/platform-admin/authority/pilot-gate through the canonical
 * admin request core (Bearer + MFA step-up). It never calls the Tax Authority,
 * never starts OAuth and never writes anything.
 */
import { useState, type CSSProperties, type FormEvent } from "react";
import {
  fetchPlatformAdminAuthorityPilotGate,
  PlatformAdminFetchError,
} from "@/lib/platform-admin/fetch-platform-admin";
import type { AuthorityPilotGateReport } from "@/lib/services/billing/authority/billing-authority-pilot-gate-report";
import { PA } from "./platform-admin-styles";

const label: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: PA.inkSecondary };
const input: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: `1px solid ${PA.border}`,
  background: PA.cardBg,
  color: PA.ink,
  fontSize: 14,
  width: 140,
};
const cell: CSSProperties = { padding: "6px 10px", borderBottom: `1px solid ${PA.border}`, fontSize: 13, textAlign: "start" };

const OPERATION_LABELS: Record<string, string> = {
  oauthStart: "התחלת OAuth",
  oauthCodeExchange: "החלפת קוד OAuth",
  refresh: "רענון טוקן",
  validation: "בדיקת חיבור",
  approval: "בקשת מספר הקצאה",
  decision: "החלטה על חשבונית",
  probe: "בדיקת רשת",
};

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "report"; report: AuthorityPilotGateReport }
  | { kind: "error"; status: number | null; code: string };

function positiveInt(value: string): number | null {
  return /^[1-9][0-9]{0,9}$/.test(value.trim()) ? Number(value.trim()) : null;
}

export function AuthorityPilotGatePanel() {
  const [businessId, setBusinessId] = useState("9");
  const [userId, setUserId] = useState("9");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function run(event: FormEvent) {
    event.preventDefault();
    const b = positiveInt(businessId);
    const u = positiveInt(userId);
    if (b == null || u == null) {
      setState({ kind: "error", status: null, code: "מזהים חייבים להיות מספרים חיוביים" });
      return;
    }
    setState({ kind: "loading" });
    try {
      setState({ kind: "report", report: await fetchPlatformAdminAuthorityPilotGate(b, u) });
    } catch (error) {
      if (error instanceof PlatformAdminFetchError) {
        setState({ kind: "error", status: error.status, code: error.code ?? error.message });
      } else {
        setState({ kind: "error", status: null, code: "NETWORK_ERROR" });
      }
    }
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <form onSubmit={run} style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={label}>
          מזהה עסק
          <input style={input} value={businessId} onChange={(e) => setBusinessId(e.target.value)} inputMode="numeric" />
        </label>
        <label style={label}>
          מזהה משתמש
          <input style={input} value={userId} onChange={(e) => setUserId(e.target.value)} inputMode="numeric" />
        </label>
        <button type="submit" disabled={state.kind === "loading"} style={{ ...input, width: "auto", cursor: "pointer" }}>
          {state.kind === "loading" ? "בודק…" : "בדיקה"}
        </button>
      </form>

      {state.kind === "error" && (
        <p role="alert" style={{ margin: 0, color: PA.ink, fontSize: 13 }}>
          שגיאה{state.status != null ? ` ${state.status}` : ""}: {state.code}
        </p>
      )}

      {state.kind === "report" && (
        <>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 16px", fontSize: 13, color: PA.ink }}>
            <dt>סביבת ריצה</dt>
            <dd style={{ margin: 0 }}>{state.report.runtimeEnvironment.value ?? "—"} ({state.report.runtimeEnvironment.status})</dd>
            <dt>שלב</dt>
            <dd style={{ margin: 0 }}>{state.report.stage.stage} ({state.report.stage.valueStatus})</dd>
            <dt>רשימת עסקים</dt>
            <dd style={{ margin: 0 }}>
              {state.report.lists.business.status}, {state.report.lists.business.count} · העסק {state.report.businessAdmitted ? "ברשימה" : "לא ברשימה"}
            </dd>
            <dt>רשימת משתמשים</dt>
            <dd style={{ margin: 0 }}>
              {state.report.lists.user.status}, {state.report.lists.user.count} · המשתמש {state.report.userAdmitted ? "ברשימה" : "לא ברשימה"}
            </dd>
          </dl>
          <table style={{ borderCollapse: "collapse", color: PA.ink }}>
            <thead>
              <tr>
                <th style={cell}>פעולה</th>
                <th style={cell}>החלטה</th>
                <th style={cell}>סיבה</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(state.report.operations).map(([op, decision]) => (
                <tr key={op}>
                  <td style={cell}>
                    {OPERATION_LABELS[op] ?? op} <code style={{ fontSize: 11 }}>{op}</code>
                  </td>
                  <td style={cell}>{decision.status === "allowed" ? "מותר" : "חסום"}</td>
                  <td style={cell}>
                    <code style={{ fontSize: 11 }}>{decision.status === "refused" ? decision.reason : ""}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
