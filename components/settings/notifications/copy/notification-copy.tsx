"use client";

/**
 * Hands the notification settings copy (picked by the page on the server, ./notification-copy-server.ts) to the
 * client screens. The screens read it with `useNotificationT()` instead of the global `useI18n().t`.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createNotificationT, type NotificationCopy, type NotificationT } from "./notification-copy-core";

const NotificationCopyContext = createContext<NotificationT | null>(null);

export function NotificationCopyProvider({ copy, children }: { copy: NotificationCopy; children: ReactNode }) {
  const t = useMemo(() => createNotificationT(copy), [copy]);
  return <NotificationCopyContext.Provider value={t}>{children}</NotificationCopyContext.Provider>;
}

export function useNotificationT(): NotificationT {
  const t = useContext(NotificationCopyContext);
  if (!t) throw new Error("useNotificationT: render the screen inside <NotificationCopyProvider>");
  return t;
}
