import { SettingsHubScreen } from "@/features/account/settings/SettingsHubScreen";
import { formatAppVersion, resolveAppVersion } from "@/lib/app-version";

export default function SettingsHubPage() {
  return <SettingsHubScreen versionLabel={formatAppVersion(resolveAppVersion())} />;
}
