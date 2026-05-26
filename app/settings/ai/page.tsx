import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";

export default function SettingsAiPage() {
  return (
    <>
      <SettingsSubPageHeader title="הרשאות AI" />
      <SettingsSection>
        <p className="text-sm leading-6 text-gray-600">
          כאן יוגדרו בעתיד הרשאות AI גלובליות — לא ניהול טון או זרימות בשיחה.
        </p>
        <p className="mt-3 text-xs leading-5 text-gray-500">מצב זמני: אין שינויים לשמירה.</p>
      </SettingsSection>
    </>
  );
}
