import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";

export default function SettingsTeamPage() {
  return (
    <>
      <SettingsSubPageHeader title="צוות והרשאות" />
      <SettingsSection>
        <p className="text-sm leading-6 text-gray-600">
          כאן יוגדרו בעתיד משתמשים והרשאות — רק ברמת המערכת.
        </p>
        <p className="mt-3 text-xs leading-5 text-gray-500">מצב זמני: אין שינויים לשמירה.</p>
      </SettingsSection>
    </>
  );
}
