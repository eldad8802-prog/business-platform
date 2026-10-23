import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";

import { ProfileScreen } from "@/features/account/profile/ProfileScreen";

// Tab title in the interface language (Hebrew source "פרופיל": lib/i18n/messages/he.ts → meta.titles.profile).
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.titles.profile") };
}

export default function ProfilePage() {
  return <ProfileScreen />;
}
