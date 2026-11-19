/**
 * Server side of the notification settings copy: the copy of the request's locale, for the settings pages to render
 * their headers and to hand to the client screens (<NotificationCopyProvider copy={…}>). Only the chosen language is
 * serialized into the page; neither language is part of any client bundle.
 */
import { getRequestLocale } from "@/lib/i18n/server";
import { createNotificationT, type NotificationCopy, type NotificationT } from "./notification-copy-core";
import { notificationsHe } from "./notifications-copy.he";
import { notificationsEn } from "./notifications-copy.en";

export function notificationCopyFor(locale: string): NotificationCopy {
  return locale === "en" ? notificationsEn : notificationsHe;
}

export async function getNotificationCopy(): Promise<{ copy: NotificationCopy; t: NotificationT }> {
  const copy = notificationCopyFor(await getRequestLocale());
  return { copy, t: createNotificationT(copy) };
}
