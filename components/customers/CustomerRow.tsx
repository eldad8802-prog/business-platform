"use client";

import Link from "next/link";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import { CrmRowMeta } from "@/components/crm/CrmRowMeta";
import type { CustomerListRow } from "@/lib/api/customers";

/**
 * One customer row — avatar initials + name + meta (phone · email · city) +
 * chevron. `selected` adds only a subtle highlight + `aria-current` for the
 * desktop Master–Detail (no new data). The meta values go to `CrmRowMeta`
 * rather than being joined here, so they wrap instead of overflowing the card
 * and each keeps its own bidi isolation inside the RTL row.
 * Uses next/link so selecting a customer is a client navigation that keeps the
 * stable list mounted (never a full reload / refetch).
 */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] ?? "") + (parts[1][0] ?? "");
}

/**
 * The row's meta VALUES, in reading order — no longer pre-joined into one
 * string. `CrmRowMeta` owns the separators and the bidi isolation; joining here
 * is what used to make the line unwrappable and bidi-unstable.
 */
function rowMetaParts(c: CustomerListRow): Array<string | null> {
  return [c.phone ? formatPhoneForDisplay(c.phone) : null, c.email, c.city];
}

export function CustomerRow({
  customer,
  selected = false,
}: {
  customer: CustomerListRow;
  selected?: boolean;
}) {
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
          <bdi>{customer.name}</bdi>
        </span>
        {/* Sibling of the name, not a suffix inside it: the name is clamped to
            two lines, and a badge placed after the text would be clipped away
            on exactly the long names where the row is hardest to read. */}
        {!customer.isActive ? (
          <span className="crm-row__badges">
            <span className="crm-badge">לא פעיל</span>
          </span>
        ) : null}
        <CrmRowMeta parts={rowMetaParts(customer)} />
      </span>
      <span className="crm-row__chevron" aria-hidden>
        ‹
      </span>
    </Link>
  );
}
