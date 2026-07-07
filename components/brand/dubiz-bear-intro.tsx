"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * DubizBearIntro — the "chaos → order" brand story, isolated prototype.
 *
 * One pool of particles (same dot DNA as the logo, colours sampled from the
 * brand palette) tells the whole story:
 *   scattered dots → a dot-matrix teddy bear (the assistant) → it lives for a
 *   beat (eyes, smile, a small wave) → it disperses → the dots are pulled into
 *   a vortex → they rebuild the logo (the "D" first, then the wordmark) → the
 *   crisp logo holds → hand-off.
 *
 * Pure Canvas 2D, additive glow, no dependency. Reads `/dubiz-logo.png` only.
 * Respects prefers-reduced-motion (renders the static crisp logo, no canvas).
 * Not wired into login/app-shell — demo/prototype only.
 */

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";
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

// Palette tuned to read on a warm CREAM background (per the final concept):
// deep→mid→light teal that stays legible, plus a warm GOLD accent (a pale cream
// dot would vanish on cream). The final crisp logo is the real turquoise asset.
const STOPS: [number, number, number][] = [
  [15, 111, 104],   // #0F6F68 deep teal
  [30, 138, 130],   // #1E8A82 mid
  [52, 179, 170],   // #34B3AA light-but-legible teal
];
const CREAM: [number, number, number] = [201, 138, 46]; // #C98A2E warm gold accent

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const easeIO = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

function gradient(t: number): [number, number, number] {
  t = clamp(t, 0, 1);
  const seg = t < 0.5 ? 0 : 1;
  const f = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  const a = STOPS[seg];
  const b = STOPS[seg + 1];
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}

type Grp = "body" | "armR" | "eye" | "mouth";
type P = {
  bx: number; by: number;   // bear (normalised 0..1 square)
  lx: number; ly: number;   // logo (normalised band)
  cx: number; cy: number;   // chaos start
  ox: number; oy: number;   // scattered-out (disperse)
  r: number;                // base radius
  col: string;
  grp: Grp;
  seed: number;
  stag: number;             // 0..1 build-stagger (by logo x → D first)
};

// Sitting teddy built from filled ellipses → rasterised → sampled as dots,
// so it shares the logo's halftone DNA (same sampler, same palette).
type Blob = { x: number; y: number; rx: number; ry: number };
const BEAR: Blob[] = [
  { x: 0.5, y: 0.62, rx: 0.235, ry: 0.24 }, // body
  { x: 0.5, y: 0.31, rx: 0.2, ry: 0.19 },   // head
  { x: 0.33, y: 0.16, rx: 0.078, ry: 0.078 },// ear L
  { x: 0.67, y: 0.16, rx: 0.078, ry: 0.078 },// ear R
  { x: 0.5, y: 0.37, rx: 0.1, ry: 0.075 },   // muzzle
  { x: 0.27, y: 0.55, rx: 0.075, ry: 0.12 }, // arm L
  { x: 0.73, y: 0.5, rx: 0.072, ry: 0.115 }, // arm R (raised)
  { x: 0.39, y: 0.84, rx: 0.088, ry: 0.088 },// leg L
  { x: 0.61, y: 0.84, rx: 0.088, ry: 0.088 },// leg R
];

function groupOf(x: number, y: number): Grp {
  if (x > 0.63 && y > 0.38 && y < 0.64) return "armR";
  if (y > 0.26 && y < 0.34 && (Math.abs(x - 0.43) < 0.035 || Math.abs(x - 0.57) < 0.035)) return "eye";
  if (y > 0.35 && y < 0.42 && x > 0.42 && x < 0.58) return "mouth";
  return "body";
}

export function DubizBearIntro({
  width = 460,
  src = "/dubiz-logo.png",
  loop = true,
  onDone,
  style,
}: {
  width?: number;
  src?: string;
  loop?: boolean;
  onDone?: () => void;
  style?: React.CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useSyncExternalStore(subReduced, getReduced, () => false);
  const height = Math.round(width * 0.72);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cancelled = false;
    let raf = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const setup = (img: HTMLImageElement | null) => {
      // ---- sample the bear (rasterise ellipses → grid sample) ----
      const S = 300;
      const off = document.createElement("canvas");
      off.width = S; off.height = S;
      const octx = off.getContext("2d");
      if (!octx) return;
      octx.fillStyle = "#fff";
      for (const b of BEAR) {
        octx.beginPath();
        octx.ellipse(b.x * S, b.y * S, b.rx * S, b.ry * S, 0, 0, Math.PI * 2);
        octx.fill();
      }
      const bd = octx.getImageData(0, 0, S, S).data;
      const bear: { x: number; y: number; g: Grp }[] = [];
      const step = 6;
      for (let y = 0; y < S; y += step) {
        for (let x = 0; x < S; x += step) {
          if (bd[(y * S + x) * 4 + 3] > 40) {
            const nx = (x + (Math.random() - 0.5) * step) / S;
            const ny = (y + (Math.random() - 0.5) * step) / S;
            bear.push({ x: nx, y: ny, g: groupOf(nx, ny) });
          }
        }
      }
      const N = bear.length;

      // ---- sample the logo to exactly N points (normalised band) ----
      const logo: { x: number; y: number }[] = [];
      if (img) {
        const lw = 220;
        const lh = Math.max(1, Math.round((lw * img.height) / img.width));
        const lo = document.createElement("canvas");
        lo.width = lw; lo.height = lh;
        const lctx = lo.getContext("2d");
        if (lctx) {
          lctx.drawImage(img, 0, 0, lw, lh);
          const ld = lctx.getImageData(0, 0, lw, lh).data;
          const ink: { x: number; y: number }[] = [];
          for (let y = 0; y < lh; y++)
            for (let x = 0; x < lw; x++)
              if (ld[(y * lw + x) * 4 + 3] > 110) ink.push({ x: x / lw, y: y / lh });
          const ratio = lh / lw;
          for (let i = 0; i < N; i++) {
            const s = ink.length ? ink[(Math.random() * ink.length) | 0] : { x: 0.5, y: 0.5 };
            logo.push({ x: s.x, y: 0.5 + (s.y - 0.5) * ratio });
          }
        }
      }
      while (logo.length < N) logo.push({ x: Math.random(), y: 0.5 });

      // ---- build particle pool ----
      const parts: P[] = [];
      for (let i = 0; i < N; i++) {
        const be = bear[i];
        const lg = logo[i];
        const ang = Math.random() * Math.PI * 2;
        const dirx = be.x - 0.5, diry = be.y - 0.5;
        const dl = Math.hypot(dirx, diry) || 1;
        const outD = 0.35 + Math.random() * 0.4;
        const isCream = Math.random() < 0.08;
        const col = isCream ? CREAM : gradient(lg.x * 1.05);
        parts.push({
          bx: be.x, by: be.y,
          lx: lg.x, ly: lg.y,
          cx: 0.5 + Math.cos(ang) * (0.5 + Math.random() * 0.7),
          cy: 0.5 + Math.sin(ang) * (0.5 + Math.random() * 0.7),
          ox: be.x + (dirx / dl) * outD, oy: be.y + (diry / dl) * outD,
          r: 0.9 + Math.random() * 1.7,
          col: `${col[0]},${col[1]},${col[2]}`,
          grp: be.g,
          seed: Math.random() * 6.28,
          stag: lg.x,
        });
      }

      // ---- timeline (ms) ----
      const PH: [string, number][] = [
        ["appear", 1000],
        ["assemble", 2600],
        ["life", 2600],
        ["lean", 1300],
        ["disperse", 1100],
        ["vortex", 1300],
        ["buildD", 1600],
        ["hold", 1000],
        ["wordmark", 1200],
        ["rest", 1400],
      ];
      const TOTAL = PH.reduce((s, p) => s + p[1], 0);

      let W = 0, H = 0, S2 = 0, ox0 = 0, oy0 = 0;
      const resize = () => {
        W = canvas.clientWidth; H = canvas.clientHeight;
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        S2 = Math.min(W * 0.8, H * 0.86);
        ox0 = (W - S2) / 2; oy0 = (H - S2) / 2;
      };
      const mx = (nx: number) => ox0 + nx * S2;
      const my = (ny: number) => oy0 + ny * S2;
      resize();
      const ro = window.ResizeObserver ? new ResizeObserver(resize) : null;
      ro?.observe(canvas);
      if (!ro) window.addEventListener("resize", resize);

      const drawStatic = () => {
        ctx.clearRect(0, 0, W, H);
        if (img) {
          const w = S2, h = w * (img.height / img.width);
          ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
        }
      };
      if (reduced) { drawStatic(); return; }

      const cxN = 0.5, cyN = 0.5;
      let start = 0;
      let finished = false;

      const frame = (now: number) => {
        if (cancelled) return;
        if (!start) start = now;
        let tm = now - start;
        if (loop) tm %= TOTAL;
        else if (tm > TOTAL) tm = TOTAL;

        let idx = 0, acc = 0;
        while (idx < PH.length - 1 && tm > acc + PH[idx][1]) { acc += PH[idx][1]; idx++; }
        const ph = PH[idx][0];
        const lt = clamp((tm - acc) / PH[idx][1], 0, 1);

        // crossfade to the crisp logo across wordmark + rest
        let imgA = 0;
        if (ph === "wordmark") imgA = easeIO(lt) * 0.85;
        else if (ph === "rest") imgA = 0.85 + easeIO(lt) * 0.15;

        ctx.clearRect(0, 0, W, H);
        // Solid stipple on a light ground (no additive glow — that only reads on dark).
        ctx.globalCompositeOperation = "source-over";

        const cX = mx(cxN), cY = my(cyN);
        for (let i = 0; i < N; i++) {
          const p = parts[i];
          let nx = p.bx, ny = p.by, rr = p.r, a = 1;

          if (ph === "appear") {
            nx = p.cx; ny = p.cy; a = easeOut(lt) * 0.9;
            nx += Math.sin(now * 0.0009 + p.seed) * 0.01;
            ny += Math.cos(now * 0.0008 + p.seed) * 0.01;
          } else if (ph === "assemble") {
            const e = easeIO(lt);
            nx = lerp(p.cx, p.bx, e); ny = lerp(p.cy, p.by, e); a = 0.9;
          } else if (ph === "life" || ph === "lean") {
            nx = p.bx; ny = p.by;
            const br = Math.sin(now * 0.0016 + p.seed) * 0.0035;
            nx += br; ny += Math.cos(now * 0.0014 + p.seed) * 0.003;
            if (ph === "life") {
              if (p.grp === "armR") { const wv = Math.sin(now * 0.007) * 0.03 * Math.sin(lt * Math.PI); ny += wv - 0.01 * Math.sin(lt * Math.PI); nx += Math.cos(now * 0.007) * 0.008; }
              if (p.grp === "mouth") ny -= 0.012 * Math.sin(lt * Math.PI) * Math.abs(Math.cos((p.bx - 0.5) * 12));
              if (p.grp === "eye") { const blink = Math.sin(now * 0.003) > 0.94 ? 0.3 : 1; a = blink; rr = p.r * (1.5 + 0.3 * Math.sin(now * 0.004)); }
            } else {
              const j = easeIO(lt);
              const s = 1 + 0.05 * Math.sin(j * Math.PI);         // subtle forward "breath/jump"
              nx = cxN + (p.bx - cxN) * s; ny = cyN + (p.by - cyN) * s - 0.02 * Math.sin(j * Math.PI);
            }
          } else if (ph === "disperse") {
            const e = easeIO(lt);
            nx = lerp(p.bx, p.ox, e); ny = lerp(p.by, p.oy, e); a = 1 - 0.15 * e;
          } else if (ph === "vortex") {
            const e = easeIO(lt);
            const vx = lerp(p.ox, cxN, e), vy = lerp(p.oy, cyN, e);
            const rot = e * Math.PI * 1.6 + p.seed * 0.2;
            const sx = vx - cxN, sy = vy - cyN, ca = Math.cos(rot), sa = Math.sin(rot);
            nx = cxN + (sx * ca - sy * sa); ny = cyN + (sx * sa + sy * ca);
            a = 0.7 + 0.3 * (1 - e);
          } else if (ph === "buildD") {
            const local = clamp((lt - p.stag * 0.5) / (1 - p.stag * 0.5 + 0.001), 0, 1);
            const e = easeOut(local);
            nx = lerp(cxN, p.lx, e); ny = lerp(cyN, p.ly, e);
            a = 1 - imgA;
          } else { // hold / wordmark / rest
            nx = p.lx; ny = p.ly; a = 1 - imgA;
          }

          if (a <= 0.01) continue;
          const x = mx(nx), y = my(ny);
          ctx.globalAlpha = a;
          ctx.fillStyle = `rgb(${p.col})`;
          ctx.beginPath();
          ctx.arc(x, y, Math.max(0.5, rr), 0, Math.PI * 2);
          ctx.fill();
        }

        // crisp logo crossfade (normal compositing on top)
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        if (imgA > 0 && img) {
          const w = S2, h = w * (img.height / img.width);
          ctx.globalAlpha = imgA;
          ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
          ctx.globalAlpha = 1;
        }
        void cX; void cY;

        if (!loop && tm >= TOTAL) {
          if (!finished) { finished = true; drawStatic(); onDone?.(); }
          return;
        }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      cleanup = () => { ro?.disconnect(); if (!ro) window.removeEventListener("resize", resize); };
    };

    let cleanup = () => {};
    const img = new Image();
    img.decoding = "async";
    img.onload = () => { if (!cancelled) setup(img); };
    img.onerror = () => { if (!cancelled) setup(null); };
    img.src = src;
    if (img.complete && img.naturalWidth) setup(img);

    return () => { cancelled = true; cancelAnimationFrame(raf); cleanup(); };
  }, [reduced, width, height, src, loop, onDone]);

  if (reduced) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="Dubiz" width={width} height={Math.round(width * (266 / 827))}
        style={{ width, height: "auto", objectFit: "contain", display: "block", ...style }} />
    );
  }
  return (
    <canvas ref={canvasRef} role="img" aria-label="Dubiz"
      style={{ width, height, display: "block", ...style }} />
  );
}
