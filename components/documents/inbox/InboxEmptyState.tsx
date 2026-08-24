"use client";

import { TOKEN } from "@/lib/design/documents-theme";
import { emptyMonthCopy } from "@/lib/documents/backlog-view";

export type InboxEmptyVariant =
  | "no_documents_month"
  | "no_pending"
  | "no_approved";

const COPY: Record<InboxEmptyVariant, { title: string; body: string }> = {
  no_documents_month: {
    title: "אין מסמכים בחודש הזה",
    body: "מסמך חדש שיועלה או ייובא יופיע כאן לאימות קצר.",
  },
  no_pending: {
    title: "אין מסמכים שממתינים לאימות",
    body: "המסמכים שכבר אושרו זמינים בחיפוש ובחבילת רו״ח.",
  },
  no_approved: {
    title: "אין מסמכים מאושרים בחודש הזה",
    body: "אחרי אימות מסמך הוא יופיע בחיפוש ובחבילת רו״ח.",
  },
};

/**
 * Month-scoped title so an empty view never reads as a global claim (F-21).
 * When a month name is provided we name it explicitly; the backlog banner
 * (rendered separately) discloses any pending work in other months.
 */
function resolveTitle(
  variant: InboxEmptyVariant,
  monthName?: string
): string {
  const name = monthName?.trim();
  if (!name) return COPY[variant].title;
  if (variant === "no_pending") return emptyMonthCopy(name);
  if (variant === "no_documents_month") return `אין מסמכים ב${name}`;
  return `אין מסמכים מאושרים ב${name}`;
}

export default function InboxEmptyState({
  variant,
  monthName,
}: {
  variant: InboxEmptyVariant;
  monthName?: string;
}) {
  const copy = { ...COPY[variant], title: resolveTitle(variant, monthName) };
  return (
    <section dir="rtl" style={emptyStyle}>
      <div style={iconStyle} aria-hidden>
        <CheckIcon />
      </div>
      <h2 style={titleStyle}>{copy.title}</h2>
      <p style={bodyStyle}>{copy.body}</p>
    </section>
  );
}

function CheckIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const emptyStyle = {
  minHeight: 240,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: TOKEN.space["2xl"],
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
} as const;

const iconStyle = {
  width: 48,
  height: 48,
  borderRadius: TOKEN.radius.pill,
  background: TOKEN.brand.soft,
  border: `1px solid ${TOKEN.brand.softBorder}`,
  color: TOKEN.brand.mid,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: TOKEN.font.display,
  fontWeight: TOKEN.weight.bold,
  marginBottom: 14,
} as const;

const titleStyle = {
  margin: 0,
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
} as const;

const bodyStyle = {
  margin: "8px 0 0",
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.body,
  lineHeight: 1.6,
  maxWidth: 320,
} as const;
