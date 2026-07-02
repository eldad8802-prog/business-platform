import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";

export default function SettingsAiPage() {
  return (
    <>
      <SettingsSubPageHeader title="הרשאות AI" />
      <SettingsSection title="הרשאות AI גלובליות">
        <p className="text-sm leading-6 text-gray-600">
          אזור זה מיועד להרשאות AI ברמת המערכת בלבד — מה מותר ל-AI לבצע באופן
          גלובלי. בקרוב.
        </p>
        <div className="mt-3 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3">
          <p className="text-xs leading-5 text-gray-600">
            כאן לא מוגדרים טון, זרימות שיחה, התנהגות בוט או שאלות פתיחה — אלה
            נשארים בהגדרות הבוט של העסק.
          </p>
        </div>
      </SettingsSection>
    </>
  );
}
