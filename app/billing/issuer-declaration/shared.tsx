"use client";

/**
 * Shared bits of the issuer declaration screens (#1081). Minimal markup on purpose: the visual design of these
 * screens is a separate step. Hebrew only, right to left.
 */

import type { IssuerStatement } from "@/lib/billing/issuer-declaration/statement";

export function authHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? null : window.localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const KIND_LABEL: Record<string, string> = { INITIAL: "הצהרה ראשונה", EXISTING_CONFIRMATION: "אישור פרטים של עסק קיים" };
const TRACK_LABEL: Record<string, string> = {
  EXEMPT_DEALER: "עוסק פטור",
  AUTHORIZED_DEALER_INDIVIDUAL: "עוסק מורשה",
  COMPANY_AUTHORIZED_DEALER: "חברה בע״מ הרשומה כעוסק מורשה",
};
const ID_TYPE_LABEL: Record<string, string> = { ISRAELI_ID: "מספר זהות", COMPANY_NUMBER: "מספר חברה" };

/** The statement exactly as it will be recorded — every value shown, nothing summarised. */
export function StatementTable({ s }: { s: IssuerStatement }) {
  const rows: [string, string][] = [
    ["סוג ההצהרה", KIND_LABEL[String(s.kind)] ?? String(s.kind)],
    ["מסלול", TRACK_LABEL[String(s.track)] ?? String(s.track)],
    ["השם הרשמי", String(s.legalName ?? "")],
    [ID_TYPE_LABEL[String(s.idType)] ?? "מספר מזהה", String(s.idNumber ?? "")],
    ...(s.vatRegistrationNumber ? ([["מספר עוסק מורשה", String(s.vatRegistrationNumber)]] as [string, string][]) : []),
    ["כתובת", String(s.address ?? "")],
    ["טלפון", String(s.phone ?? "")],
    ["אימייל", String(s.email ?? "")],
    ["תחילת תוקף", s.effectiveFrom ? String(s.effectiveFrom) : "ממועד האישור"],
    ["המצהיר", `${String(s.declarantName ?? "")} (${String(s.declarantCapacity ?? "")})`],
  ];
  return (
    <table data-testid="issuer-statement" style={{ borderCollapse: "collapse", width: "100%" }}>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th scope="row" style={{ textAlign: "start", padding: "6px 8px", fontWeight: 600, whiteSpace: "nowrap" }}>{k}</th>
            <td style={{ padding: "6px 8px", overflowWrap: "anywhere" }}><bdi>{v}</bdi></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const shellStyle = { maxWidth: 560, margin: "24px auto", padding: "0 16px", lineHeight: 1.6 } as const;
