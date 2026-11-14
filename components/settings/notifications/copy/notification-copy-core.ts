/**
 * The notification settings screens' own translator: typed `notifications.*` keys over the route-scoped copy
 * (./notifications-copy.he.ts / .en.ts), with the same `{name}` interpolation as the global translator.
 *
 * Pure and environment-free (the tests and the server use it directly). The copy object is passed in: this module
 * imports the copy only as a type, so it adds no text to any bundle.
 */
import type { Widen } from "@/lib/i18n/messages/types";
import { interpolate, type MessageVars } from "@/lib/i18n/translate";
import type { notificationsHe } from "./notifications-copy.he";

export type NotificationCopy = Widen<typeof notificationsHe>;

type Join<K, P> = K extends string ? (P extends string ? `${K}.${P}` : never) : never;
type Paths<T> = T extends string
  ? never
  : { [K in keyof T & string]: T[K] extends string ? K : Join<K, Paths<T[K]>> }[keyof T & string];

/** The same dotted keys the screens used under the global dictionary (`notifications.page.title`, …). */
export type NotificationKey = `notifications.${Paths<NotificationCopy>}`;
export type NotificationT = (key: NotificationKey, vars?: MessageVars) => string;

const PREFIX = "notifications.";

export function lookupNotificationCopy(copy: NotificationCopy, key: string): string | undefined {
  if (!key.startsWith(PREFIX)) return undefined;
  let node: unknown = copy;
  for (const part of key.slice(PREFIX.length).split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** A key missing at runtime (only possible for a dynamically built key) renders as the key — never `undefined`. */
export function createNotificationT(copy: NotificationCopy): NotificationT {
  return (key, vars) => interpolate(lookupNotificationCopy(copy, key) ?? key, vars);
}
