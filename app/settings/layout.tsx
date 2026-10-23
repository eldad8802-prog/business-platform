import type { ReactNode } from "react";
import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import { SettingsFrame } from "@/components/settings/SettingsFrame";
import { ShellChrome } from "@/components/navigation/shell-chrome";
import { formatAppVersion, resolveAppVersion } from "@/lib/app-version";

// Tab title in the interface language (Hebrew source "הגדרות": lib/i18n/messages/he.ts → meta.titles.settings).
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.titles.settings") };
}

// Settings is reached from Home's gear and the rail / sidebar, and inherits the
// one shared navigation via ShellChrome. The hub draws its own full-width
// screen; sub-pages keep the focused frame with the desktop rail and the
// system footer (see SettingsFrame).
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <ShellChrome>
      <SettingsFrame versionLabel={formatAppVersion(resolveAppVersion())}>{children}</SettingsFrame>
    </ShellChrome>
  );
}
