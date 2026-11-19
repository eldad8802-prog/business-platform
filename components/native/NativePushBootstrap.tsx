"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Capacitor } from "@capacitor/core";

/**
 * Native push wiring for the authenticated app. Renders nothing.
 *
 * Mounted by the outermost RefreshCoordinator once its gate is open, i.e. only on
 * authenticated screens and only after the session was decided. In a browser it does
 * nothing at all. In the Android app it wires the tap / foreground listeners and
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
    if (!isAndroid) return;
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
