import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { AccountSummaryCard } from "@/components/settings/AccountSummaryCard";

export default function SettingsTeamPage() {
  return (
    <>
      <SettingsSubPageHeader title="צוות והרשאות" />
      <div className="mb-4">
        <AccountSummaryCard />
      </div>
      <SettingsSection title="ניהול משתמשים והרשאות">
        <p className="text-sm leading-6 text-gray-600">
          ניהול משתמשים מרובים והרשאות תפקידים — בקרוב.
        </p>
        <p className="mt-3 text-xs leading-5 text-gray-500">
          כרגע פועל משתמש יחיד לכל עסק.
        </p>
      </SettingsSection>
    </>
  );
}
