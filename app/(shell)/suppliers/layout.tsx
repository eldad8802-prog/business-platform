import type { ReactNode } from "react";
import type { Metadata } from "next";
// Reuse the existing CRM surface styles (Phase S1 decision: import, no relocation).
// The `.crm-*` classes are generic to the CRM surface, not customer-specific.
import "../customers/crm.css";
import { CRM_THEME_CSS } from "@/lib/design/crm-theme";

/**
 * Supplier CRM surface scope — injects the DS v1 theme variables once and wraps
 * all supplier screens in `.crm-scope`. Renders inside the shell chrome (bottom
 * bar unchanged). Mirrors the customers layout to reuse the same visual language.
 */
export const metadata: Metadata = { title: "ספקים" };

export default function SuppliersLayout({ children }: { children: ReactNode }) {
  return (
    <div className="crm-scope" dir="rtl">
      <style dangerouslySetInnerHTML={{ __html: CRM_THEME_CSS }} />
      {children}
    </div>
  );
}
