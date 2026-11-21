"use client";

import { ActivityPicker } from "@/components/activity-packs/activity-picker";

/** The packs screen in Settings: saving stays on the page (with a "saved" line); nothing navigates away. */
export function ActivitySettingsScreen() {
  return <ActivityPicker mode="settings" onDone={() => undefined} />;
}
