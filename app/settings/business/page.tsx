import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { BusinessSummaryCard } from "@/components/settings/BusinessSummaryCard";
import styles from "../settings-desk.module.css";

export default function SettingsBusinessPage() {
  return (
    <div className={styles.focused}>
      <SettingsSubPageHeader title="פרטי העסק" />
      <BusinessSummaryCard />
    </div>
  );
}
