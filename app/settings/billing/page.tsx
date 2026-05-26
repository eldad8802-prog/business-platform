import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";

export default function SettingsBillingPage() {
  return (
    <>
      <SettingsSubPageHeader title="מנוי וחיוב" />
      <SettingsSection>
        <p className="text-sm leading-6 text-gray-600">
          כאן יוצגו בעתיד פרטי מנוי ותשלומים ברמת המערכת. ניהול חשבוניות ללקוחות
          נשאר בפיצ׳ר החשבונית.
        </p>
        <p className="mt-3 text-xs leading-5 text-gray-500">מצב זמני: אין שינויים לשמירה.</p>
      </SettingsSection>
    </>
  );
}
