"use client";

/**
 * Holds the authenticated shell until boot has decided, then keeps the access
 * token fresh for as long as the app is open.
 *
 * WHY IT GATES RENDERING AT ALL
 *
 * React runs effects child-first. Every screen fires its own authenticated
 * fetches from its own effect, so those effects run BEFORE any effect in a
 * parent — which means a coordinator that merely started here would always lose
 * the race to the requests it exists to precede. A browser returning from sleep
 * with a spent token would fire a screenful of 401s and only then refresh.
 *
 * Gating the render is the way to order that without a fetch wrapper, and a
 * wrapper would mean editing 81 call sites to solve a problem none of them have.
 *
 * WHY IT COSTS THE HEALTHY PATH NOTHING
 *
 * The decision is synchronous — it is a timestamp in localStorage — and it is
 * taken in a LAYOUT effect, before the browser paints. A healthy token opens the
 * gate in the same frame, with no network call and no rotation. Only a token
 * that is actually spent waits, and only for one POST.
 *
 * The first render returns null on the server and on the client alike, so
 * nothing here can produce a hydration mismatch.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  bootstrapDecision,
  bootstrapRefresh,
  startRefreshCoordinator,
} from "@/lib/auth/refresh-client";

/**
 * A refresh that never answers must not wedge the app behind a blank screen.
 * Opening the gate is safe: it is an ordering device, not an access control —
 * the server decides every request on its own merits either way.
 */
const MAX_HOLD_MS = 5000;

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function RefreshCoordinator({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const started = useRef(false);

  useIsomorphicLayoutEffect(() => {
    if (started.current) return;
    started.current = true;

    let cancelled = false;
    const release = () => {
      if (!cancelled) setOpen(true);
    };

    // Synchronous, so the common case never waits for a microtask.
    if (bootstrapDecision() !== "must_refresh") {
      release();
    }

    const safety = setTimeout(release, MAX_HOLD_MS);
    void bootstrapRefresh().finally(() => {
      clearTimeout(safety);
      release();
    });

    const handle = startRefreshCoordinator({ skipBoot: true });

    return () => {
      cancelled = true;
      clearTimeout(safety);
      handle.stop();
    };
  }, []);

  // Nothing, not a spinner and not a sign-in screen: this window is either zero
  // frames or one request long, and painting a login here would flash it at
  // someone who is perfectly well signed in.
  if (!open) return null;
  return <>{children}</>;
}
