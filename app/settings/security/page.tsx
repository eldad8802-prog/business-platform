import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { DevicesScreen } from "@/components/settings/security/devices-screen";
import styles from "../settings-desk.module.css";

export default function SettingsSecurityPage() {
  return (
    <div className={styles.focused}>
      <SettingsSubPageHeader title="אבטחת חשבון" />
      {/* A short list whose one action ends a session: kept at a reading
          measure on desktop so each "ניתוק" stays next to its device. */}
      <DevicesScreen />
    </div>
  );
}
