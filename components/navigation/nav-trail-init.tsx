"use client";

import { useEffect } from "react";
import { installNavTrail } from "@/lib/navigation/back-nav/trail-runtime";

/**
 * Installs the navigation trail once per document (root layout). Renders
 * nothing. See lib/navigation/back-nav/trail-runtime.ts.
 */
export function NavTrailInit() {
  useEffect(() => {
    installNavTrail();
  }, []);
  return null;
}
