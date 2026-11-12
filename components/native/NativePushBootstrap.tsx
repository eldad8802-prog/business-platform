"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  isNativePushAvailable,
  setPushNavigator,
  startNativePushOnAppStart,
} from "@/lib/native/push-notifications";

/**
 * Native push wiring for the authenticated app. Renders nothing.
 *
 * Mounted by the outermost RefreshCoordinator once its gate is open, i.e. only on
 * authenticated screens and only after the session was decided. In a browser it does
 * nothing at all. In the Android app it wires the tap / foreground listeners and
 * re-registers the device ONLY when the notification permission was already granted —
 * it never asks for the permission (lib/native/push-notifications.ts).
 */
export function NativePushBootstrap() {
  const router = useRouter();
  useEffect(() => {
    if (!isNativePushAvailable()) return;
    setPushNavigator((href) => router.push(href));
    startNativePushOnAppStart();
    return () => setPushNavigator(null);
  }, [router]);
  return null;
}
