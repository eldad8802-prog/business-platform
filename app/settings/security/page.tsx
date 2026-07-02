import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { LogoutButton } from "@/components/settings/LogoutButton";

export default function SettingsSecurityPage() {
  return (
    <>
      <SettingsSubPageHeader title="אבטחה" />

      <div className="mb-4">
        <SettingsSection title="התנתקות">
          <p className="text-sm leading-6 text-gray-600">
            יציאה מהחשבון במכשיר זה.
          </p>
          <div className="mt-3">
            <LogoutButton />
          </div>
        </SettingsSection>
      </div>

      <SettingsSection title="הגנת חשבון">
        <ul className="flex flex-col gap-3">
          <li className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-700">אימות דו-שלבי (2FA)</span>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-500">
              בקרוב
            </span>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-700">ניהול התחברויות פעילות</span>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-500">
              בקרוב
            </span>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-700">שינוי סיסמה</span>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-500">
              בקרוב
            </span>
          </li>
        </ul>
      </SettingsSection>
    </>
  );
}
