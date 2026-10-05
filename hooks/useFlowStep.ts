"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import {
  acquireBackLock,
  consumeFlowEntries,
  findEarlierEntry,
  subscribeTrail,
} from "@/lib/navigation/back-nav/trail-runtime";

/**
 * In-screen flow steps as REAL history entries.
 *
 * A step held only in React state is invisible to back: the back control (and
 * the browser's Back) would leave the whole flow from step 3. With this hook
 * every step change pushes an entry on the same route (`?step=<name>`), so:
 *  - the canonical BackButton walks the steps in the order the user actually
 *    took them (not a static "previous step" table), then leaves the flow to
 *    wherever it was entered from;
 *  - browser Back / Forward move through the same steps;
 *  - the data the user entered stays — the screen component stays mounted,
 *    only the step changes.
 *
 * The route must declare `step` (or the chosen param) in its route-registry
 * `identityParams`, so each step is a distinct screen in the trail.
 *
 * `canShow(step)` guards a step that needs data the screen does not have (a
 * refresh or a deep link into step 3): the step falls back to the first one
 * and the URL is corrected with replace — never a broken half-step.
 *
 * `replaceStep` is ONLY for a step that follows a COMPLETED action (something
 * was created / sent): the finished step is replaced so back cannot return
 * into it and re-trigger the action. Every such use must say why.
 */
export function useFlowStep<S extends string>({
  steps,
  param = "step",
  canShow,
}: {
  steps: readonly S[];
  param?: string;
  canShow?: (step: S) => boolean;
}) {
  const pathname = usePathname() || "/";
  const first = steps[0];
  // Read from the location through the navigation trail (which emits on every
  // push / replace / popstate) rather than useSearchParams: no Suspense
  // boundary is required on the host page, and the server render — like the
  // first client render — shows the first step.
  const raw = useSyncExternalStore(
    subscribeTrail,
    () => new URLSearchParams(window.location.search).get(param),
    () => null,
  );

  const requested: S = raw !== null && (steps as readonly string[]).includes(raw) ? (raw as S) : first;
  const step: S = requested === first || !canShow || canShow(requested) ? requested : first;

  const urlFor = useCallback(
    (next: S) => {
      const params = new URLSearchParams(window.location.search);
      if (next === first) params.delete(param);
      else params.set(param, next);
      const qs = params.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [first, param, pathname],
  );

  // Unknown / not-yet-showable step in the URL → correct it in place.
  useEffect(() => {
    if (raw !== null && raw !== step && !(raw === first && step === first)) {
      window.history.replaceState(null, "", urlFor(step));
    }
  }, [raw, step, first, urlFor]);

  const go = useCallback(
    (next: S) => {
      if (next === step) return;
      // Next.js integrates native pushState: useSearchParams updates, the page
      // stays mounted (entered data kept), and the trail records the entry.
      window.history.pushState(null, "", urlFor(next));
      // A new step starts at its top; going BACK restores the step's own
      // scroll (navigation trail), so this never fights restoration.
      window.scrollTo(0, 0);
    },
    [step, urlFor],
  );

  const replaceStep = useCallback(
    (next: S) => {
      window.history.replaceState(null, "", urlFor(next));
    },
    [urlFor],
  );

  /**
   * "Return to step X" (cancel a sub-flow, "back to catalog"): pops history to
   * the nearest earlier entry showing that step, so no duplicate is stacked
   * and back from there keeps leaving the flow the way it was entered. With no
   * such entry (deep link / refresh), the step is shown via replace.
   */
  const backTo = useCallback(
    (target: S) => {
      const wanted = new URL(urlFor(target), window.location.origin);
      const delta = findEarlierEntry((url) => {
        const u = new URL(url, window.location.origin);
        return u.pathname === wanted.pathname && (u.searchParams.get(param) ?? first) === target;
      });
      if (delta !== null && acquireBackLock()) window.history.go(delta);
      else if (delta === null) window.history.replaceState(null, "", urlFor(target));
    },
    [urlFor, param, first],
  );

  /**
   * The flow COMMITTED (created / published / redeemed…). Shows `next` in
   * place of the step that committed (replace), and marks the flow's earlier
   * steps listed in `consume` as done: back — button or browser — then leaves
   * the completed flow to where it was entered, never into a filled step that
   * would offer the same commit again. `also` narrows which entries belong to
   * this flow when the route hosts other views (e.g. ?view=create).
   */
  const complete = useCallback(
    (next: S, consume: readonly S[], also?: (u: URL) => boolean) => {
      window.history.replaceState(null, "", urlFor(next));
      consumeFlowEntries((url) => {
        const u = new URL(url, window.location.origin);
        const st = (u.searchParams.get(param) ?? first) as S;
        return u.pathname === pathname && consume.includes(st) && (also ? also(u) : true);
      });
    },
    [urlFor, param, first, pathname],
  );

  return useMemo(() => ({ step, go, replaceStep, backTo, complete }), [step, go, replaceStep, backTo, complete]);
}
