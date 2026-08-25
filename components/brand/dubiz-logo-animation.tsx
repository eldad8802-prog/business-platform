"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * DubizLogoAnimation — a short, self-contained brand intro.
 *
 * Particles are sampled from the pixels of the existing logo asset
 * (`/public/dubiz-logo.png`) and animate from a scattered cloud into the crisp
 * logo: the dot-matrix "D" (left) assembles first, the "dubiz" wordmark (right)
 * follows, then it holds sharp for a beat. Pure Canvas 2D — no dependency, no
 * Three.js. The logo file is only *read* (drawn to an offscreen canvas); it is
 * never modified.
 *
 * UX guarantees:
 * - Respects `prefers-reduced-motion`: renders a static <img> only, no canvas.
 * - Fixed box (width × derived height) → no layout shift.
 * - devicePixelRatio-aware (capped at 2) → sharp on retina, cheap on mobile.
 * - Isolated: not wired into login/app shell. Intended for a demo route first.
 */

const LOGO_RATIO = 266 / 827; // native height / width

type Props = {
  /** Source logo (transparent PNG). Defaults to the shipped brand logo. */
  src?: string;
  /** Display width in px; height is derived from the logo's aspect ratio. */
  width?: number;
  /** Build duration in ms (1200–1800 recommended). */
  duration?: number;
  /** Hold (crisp logo) after the build, in ms, before onDone fires. */
  holdMs?: number;
  /** Fired once the animation (build + hold) completes. */
  onDone?: () => void;
  className?: string;
  style?: React.CSSProperties;
};

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Reduced-motion as an external store (SSR-safe, no setState-in-effect).
const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";
function subscribeReduced(cb: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(REDUCE_QUERY);
  mq.addEventListener?.("change", cb);
  return () => mq.removeEventListener?.("change", cb);
}
const getReduced = () =>
  typeof window !== "undefined" && !!window.matchMedia
    ? window.matchMedia(REDUCE_QUERY).matches
    : false;
const getReducedServer = () => false;

type Particle = {
  tx: number; ty: number;       // target (logo pixel)
  sx: number; sy: number;       // scattered start
  r: number; g: number; b: number;
  appear: number;               // 0..~0.45 stagger (by x → D first)
  sz: number;                   // base radius
};

export function DubizLogoAnimation({
  src = "/dubiz-logo.png",
  width = 420,
  duration = 1500,
  holdMs = 500,
  onDone,
  className,
  style,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useSyncExternalStore(subscribeReduced, getReduced, getReducedServer);
  const height = Math.round(width * LOGO_RATIO);

  useEffect(() => {
    if (reduced) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let cancelled = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.scale(dpr, dpr);

    const img = new Image();
    img.decoding = "async";
    img.src = src;

    const onImg = () => {
      if (cancelled) return;

      // Sample the logo pixels into particle targets.
      const off = document.createElement("canvas");
      off.width = width;
      off.height = height;
      const octx = off.getContext("2d");
      if (!octx) return;
      octx.drawImage(img, 0, 0, width, height);
      const data = octx.getImageData(0, 0, width, height).data;

      // Step tuned to keep the particle count reasonable (~2–3k) on any size.
      const step = width >= 380 ? 4 : 3;
      const cx = width / 2;
      const cy = height / 2;
      const diag = Math.hypot(width, height);
      const parts: Particle[] = [];
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          const i = (y * width + x) * 4;
          if (data[i + 3] < 110) continue; // skip transparent
          const ang = Math.random() * Math.PI * 2;
          const dist = diag * (0.32 + Math.random() * 0.5);
          parts.push({
            tx: x,
            ty: y,
            r: data[i],
            g: data[i + 1],
            b: data[i + 2],
            sx: cx + Math.cos(ang) * dist,
            sy: cy + Math.sin(ang) * dist,
            appear: (x / width) * 0.42 + Math.random() * 0.06, // D (low x) first
            sz: 0.8 + Math.random() * 1.05,
          });
        }
      }

      let startedAt = 0;
      const frame = (now: number) => {
        if (cancelled) return;
        if (!startedAt) startedAt = now;
        const gp = clamp((now - startedAt) / duration, 0, 1); // global build progress
        const imgAlpha = gp < 0.82 ? 0 : (gp - 0.82) / 0.18;  // crossfade to crisp logo

        ctx.clearRect(0, 0, width, height);
        for (let k = 0; k < parts.length; k++) {
          const p = parts[k];
          const lp = clamp((gp - p.appear) / 0.58, 0, 1);
          const e = easeOutCubic(lp);
          const x = p.sx + (p.tx - p.sx) * e;
          const y = p.sy + (p.ty - p.sy) * e;
          ctx.globalAlpha = (0.12 + 0.88 * e) * (1 - imgAlpha);
          ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
          ctx.beginPath();
          ctx.arc(x, y, p.sz * (0.5 + 0.5 * e), 0, Math.PI * 2);
          ctx.fill();
        }
        if (imgAlpha > 0) {
          ctx.globalAlpha = imgAlpha;
          ctx.drawImage(img, 0, 0, width, height);
        }
        ctx.globalAlpha = 1;

        if (gp < 1) {
          raf = requestAnimationFrame(frame);
        } else {
          // Land on the crisp asset.
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
          if (onDone) window.setTimeout(onDone, holdMs);
        }
      };
      raf = requestAnimationFrame(frame);
    };

    if (img.complete) onImg();
    else img.onload = onImg;

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [reduced, width, height, src, duration, holdMs, onDone]);

  // Reduced motion → static logo only (no canvas, no animation).
  if (reduced) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt="Dubiz"
        width={width}
        height={height}
        className={className}
        style={{ width, height, objectFit: "contain", display: "block", ...style }}
      />
    );
  }

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="Dubiz"
      className={className}
      style={{ width, height, display: "block", ...style }}
    />
  );
}
