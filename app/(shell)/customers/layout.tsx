"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import "./crm.css";
import { CRM_THEME_CSS } from "@/lib/design/crm-theme";
import { WorkspaceLayout } from "@/components/ui/workspace-layout";
import { CustomersList } from "@/components/customers/CustomersList";

/**
 * CRM surface + Customers Master–Detail shell.
 *
 * The customers list (master) lives HERE, in the stable layout — so it fetches
 * once and is never remounted when the selected customer changes; only the
 * detail region (`children`) swaps per route. The route is the single source of
 * truth for the selection (parsed from the pathname), never local state.
 *
 * Desktop (≥ TWO_PANE_MIN): list + card side by side (refresh-safe). Mobile /
 * tablet: one region at a time — list at /customers, full-page card at
 * /customers/[id]. Renders inside the App Shell (bottom bar / sidebar unchanged).
 */

// Two-pane threshold. Measured at 1024: content = 1024 − 248 sidebar = 776 →
// master 380 + detail 396px, which is cramped for this rich card (identity grid
// collapses to one column). So the two-pane engages only at ≥1200 (detail ≈572px+
// — comfortable); 1024–1199 shows the same card as a full page. This raises ONLY
// the customers Master–Detail breakpoint, not the App-Shell breakpoints. Keep the
// `.crm-hd__back` media query in crm.css in sync with this value.
const TWO_PANE_MIN = 1200;

export default function CustomersLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/customers";
  const match = pathname.match(/^\/customers\/(\d+)(?:\/|$)/);
  const selectedId = match ? match[1] : null;

  return (
    <div className="crm-scope" dir="rtl">
      <style dangerouslySetInnerHTML={{ __html: CRM_THEME_CSS }} />
      <WorkspaceLayout
        start={<CustomersList selectedId={selectedId} />}
        end={children}
        startWidth={380}
        breakpointStep={TWO_PANE_MIN}
        responsive={{ mode: "switch", visible: selectedId != null ? "end" : "start" }}
        startLabel="רשימת לקוחות"
        endLabel="כרטיס לקוח"
      />
    </div>
  );
}
