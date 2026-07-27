"use client";

/**
 * Collection Workspace index (/payments).
 *
 * The worklist itself is rendered by `payments/layout.tsx` (the stable master).
 * This page IS the detail region's content when nothing is selected: on desktop
 * it shows a calm empty-selection beside the worklist; on mobile/tablet the
 * detail region is hidden (the worklist is the screen), so this never competes
 * with it.
 */

import { TOKEN } from "@/lib/design/tokens";
import { EmptySelection } from "@/components/ui/empty-selection";

const W = TOKEN.warm;

export default function PaymentsIndexPage() {
  return (
    <div style={{ height: "100%", color: W.muted }}>
      <EmptySelection
        icon={
          <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <path d="M3 9h18" strokeLinecap="round" />
            <path d="M7 14h5" strokeLinecap="round" />
          </svg>
        }
        title="בחרו גבייה מהרשימה"
        description="בחירת גבייה תציג את מצבה, ציר הזמן שלה, וקישור לשליחה או העתקה."
      />
    </div>
  );
}
