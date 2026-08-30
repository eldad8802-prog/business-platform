"use client";

/**
 * Leads index (/leads).
 *
 * The list itself is rendered by `leads/layout.tsx` (the stable master). This
 * page IS the detail region's content when no lead is selected: on desktop it
 * shows a calm empty-selection beside the list; on mobile/tablet the detail
 * region is hidden (the list is the screen), so this never competes with it.
 */

import { EmptySelection } from "@/components/ui/empty-selection";

export default function LeadsIndexPage() {
  return (
    <div className="crm-page" style={{ color: "var(--crm-muted)" }}>
      <EmptySelection
        icon={
          <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
            <path d="M3 5h18M6 12h12M10 19h4" strokeLinecap="round" />
          </svg>
        }
        title="בחרו ליד מהרשימה"
        description="בחירת ליד תציג את הפרטים, מה הוא ביקש, המעקב וההיסטוריה שלו."
      />
    </div>
  );
}
