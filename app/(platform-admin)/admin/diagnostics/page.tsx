"use client";

/**
 * System checks — operator diagnostics that used to sit on the admin home.
 * Moved here unchanged (A1) so the home shows only what needs attention; the
 * Tax Authority token probe keeps its own route, guard and behaviour.
 */
import { AdminConsole, consoleStyles } from "@/components/platform-admin/console/admin-console";
import { TaxAuthorityProbeSection } from "@/components/platform-admin/tax-authority-probe-section";

export default function PlatformAdminDiagnosticsPage() {
  return (
    <AdminConsole title="בדיקות מערכת" backHref="/admin/security">
      {() => (
        <>
          <div className={consoleStyles.pageHead}>
            <div>
              <h1>בדיקות מערכת</h1>
              <p>בדיקות ידניות למפעיל. כל הרצה נשלחת לשרת ומוגנת באימות נוסף.</p>
            </div>
          </div>
          <TaxAuthorityProbeSection />
        </>
      )}
    </AdminConsole>
  );
}
