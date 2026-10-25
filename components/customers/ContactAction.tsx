"use client";

import type { ReactNode } from "react";

export type ContactTone = "phone" | "whatsapp" | "file" | "mail";

/**
 * One contact action — an icon tile plus its label, used by the list cards'
 * footer and the customer file's quick actions so both read the same.
 *
 * With an `href` it is a real link (`tel:` / `wa.me` / `mailto:`); without
 * one it renders as a visibly unavailable item with the reason as its
 * accessible description, so a missing phone never looks like a broken button.
 * It is its own element — never nested inside the card's open-file link — so
 * pressing it cannot also open the customer file.
 */
export function ContactAction({
  href,
  tone,
  icon,
  label,
  ariaLabel,
  unavailableReason,
  layout = "row",
}: {
  href: string | null;
  tone: ContactTone;
  icon: ReactNode;
  label: string;
  ariaLabel: string;
  unavailableReason: string;
  layout?: "row" | "stack";
}) {
  const className = `cust-action cust-action--${layout} cust-tone--${tone}`;
  const content = (
    <>
      <span className="cust-action__tile" aria-hidden>
        {icon}
      </span>
      <span className="cust-action__label">{label}</span>
    </>
  );

  if (!href) {
    return (
      <span className={`${className} cust-action--off`} role="link" aria-disabled="true" aria-label={`${label} · ${unavailableReason}`} title={unavailableReason}>
        {content}
      </span>
    );
  }

  const external = href.startsWith("http");
  return (
    <a
      className={className}
      href={href}
      aria-label={ariaLabel}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {content}
    </a>
  );
}
