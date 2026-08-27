"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { LAYOUT } from "@/lib/design/tokens";
import { WorkspaceLayout } from "@/components/ui/workspace-layout";
import { SuppliersList } from "@/components/suppliers/SuppliersList";

/**
 * Suppliers Master–Detail workspace (Spec v1 §23 — pilot, owner-approved).
 *
 * Adopts the exact contract of its Customers twin: the list (master) lives in
 * the stable layout, fetched once and never remounted; the detail region
 * (`children`) swaps per route; the route is the single source of truth for
 * the selection. Two-pane at the canonical workspace tier (LAYOUT.bp.wide,
 * 1280); below it exactly one region shows — list at /suppliers, full-page
 * detail at /suppliers/[id].
 */
export function SuppliersWorkspace({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/suppliers";
  const match = pathname.match(/^\/suppliers\/(\d+)(?:\/|$)/);
  const selectedId = match ? match[1] : null;

  return (
    <WorkspaceLayout
      start={<SuppliersList selectedId={selectedId} />}
      end={children}
      startWidth={380}
      breakpointStep={LAYOUT.bp.wide}
      responsive={{ mode: "switch", visible: selectedId != null ? "end" : "start" }}
      startLabel="רשימת ספקים"
      endLabel="כרטיס ספק"
    />
  );
}
