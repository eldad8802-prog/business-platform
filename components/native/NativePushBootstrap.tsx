"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Capacitor } from "@capacitor/core";

/**
 * Native push wiring for the authenticated app. Renders nothing.
 *
 * Mounted by the outermost RefreshCoordinator once its gate is open, i.e. only on
 * authenticated screens and only after the session was decided. In a browser it only
 * re-binds an ALREADY granted push subscription to this session (refreshPushBinding —
 * silent, same user only, never a prompt). In the Android app it wires the tap / foreground listeners and
 * re-registers the device ONLY when the notification permission was already granted —
 * it never asks for the permission (lib/native/push-notifications.ts).
 *
 * The push client is loaded on demand, and only inside the Android app: every web page
 * mounts this component, so a static import would ship the whole client to browsers that
 * never run it (the shell's Hebrew JS budget — .i18n/en-chunk-proof.mts).
 */
export function NativePushBootstrap() {
  const router = useRouter();
  useEffect(() => {
    let isAndroid = false;
    try {
      isAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
    } catch {
      isAndroid = false;
    }
    if (!isAndroid) {
      // A browser whose person already turned push on: re-bind its subscription to this login session (silent, no
      // prompt, same user only — the engine pushes only to devices with a live session). Loaded on demand.
      let granted = false;
      try {
        granted = typeof Notification !== "undefined" && Notification.permission === "granted" && "serviceWorker" in navigator;
      } catch {
        granted = false;
      }
      if (granted) void import("@/lib/push/push-client").then((p) => p.refreshPushBinding()).catch(() => {});
      return;
    }
    let cancelled = false;
    let detach: (() => void) | null = null;
    void import("@/lib/native/push-notifications")
      .then((push) => {
        if (cancelled || !push.isNativePushAvailable()) return;
        push.setPushNavigator((href) => router.push(href));
        push.startNativePushOnAppStart();
        detach = () => push.setPushNavigator(null);
      })
      .catch(() => {
        /* the client failed to load: no push on this start, the app itself is unaffected */
      });
    return () => {
      cancelled = true;
      detach?.();
    };
  }, [router]);
  return null;
}
