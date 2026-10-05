import type { Metadata } from "next";

import { ProfileScreen } from "@/features/account/profile/ProfileScreen";

export const metadata: Metadata = { title: "פרופיל" };

export default function ProfilePage() {
  return <ProfileScreen />;
}
