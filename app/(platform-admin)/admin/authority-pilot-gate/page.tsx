"use client";

/**
 * ITA PRODUCTION pilot gate — read-only self-check. Reached by direct path
 * (/admin/authority-pilot-gate); deliberately not linked from the admin navigation.
 */
import { AdminConsole, consoleStyles } from "@/components/platform-admin/console/admin-console";
import { AuthorityPilotGatePanel } from "@/components/platform-admin/authority-pilot-gate-panel";

export default function AuthorityPilotGatePage() {
  return (
    <AdminConsole title="שער הפיילוט — רשות המסים" backHref="/admin/diagnostics">
      {() => (
        <>
          <div className={consoleStyles.pageHead}>
            <div>
              <h1>שער הפיילוט של רשות המסים (ייצור)</h1>
              <p>בדיקה בקריאה בלבד של ההחלטה בפריסה הנוכחית לכל פעולה. אינה פונה לרשות המסים ואינה מתחילה OAuth.</p>
            </div>
          </div>
          <AuthorityPilotGatePanel />
        </>
      )}
    </AdminConsole>
  );
}
