import type { ReactNode } from "react";
import "./crm.css";
import { CRM_THEME_CSS } from "@/lib/design/crm-theme";

/**
 * CRM surface scope — injects the DS v1 theme variables once and wraps all
 * customer screens in `.crm-scope`. Renders inside the shell chrome (bottom bar
 * unchanged).
 */
export default function CustomersLayout({ children }: { children: ReactNode }) {
  return (
    <div className="crm-scope" dir="rtl">
      <style dangerouslySetInnerHTML={{ __html: CRM_THEME_CSS }} />
      {children}
    </div>
  );
}
