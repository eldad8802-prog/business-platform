"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { LAYOUT, TOKEN } from "@/lib/design/tokens";
import { WorkspaceLayout } from "@/components/ui/workspace-layout";
import { CollectionWorklist } from "@/components/payments/collection-worklist";

const W = TOKEN.warm;

/**
 * Collection Master–Detail shell for /payments.
 *
 * The worklist (master) lives HERE, in the stable layout — so it fetches the
 * read-only workspace ONCE and is never remounted when the selected item
 * changes; only the detail region (`children`) swaps per route. The route is the
 * single source of truth for the selection (parsed from the pathname), never
 * local state.
 *
 * Desktop (≥1024): master + detail side by side (refresh-safe — the layout
 * always renders both). Mobile / tablet: one region at a time — worklist at
 * /payments, full-page detail at /payments/[id].
 *
 * /payments/new is the standalone create form (out of scope) — passed through
 * untouched, with no worklist and no Master–Detail chrome.
 */
export default function PaymentsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/payments";

  if (pathname === "/payments/new" || pathname.startsWith("/payments/new/")) {
    return <>{children}</>;
  }

  const match = pathname.match(/^\/payments\/(\d+)(?:\/|$)/);
  const selectedId = match ? match[1] : null;

  return (
    <div dir="rtl" style={{ minHeight: "100%", background: W.canvas }}>
      {/*
        Workspace convergence (Spec v1 §10, owner decision #5): Payments moves
        to the canonical WorkspaceLayout; MasterDetailLayout is deprecated.
        Breakpoint: LAYOUT.bp.expanded (1024) — a DOCUMENTED exception to the
        1280 workspace default (owner decision #7): this split shipped at 1024,
        and with a 400px master the detail still gets 624px+ on the 1024–1279
        laptops; raising it would REMOVE the two-pane those users have today.
      */}
      <WorkspaceLayout
        start={<CollectionWorklist selectedId={selectedId} />}
        end={children}
        startWidth={400}
        breakpointStep={LAYOUT.bp.expanded}
        responsive={{ mode: "switch", visible: selectedId != null ? "end" : "start" }}
        startLabel="רשימת גביות"
        endLabel="פרטי גבייה"
      />
    </div>
  );
}
