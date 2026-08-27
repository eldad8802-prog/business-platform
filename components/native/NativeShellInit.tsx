"use client";

import { useEffect } from "react";
import { initNativeShell } from "@/lib/native/native-shell";

/**
 * Mounted once in the root layout. In a plain browser this renders nothing and
 * initNativeShell() no-ops; inside the Capacitor shells it wires the native
 * runtime contract (back, status bar, splash hide). See lib/native/native-shell.ts.
 */
export function NativeShellInit() {
  useEffect(() => {
    void initNativeShell();
  }, []);
  return null;
}
