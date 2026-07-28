"use client";

/**
 * Customers index (/customers).
 *
 * The list itself is rendered by `customers/layout.tsx` (the stable master).
 * This page IS the detail region's content when no customer is selected: on
 * desktop it shows a calm empty-selection beside the list; on mobile/tablet the
 * detail region is hidden (the list is the screen), so this never competes with
 * it.
 */

import { EmptySelection } from "@/components/ui/empty-selection";

export default function CustomersIndexPage() {
  return (
    <div className="crm-page" style={{ color: "var(--crm-muted)" }}>
      <EmptySelection
        icon={
          <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
            <circle cx="9" cy="8" r="3.2" />
            <path d="M3.5 19a5.5 5.5 0 0 1 11 0" strokeLinecap="round" />
            <path d="M16 5.2a3.2 3.2 0 0 1 0 5.9M17.5 19a5.5 5.5 0 0 0-2.7-4.7" strokeLinecap="round" />
          </svg>
        }
        title="בחרו לקוח מהרשימה"
        description="בחירת לקוח תציג את הפרטים, ההערות, הקבצים והפעילות שלו."
      />
    </div>
  );
}
