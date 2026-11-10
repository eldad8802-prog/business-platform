"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { initNativeShell } from "@/lib/native/native-shell";
import { ensureAndroidShellViewport } from "@/lib/native/android-viewport-fit";
import { leaveMarketingInAndroidShell } from "@/lib/native/android-shell-entry";

/**
 * Mounted once in the root layout. In a plain browser this renders nothing and
 * initNativeShell() no-ops; inside the Capacitor shells it wires the native
 * runtime contract (back, status bar, splash hide). See lib/native/native-shell.ts.
 */
export function NativeShellInit() {
  const pathname = usePathname();
  useEffect(() => {
    // Android shell: backstop for pages where the root layout's inline viewport script did not run.
    ensureAndroidShellViewport();
    void initNativeShell();
  }, []);
  // Android shell: the app never shows the marketing page, also after an in-app navigation.
  useEffect(() => {
    leaveMarketingInAndroidShell(pathname);
  }, [pathname]);
  return null;
}
