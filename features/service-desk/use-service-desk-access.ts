"use client";

/**
 * The business's Service Desk mode, from the server (GET /api/service-desk/access). The capabilities flag cannot express
 * READ_ONLY, so the screens ask the gate itself. Fail-closed: anything but a FULL / READ_ONLY answer is "not open".
 */
import { useCallback, useEffect, useState } from "react";

import { getAccess, type ServiceDeskMode } from "./service-desk-client";

export type AccessState = { status: "loading" } | { status: "none" } | { status: "error" } | { status: "open"; mode: ServiceDeskMode };

export function useServiceDeskAccess(): { access: AccessState; retry: () => void } {
  const [access, setAccess] = useState<AccessState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    getAccess().then(
      (mode) => live && setAccess(mode === null ? { status: "none" } : { status: "open", mode }),
      () => live && setAccess({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  const retry = useCallback(() => {
    setAccess({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { access, retry };
}
