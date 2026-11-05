"use client";

/**
 * Leads L1.5-a — the intake EMERGENCY SWITCH console. Reached by direct path (/admin/intake-emergency) or from the
 * security tools; platform admins only (the console shell and every API call check it on the server).
 */
import { AdminConsole, consoleStyles } from "@/components/platform-admin/console/admin-console";
import { IntakeEmergencyPanel } from "@/components/platform-admin/intake-emergency-panel";

export default function IntakeEmergencyPage() {
  return (
    <AdminConsole title="מתג חירום — מקורות קליטה" backHref="/admin/security">
      {() => (
        <>
          <div className={consoleStyles.pageHead}>
            <div>
              <h1>מתג חירום למקורות קליטה</h1>
              <p>עצירה זמנית של עיבוד פניות ממקור אחד בכל העסקים, בלי לאבד אותן. כל שינוי דורש אימות דו־שלבי טרי ונרשם ביומן הביקורת.</p>
            </div>
          </div>
          <IntakeEmergencyPanel />
        </>
      )}
    </AdminConsole>
  );
}
