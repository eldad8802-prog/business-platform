"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import "./crm.css";
import { CRM_THEME_CSS } from "@/lib/design/crm-theme";
import { LAYOUT, type PageSurfaceIntent } from "@/lib/design/tokens";
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

// Two-pane threshold = the canonical workspace tier (Spec v1 §3, owner
// decision #7): LAYOUT.bp.wide (1280). Previously a local 1200 — the original
// rationale (detail pane too cramped below ~1200) holds even better at 1280.
// Keep the `.crm-hd__back` media query in crm.css in sync with this value.
const TWO_PANE_MIN = LAYOUT.bp.wide;

// Bound to the declared vocabulary so an ad-hoc intent string cannot creep
// in here: these surfaces declare their intent directly (WorkspaceLayout owns
// the pane geometry, so there is no single column for PageContainer to cap).
const SURFACE_INTENT: PageSurfaceIntent = "workspace";

export default function CustomersLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/customers";
  const match = pathname.match(/^\/customers\/(\d+)(?:\/|$)/);
  const selectedId = match ? match[1] : null;

  return (
    <div className="crm-scope" dir="rtl" data-page-intent={SURFACE_INTENT}>
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
