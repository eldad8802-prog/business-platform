"use client";

import { TOKEN } from "@/lib/design/documents-theme";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey, Translator } from "@/lib/i18n/translate";

export type InboxEmptyVariant =
  | "no_documents_month"
  | "no_pending"
  | "no_approved";

const COPY: Record<InboxEmptyVariant, { title: MessageKey; body: MessageKey }> = {
  no_documents_month: {
    title: "documents.inbox.emptyNoDocsMonthTitle",
    body: "documents.inbox.emptyNoDocsMonthBody",
  },
  no_pending: {
    title: "documents.inbox.emptyNoPendingTitle",
    body: "documents.inbox.emptyNoPendingBody",
  },
  no_approved: {
    title: "documents.inbox.emptyNoApprovedTitle",
    body: "documents.inbox.emptyNoApprovedBody",
  },
};

/**
 * Month-scoped title so an empty view never reads as a global claim (F-21).
 * When a month name is provided we name it explicitly; the backlog banner
 * (rendered separately) discloses any pending work in other months.
 */
function resolveTitle(
  t: Translator,
  variant: InboxEmptyVariant,
  monthName?: string
): string {
  const name = monthName?.trim();
  if (!name) return t(COPY[variant].title);
  // Same copy as emptyMonthCopy() (lib/documents/backlog-view), per language.
  if (variant === "no_pending") return t("documents.inbox.emptyNoPendingIn", { month: name });
  if (variant === "no_documents_month") return t("documents.inbox.emptyNoDocsIn", { month: name });
  return t("documents.inbox.emptyNoApprovedIn", { month: name });
}

export default function InboxEmptyState({
  variant,
  monthName,
}: {
  variant: InboxEmptyVariant;
  monthName?: string;
}) {
  const { t } = useI18n();
  const copy = { body: t(COPY[variant].body), title: resolveTitle(t, variant, monthName) };
  return (
    <section style={emptyStyle}>
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
