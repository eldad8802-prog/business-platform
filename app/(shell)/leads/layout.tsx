"use client";

import { Suspense, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import "../customers/crm.css";
import { CRM_THEME_CSS } from "@/lib/design/crm-theme";
import { LAYOUT, type PageSurfaceIntent } from "@/lib/design/tokens";
import { WorkspaceLayout } from "@/components/ui/workspace-layout";
import { LeadsList } from "@/components/leads/LeadsList";

/**
 * Leads surface + Master–Detail shell.
 *
 * Structurally identical to the Customers surface, on purpose: the leads list
 * (master) lives HERE in the stable layout, so it fetches once and is never
 * remounted when the selected lead changes — only the detail region (`children`)
 * swaps per route. The route is the single source of truth for the selection.
 *
 * Reuses the CRM stylesheet and theme verbatim rather than forking a second
 * near-identical one: Leads is a CRM surface, and one palette change must keep
 * flowing from a single place.
 *
 * Desktop (≥ LAYOUT.bp.wide): list + card side by side, refresh-safe. Mobile /
 * tablet: exactly one region — the list at /leads, the full-page card at
 * /leads/[id].
 */

const TWO_PANE_MIN = LAYOUT.bp.wide;

const SURFACE_INTENT: PageSurfaceIntent = "workspace";

export default function LeadsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/leads";
  const match = pathname.match(/^\/leads\/(\d+)(?:\/|$)/);
  const selectedId = match ? match[1] : null;

  return (
    <div className="crm-scope" dir="rtl" data-page-intent={SURFACE_INTENT}>
      <style dangerouslySetInnerHTML={{ __html: CRM_THEME_CSS }} />
      <WorkspaceLayout
        start={
          // LeadsList reads ?view= (Home deep-links straight to the attention
          // queue), and useSearchParams needs a Suspense boundary or the route
          // cannot be prerendered at all. The fallback mirrors the list's own
          // loading skeleton so the boundary is invisible in practice.
          <Suspense
            fallback={
              <div className="crm-page">
                <div className="crm-skel" />
                <div className="crm-skel" />
                <div className="crm-skel" />
              </div>
            }
          >
            <LeadsList selectedId={selectedId} />
          </Suspense>
        }
        end={children}
        startWidth={380}
        breakpointStep={TWO_PANE_MIN}
        responsive={{ mode: "switch", visible: selectedId != null ? "end" : "start" }}
        startLabel="רשימת לידים"
        endLabel="כרטיס ליד"
      />
    </div>
  );
}
