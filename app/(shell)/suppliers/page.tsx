"use client";

/**
 * Suppliers index (/suppliers).
 *
 * The list itself is rendered by `suppliers/layout.tsx` (the stable master —
 * Spec v1 §23 workspace pilot). This page IS the detail region's content when
 * no supplier is selected: on wide desktop it shows a calm empty-selection
 * beside the list; below the workspace tier the detail region is hidden (the
 * list is the screen), so this never competes with it.
 */

import { EmptySelection } from "@/components/ui/empty-selection";

export default function SuppliersIndexPage() {
  return (
    <div className="crm-page" style={{ color: "var(--crm-muted)" }}>
      <EmptySelection
        icon={
          <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
            <path d="M3 7.5 12 3l9 4.5M5 9.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M9 20v-6h6v6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        }
        title="בחרו ספק מהרשימה"
        description="בחירת ספק תציג את פרטי הקשר, ההזמנות והפעילות שלו."
      />
    </div>
  );
}
