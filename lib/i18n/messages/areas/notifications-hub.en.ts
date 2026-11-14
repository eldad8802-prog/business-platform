/**
 * i18n area: notifications — the Settings hub row only, English. Reached only from ../en.ts (the English dictionary
 * chunk and the server), so the Hebrew client bundle never carries English. The types come from the Hebrew source.
 */
import type { Widen } from "../types";
import type { notificationsHubHe } from "./notifications-hub";

export const notificationsHubEn: Widen<typeof notificationsHubHe> = {
  category: {
    title: "Notifications",
    description: "Phone notifications, daily summary and quiet hours",
  },
};
