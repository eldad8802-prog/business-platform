"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { DubizBearIntro } from "./dubiz-bear-intro";

/**
 * DubizIntroOverlay — the brand entry experience that REPLACES the old skeleton
 * loading screen on the first authenticated entry to /app in a session.
 *
 * Design goals (all met without touching auth/data logic):
 * - No flash / no white / no skeleton: a preboot inline script (see the shell
 *   layout) paints cream before first paint; this overlay takes over seamlessly.
 * - Runs in parallel with /api/home — never delays the fetch.
 * - Finishes naturally if the app is ready early; holds the crisp logo if the
 *   app is ready late; fades out only when BOTH the animation is done AND the
 *   app has settled (`appReady`). Safety auto-dismiss so it never traps.
 * - Once per session (sessionStorage). Internal navigations never replay it.
 * - Respects prefers-reduced-motion (static logo, no animation).
 * - Fixed overlay → zero layout shift; opacity fade → no reflow.
 */

const FLAG = "dubiz.intro.v1";
const PREBOOT_ID = "dubiz-intro-preboot";
const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

const noopSub = () => () => {};
const useMounted = () => useSyncExternalStore(noopSub, () => true, () => false);

function subReduced(cb: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(REDUCE_QUERY);
  mq.addEventListener?.("change", cb);
  return () => mq.removeEventListener?.("change", cb);
}
const getReduced = () =>
  typeof window !== "undefined" && !!window.matchMedia
    ? window.matchMedia(REDUCE_QUERY).matches
    : false;

function decidePlay(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (sessionStorage.getItem(FLAG)) return false;      // already shown this session
    if (!localStorage.getItem("token")) return false;    // authenticated entry only
    return true;
  } catch {
    return false;
  }
}

function computeWidth(): number {
  if (typeof window === "undefined") return 420;
  return Math.round(Math.min(480, Math.max(260, window.innerWidth * 0.86)));
}

export function DubizIntroOverlay({ appReady }: { appReady: boolean }) {
  const mounted = useMounted();
  const reduced = useSyncExternalStore(subReduced, getReduced, () => false);
  // Decide once, on the first client render (SSR returns false → overlay is null;
  // the preboot cream backdrop covers the gap until this mounts).
  const [play] = useState(decidePlay);
  const [width, setWidth] = useState(computeWidth);
  const [animDone, setAnimDone] = useState(false);
  const [gone, setGone] = useState(false);
  const doneRef = useRef(false);

  const markDone = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setAnimDone(true);
  };

  // Take over from the preboot backdrop + claim the once-per-session flag.
  useEffect(() => {
    if (!mounted) return;
    const pre = document.getElementById(PREBOOT_ID);
    if (!play) {
      // Not playing → reveal the shell immediately and drop the preboot layer.
      try { document.documentElement.removeAttribute("data-dubiz-intro"); } catch { /* noop */ }
      pre?.remove();
      return;
    }
    try { sessionStorage.setItem(FLAG, "1"); } catch { /* private mode — plays once anyway */ }
    // Remove the preboot layer on the next frame, once our cream overlay is painted.
    // The shell stays hidden (data-dubiz-intro) beneath us until the fade begins.
    const id = requestAnimationFrame(() => pre?.remove());
    return () => cancelAnimationFrame(id);
  }, [mounted, play]);

  // Responsive width.
  useEffect(() => {
    if (!play) return;
    const onResize = () => setWidth(computeWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [play]);

  // Reduced motion: the static logo has no timeline → treat as "done" after a
  // graceful minimum display so it isn't a flash.
  useEffect(() => {
    if (!play || !reduced) return;
    const id = window.setTimeout(markDone, 900);
    return () => window.clearTimeout(id);
  }, [play, reduced]);

  // Safety net: never trap the user behind the splash.
  useEffect(() => {
    if (!play) return;
    const id = window.setTimeout(markDone, 20000);
    return () => window.clearTimeout(id);
  }, [play]);

  // Derived: begin the fade only when the animation is done AND the app settled.
  const fading = play && mounted && animDone && appReady;

  // Reveal the shell content exactly when the fade begins, so the overlay
  // crossfades to the (now visible) home. Until then it stays hidden by the
  // preboot, so the old "טוען…" / skeleton can never flash — even for a frame.
  useEffect(() => {
    if (fading) {
      try { document.documentElement.removeAttribute("data-dubiz-intro"); } catch { /* noop */ }
    }
  }, [fading]);

  // Safety: if this ever unmounts without fading, make sure the shell is visible.
  useEffect(() => () => {
    try { document.documentElement.removeAttribute("data-dubiz-intro"); } catch { /* noop */ }
  }, []);

  // After the fade completes, unmount entirely.
  useEffect(() => {
    if (!fading) return;
    const id = window.setTimeout(() => setGone(true), 560);
    return () => window.clearTimeout(id);
  }, [fading]);

  if (!play || !mounted || gone) return null;

  // Portal to <body> so the overlay lives in the ROOT stacking context and truly
  // covers everything — the shell's content div is a stacking context (z-index:1),
  // which would otherwise trap the overlay below the fixed bottom nav (z-100) and
  // the accessibility FAB (z-101).
  return createPortal(
    <div
      aria-hidden="true"
      data-dubiz-intro-overlay=""
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483600,
        display: "grid",
        placeItems: "center",
        background:
          "radial-gradient(circle at 50% 38%, #FDFBF6 0%, #F5EFE2 58%, #EDE4D3 100%)",
        opacity: fading ? 0 : 1,
        transition: "opacity 520ms ease",
        pointerEvents: fading ? "none" : "auto",
        // isolate so the fade is a cheap compositor op (no reflow)
        willChange: "opacity",
      }}
    >
      <DubizBearIntro width={width} loop={false} onDone={markDone} />
    </div>,
    document.body
  );
}
