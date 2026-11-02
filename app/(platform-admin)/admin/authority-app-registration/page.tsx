"use client";

/**
 * TEMPORARY — ITA PRODUCTION app registration. Reached by direct path only
 * (/admin/authority-app-registration); deliberately not linked from the admin
 * navigation. Removed with the route in the follow-up PR.
 */
import { AdminConsole, consoleStyles } from "@/components/platform-admin/console/admin-console";
import { AuthorityAppRegistrationForm } from "@/components/platform-admin/authority-app-registration-form";

export default function AuthorityAppRegistrationPage() {
  return (
    <AdminConsole title="רישום אפליקציית רשות המסים" backHref="/admin/diagnostics">
      {() => (
        <>
          <div className={consoleStyles.pageHead}>
            <div>
              <h1>רישום אפליקציית רשות המסים (ייצור)</h1>
              <p>כלי זמני לפעולה חד-פעמית. כל שליחה מחייבת אימות נוסף מהדקות האחרונות ונרשמת ביומן הפעולות.</p>
            </div>
          </div>
          <AuthorityAppRegistrationForm />
        </>
      )}
    </AdminConsole>
  );
}
