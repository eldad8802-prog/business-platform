import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";

export default function SettingsConnectionsPage() {
  return (
    <>
      <SettingsSubPageHeader title="חיבורים" />
      <SettingsSection>
        <p className="text-sm leading-6 text-gray-600">
          כאן יוגדרו בעתיד אינטגרציות וחשבונות מקושרים — רק ברמת המערכת.
        </p>
        <p className="mt-3 text-xs leading-5 text-gray-500">מצב זמני: אין שינויים לשמירה.</p>
      </SettingsSection>
    </>
  );
}
