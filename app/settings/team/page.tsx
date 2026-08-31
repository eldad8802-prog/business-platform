import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { AccountSummaryCard } from "@/components/settings/AccountSummaryCard";
import { LogoutButton } from "@/components/settings/LogoutButton";

export default function SettingsAccountPage() {
  return (
    <>
      <SettingsSubPageHeader title="החשבון שלי" />
      <div className="mb-4">
        <AccountSummaryCard />
      </div>
      <SettingsSection title="התנתקות">
        <p className="text-sm leading-6 text-[var(--dz-text-muted)]">יציאה מהחשבון במכשיר זה.</p>
        <div className="mt-3">
          <LogoutButton />
        </div>
      </SettingsSection>
    </>
  );
}
