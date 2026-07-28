"use client";

import Link from "next/link";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import type { CustomerListRow } from "@/lib/api/customers";

/**
 * One customer row — avatar initials + name + meta (phone · email · city) +
 * chevron. Markup preserved from the original list; `selected` adds only a
 * subtle highlight + `aria-current` for the desktop Master–Detail (no new data).
 * Uses next/link so selecting a customer is a client navigation that keeps the
 * stable list mounted (never a full reload / refetch).
 */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] ?? "") + (parts[1][0] ?? "");
}

function rowMeta(c: CustomerListRow): string | null {
  const phone = c.phone ? formatPhoneForDisplay(c.phone) : null;
  return [phone, c.email, c.city].filter((v) => v && String(v).trim()).join(" · ") || null;
}

export function CustomerRow({
  customer,
  selected = false,
}: {
  customer: CustomerListRow;
  selected?: boolean;
}) {
  const meta = rowMeta(customer);
  return (
    <Link
      className={`crm-row${selected ? " crm-row--selected" : ""}`}
      href={`/customers/${customer.id}`}
      aria-current={selected ? "true" : undefined}
    >
      <span className="crm-row__avatar" aria-hidden>
        {initials(customer.name)}
      </span>
      <span className="crm-row__body">
        <span className="crm-row__name">
          {customer.name}
          {!customer.isActive ? (
            <span
              className="crm-badge"
              style={{ marginInlineStart: 8, verticalAlign: "middle" }}
            >
              לא פעיל
            </span>
          ) : null}
        </span>
        {meta ? <span className="crm-row__meta">{meta}</span> : null}
      </span>
      <span className="crm-row__chevron" aria-hidden>
        ‹
      </span>
    </Link>
  );
}
