import type { ReactNode } from "react";
import type { Metadata } from "next";
// Reuse the existing CRM surface styles (Phase S1 decision: import, no relocation).
// The `.crm-*` classes are generic to the CRM surface, not customer-specific.
import "../customers/crm.css";
import { CRM_THEME_CSS } from "@/lib/design/crm-theme";
import { SuppliersWorkspace } from "@/components/suppliers/SuppliersWorkspace";

/**
 * Supplier CRM surface — now a real Master–Detail workspace (Spec v1 §23,
 * pilot): the same `.crm-*` visual language as Customers, wired into the same
 * WorkspaceLayout contract instead of a lone 720px column on desktop. Server
 * layout keeps the route metadata; the client workspace handles selection.
 */
export const metadata: Metadata = { title: "ספקים" };

export default function SuppliersLayout({ children }: { children: ReactNode }) {
  return (
    <div className="crm-scope" dir="rtl">
      <style dangerouslySetInnerHTML={{ __html: CRM_THEME_CSS }} />
      <SuppliersWorkspace>{children}</SuppliersWorkspace>
    </div>
  );
}
