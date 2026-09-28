/**
 * Watches the ONE synchronous FB.login call for Meta's window. The Facebook SDK
 * resolves `window.open` at call time, so a wrapper installed just around the
 * call sees whether the browser opened or refused the window (verified against
 * the real SDK). Only the returned-window boolean is kept; the URL, the window
 * and its contents are never read. The original is always restored.
 */
export function observeWindowOpen(
  fn: () => void,
  target: { open: (...args: never[]) => unknown } | undefined = typeof window === "undefined" ? undefined : window
): { opened: boolean | null } {
  if (!target || typeof target.open !== "function") {
    fn();
    return { opened: null };
  }
  const host = target;
  const original = host.open;
  let opened: boolean | null = null;
  const watcher = function (this: unknown, ...args: never[]) {
    const w = (original as (...a: never[]) => unknown).apply(host, args);
    opened = (opened ?? false) || !!w;
    return w;
  };
  host.open = watcher;
  try {
    fn();
  } finally {
    if (host.open === watcher) host.open = original;
  }
  return { opened };
}

