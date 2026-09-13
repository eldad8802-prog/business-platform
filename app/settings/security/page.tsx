import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { DevicesScreen } from "@/components/settings/security/devices-screen";

export default function SettingsSecurityPage() {
  return (
    <>
      <SettingsSubPageHeader title="אבטחה" />
      <DevicesScreen />
    </>
  );
}
