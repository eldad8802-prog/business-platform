import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { BusinessSummaryCard } from "@/components/settings/BusinessSummaryCard";

export default function SettingsBusinessPage() {
  return (
    <>
      <SettingsSubPageHeader title="העסק שלי" />
      <BusinessSummaryCard />
    </>
  );
}
