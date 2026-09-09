"use client";

/**
 * Mounts the refresh coordinator once, inside the authenticated shell.
 *
 * Renders nothing. It exists because the coordinator needs a lifetime tied to
 * the app being open, and the shell layout is the one place every signed-in
 * screen passes through — the alternative was a fetch wrapper across 81 call
 * sites to solve a problem none of them have.
 */

import { useEffect } from "react";
import { startRefreshCoordinator } from "@/lib/auth/refresh-client";

export function RefreshCoordinator() {
  useEffect(() => {
    const handle = startRefreshCoordinator();
    return () => handle.stop();
  }, []);

  return null;
}
