"use client";

/**
 * Shared building blocks of the issuer declaration screens (#1081), in the approved design (owner, 2026-11-17):
 * phone-first, Hebrew, right to left, on the billing theme (lib/design/billing-theme.ts — Dubiz DS v1 / Mist). No
 * separate design system: every colour, radius and weight comes from TOKEN.
 */

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";

import type { IssuerStatement } from "@/lib/billing/issuer-declaration/statement";
import { TOKEN } from "@/lib/design/billing-theme";

export function authHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? null : window.localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export const KIND_LABEL: Record<string, string> = { INITIAL: "הצהרה ראשונה", EXISTING_CONFIRMATION: "אישור פרטים של עסק קיים" };
export const TRACK_LABEL: Record<string, string> = {
  EXEMPT_DEALER: "עוסק פטור",
  AUTHORIZED_DEALER_INDIVIDUAL: "עוסק מורשה",
  COMPANY_AUTHORIZED_DEALER: "חברה בע״מ הרשומה כעוסק מורשה",
};
export const BUSINESS_KIND_LABEL: Record<string, string> = {
  EXEMPT_DEALER: "עוסק פטור",
  AUTHORIZED_DEALER: "עוסק מורשה",
  LTD_COMPANY: "חברה בע״מ",
};
const ID_TYPE_LABEL: Record<string, string> = { ISRAELI_ID: "מספר זהות", COMPANY_NUMBER: "מספר חברה" };

export type Tone = "plain" | "brand" | "success" | "attention" | "info" | "urgent";

function toneColors(tone: Tone): { background: string; border: string; ink: string } {
  switch (tone) {
    case "brand":
      return { background: TOKEN.brand.soft, border: TOKEN.brand.softBorder, ink: TOKEN.ink.primary };
    case "success":
      return { background: TOKEN.semantic.success.bg, border: TOKEN.semantic.success.border, ink: TOKEN.semantic.success.ink };
    case "attention":
      return { background: TOKEN.surface.card, border: TOKEN.semantic.attention.border, ink: TOKEN.semantic.attention.ink };
    case "info":
      return { background: TOKEN.surface.card, border: TOKEN.semantic.info.border, ink: TOKEN.semantic.info.ink };
    case "urgent":
      return { background: TOKEN.surface.card, border: TOKEN.semantic.urgent.border, ink: TOKEN.semantic.urgent.ink };
    default:
      return { background: TOKEN.surface.card, border: TOKEN.border.DEFAULT, ink: TOKEN.ink.primary };
  }
}

export const pageStyle: CSSProperties = {
  maxWidth: 560,
  margin: "0 auto",
  padding: "20px 16px 32px",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: 16,
  color: TOKEN.ink.primary,
  lineHeight: 1.6,
};

export function Page({ children, testId, status }: { children: ReactNode; testId?: string; status?: string }) {
  return (
    <main dir="rtl" style={pageStyle} data-testid={testId} data-status={status}>
      {children}
    </main>
  );
}

export function BackToBilling() {
  return (
    <Link href="/billing" style={{ fontSize: 14, color: TOKEN.brand.mid, textDecoration: "none", alignSelf: "flex-start" }}>
      → חזרה לחשבוניות
    </Link>
  );
}

export function PageHead({ step, title, lead }: { step?: string; title: string; lead?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {step ? <span style={{ fontSize: 13, color: TOKEN.ink.secondary }}>{step}</span> : null}
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: TOKEN.weight.semibold }}>{title}</h1>
      {lead ? <p style={{ margin: 0, fontSize: 14, color: TOKEN.ink.secondary }}>{lead}</p> : null}
    </div>
  );
}

export function Card({
  tone = "plain",
  label,
  role,
  children,
  testId,
}: {
  tone?: Tone;
  label: string;
  role?: "status" | "alert";
  children: ReactNode;
  testId?: string;
}) {
  const c = toneColors(tone);
  return (
    <section
      aria-label={label}
      role={role}
      data-testid={testId}
      style={{
        background: c.background,
        border: `1px solid ${c.border}`,
        borderRadius: TOKEN.radius.card,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {children}
    </section>
  );
}

export function CardTitle({ children, tone = "plain" }: { children: ReactNode; tone?: Tone }) {
  return (
    <h2 style={{ margin: 0, fontSize: 16, fontWeight: TOKEN.weight.semibold, color: toneColors(tone).ink }}>{children}</h2>
  );
}

export function Muted({ children, small }: { children: ReactNode; small?: boolean }) {
  return <p style={{ margin: 0, fontSize: small ? 12 : 13, color: TOKEN.ink.secondary }}>{children}</p>;
}

const buttonBase: CSSProperties = {
  minHeight: 48,
  borderRadius: TOKEN.radius.button,
  padding: "0 18px",
  fontFamily: "inherit",
  fontSize: 16,
  fontWeight: TOKEN.weight.semibold,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  textDecoration: "none",
  cursor: "pointer",
  boxSizing: "border-box",
};

export const primaryStyle: CSSProperties = {
  ...buttonBase,
  border: "none",
  background: TOKEN.action.primary.background,
  color: TOKEN.action.primary.color,
};

export const secondaryStyle: CSSProperties = {
  ...buttonBase,
  minHeight: 44,
  fontSize: 15,
  border: TOKEN.action.glass.border,
  background: TOKEN.action.glass.background,
  color: TOKEN.action.glass.color,
};

export function PrimaryButton(props: { onClick: () => void; disabled?: boolean; children: ReactNode; testId?: string }) {
  return (
    <button type="button" onClick={props.onClick} disabled={props.disabled} data-testid={props.testId}
      style={{ ...primaryStyle, opacity: props.disabled ? 0.6 : 1 }}>
      {props.children}
    </button>
  );
}

export function SecondaryButton(props: { onClick: () => void; disabled?: boolean; children: ReactNode; testId?: string }) {
  return (
    <button type="button" onClick={props.onClick} disabled={props.disabled} data-testid={props.testId}
      style={{ ...secondaryStyle, opacity: props.disabled ? 0.6 : 1 }}>
      {props.children}
    </button>
  );
}

export function LinkButton({ href, children, primary, testId }: { href: string; children: ReactNode; primary?: boolean; testId?: string }) {
  return (
    <Link href={href} data-testid={testId} style={primary ? primaryStyle : secondaryStyle}>
      {children}
    </Link>
  );
}

/** Rows of label → value. Numbers and addresses that read left-to-right keep their direction inside the RTL row. */
export function InfoGrid({ rows, testId }: { rows: { label: string; value: string; ltr?: boolean }[]; testId?: string }) {
  return (
    <dl data-testid={testId} style={{ margin: 0, display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", rowGap: 10, columnGap: 8, fontSize: 14 }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: "contents" }}>
          <dt style={{ color: TOKEN.ink.secondary }}>{r.label}</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere" }}>
            {r.ltr ? <bdi dir="ltr">{r.value}</bdi> : r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The statement exactly as it will be recorded — every value shown, nothing summarised. */
export function StatementTable({ s, showKind }: { s: IssuerStatement; showKind?: boolean }) {
  const rows: { label: string; value: string; ltr?: boolean }[] = [
    ...(showKind ? [{ label: "סוג ההצהרה", value: KIND_LABEL[String(s.kind)] ?? String(s.kind) }] : []),
    { label: "מסלול", value: TRACK_LABEL[String(s.track)] ?? String(s.track) },
    { label: "השם הרשמי", value: String(s.legalName ?? "") },
    { label: ID_TYPE_LABEL[String(s.idType)] ?? "מספר מזהה", value: String(s.idNumber ?? ""), ltr: true },
    ...(s.vatRegistrationNumber ? [{ label: "מספר עוסק מורשה", value: String(s.vatRegistrationNumber), ltr: true }] : []),
    { label: "כתובת", value: String(s.address ?? "") },
    { label: "טלפון", value: String(s.phone ?? ""), ltr: true },
    { label: "אימייל", value: String(s.email ?? ""), ltr: true },
    { label: "המצהיר/ה", value: `${String(s.declarantName ?? "")} — ${String(s.declarantCapacity ?? "")}` },
    { label: "תחילת תוקף", value: s.effectiveFrom ? String(s.effectiveFrom) : "ממועד האישור" },
  ];
  return <InfoGrid rows={rows} testId="issuer-statement" />;
}

const iconProps = { viewBox: "0 0 24 24", fill: "none", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function ShieldIcon({ color = TOKEN.brand.mid }: { color?: string }) {
  return (
    <svg aria-hidden="true" {...iconProps} width={22} height={22} stroke={color} style={{ flex: "none", marginTop: 2 }}>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

export function LockIcon({ color = TOKEN.ink.secondary }: { color?: string }) {
  return (
    <svg aria-hidden="true" {...iconProps} width={16} height={16} stroke={color} style={{ flex: "none" }}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function CheckIcon({ color = TOKEN.semantic.success.ink }: { color?: string }) {
  return (
    <svg aria-hidden="true" {...iconProps} width={24} height={24} stroke={color} style={{ flex: "none" }}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12l3 3 5-6" />
    </svg>
  );
}
