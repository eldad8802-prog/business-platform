"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * DubizBearIntro — the "chaos → order" brand story with the Dubiz mascot.
 *
 * One particle pool (the same dot DNA as the logo) forms a warm, recognisable
 * teddy-bear mascot — clean proportions, a friendly face with living eyes
 * (blink), a small smile, clear ears — built ENTIRELY from Dubiz dots, as if the
 * logo itself became a character. It lives for a beat (blink · smile · head-tilt
 * · gentle wave), disperses, is pulled into a vortex, and rebuilds the logo
 * (the "D" first, then the wordmark), landing on the crisp asset.
 *
 * Depth comes only from Canvas 2D craft — dot SIZE (larger toward each form's
 * core, smaller at the rim = halftone volume), subtle TONE by light direction,
 * and warm gold accents. No heavy 3D, no dependency. Reads /dubiz-logo.png only.
 * Respects prefers-reduced-motion (static crisp logo). Demo/prototype — not
 * wired into login/app-shell.
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

type RGB = [number, number, number];
const DEEP: RGB = [15, 111, 104];    // #0F6F68
const MIDL: RGB = [46, 170, 162];    // #2EAAA2
const LIGHT: RGB = [104, 214, 203];  // highlight teal
const GOLD: RGB = [201, 138, 46];    // #C98A2E warm accent
const DARK: RGB = [10, 62, 58];      // eyes / nose / smile
const HILITE: RGB = [226, 244, 236]; // catch-light

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smooth = (t: number) => t * t * (3 - 2 * t);
const easeIO = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
function tealByLight(lit: number, warm: number): RGB {
  const base = lit < 0.5 ? mix(DEEP, MIDL, lit * 2) : mix(MIDL, LIGHT, (lit - 0.5) * 2);
  return warm > 0 ? mix(base, GOLD, warm) : base;
}

type Part =
  | "body" | "belly" | "head" | "muzzle" | "earL" | "earR" | "innerEarL" | "innerEarR"
  | "armL" | "armR" | "legL" | "legR" | "eye" | "eyeHi" | "nose" | "smile";

const HEAD_SET = new Set<Part>(["head", "muzzle", "earL", "earR", "innerEarL", "innerEarR", "eye", "eyeHi", "nose", "smile"]);

type Dot = { x: number; y: number; r: number; col: RGB; part: Part };

// Elliptical form parts (normalised 0..1 square). core/edge = dot radius at the
// centre vs the rim → the halftone volume. warm/light = tone bias.
type PartDef = { n: Part; x: number; y: number; rx: number; ry: number; core: number; edge: number; warm?: number; light?: number };
const FORM: PartDef[] = [
  { n: "body", x: 0.5, y: 0.66, rx: 0.2, ry: 0.225, core: 2.7, edge: 1.0 },
  { n: "belly", x: 0.5, y: 0.7, rx: 0.115, ry: 0.145, core: 2.2, edge: 1.1, warm: 0.18, light: 0.15 },
  { n: "head", x: 0.5, y: 0.34, rx: 0.185, ry: 0.172, core: 2.8, edge: 1.0 },
  { n: "muzzle", x: 0.5, y: 0.405, rx: 0.096, ry: 0.07, core: 2.0, edge: 1.0, light: 0.22 },
  { n: "earL", x: 0.34, y: 0.185, rx: 0.076, ry: 0.076, core: 2.3, edge: 1.0 },
  { n: "earR", x: 0.66, y: 0.185, rx: 0.076, ry: 0.076, core: 2.3, edge: 1.0 },
  { n: "innerEarL", x: 0.34, y: 0.19, rx: 0.037, ry: 0.037, core: 1.8, edge: 1.0, warm: 0.4 },
  { n: "innerEarR", x: 0.66, y: 0.19, rx: 0.037, ry: 0.037, core: 1.8, edge: 1.0, warm: 0.4 },
  { n: "armL", x: 0.27, y: 0.57, rx: 0.069, ry: 0.115, core: 2.3, edge: 1.0 },
  { n: "armR", x: 0.73, y: 0.55, rx: 0.067, ry: 0.11, core: 2.3, edge: 1.0 },
  { n: "legL", x: 0.4, y: 0.85, rx: 0.086, ry: 0.078, core: 2.4, edge: 1.0 },
  { n: "legR", x: 0.6, y: 0.85, rx: 0.086, ry: 0.078, core: 2.4, edge: 1.0 },
];

function buildBear(): Dot[] {
  const dots: Dot[] = [];
  const step = 0.019;
  for (const p of FORM) {
    for (let y = p.y - p.ry; y <= p.y + p.ry; y += step) {
      for (let x = p.x - p.rx; x <= p.x + p.rx; x += step) {
        const ex = (x - p.x) / p.rx;
        const ey = (y - p.y) / p.ry;
        const d = Math.hypot(ex, ey);
        if (d > 1) continue;
        const edgeT = 1 - d;                         // 1 core → 0 rim
        const r = lerp(p.edge, p.core, smooth(edgeT)) * (0.85 + Math.random() * 0.3);
        // light from upper-left of each form
        const lit = clamp(0.52 - (ex * 0.5 + ey * 0.85) * 0.5 + (Math.random() - 0.5) * 0.12, 0, 1);
        let col = tealByLight(lit, (p.warm || 0) + (p.light ? -0 : 0));
        if (p.light) col = mix(col, LIGHT, p.light);
        if (Math.random() < 0.06) col = mix(GOLD, col, 0.15); // sparse gold sparkle
        const jx = x + (Math.random() - 0.5) * step * 0.7;
        const jy = y + (Math.random() - 0.5) * step * 0.7;
        dots.push({ x: jx, y: jy, r, col, part: p.n });
      }
    }
  }
  // ---- explicit face features (drawn last → on top) ----
  const eyeR = 3.1, eyeY = 0.328;
  dots.push({ x: 0.437, y: eyeY, r: eyeR, col: DARK, part: "eye" });
  dots.push({ x: 0.563, y: eyeY, r: eyeR, col: DARK, part: "eye" });
  dots.push({ x: 0.429, y: eyeY - 0.008, r: 1.05, col: HILITE, part: "eyeHi" });
  dots.push({ x: 0.555, y: eyeY - 0.008, r: 1.05, col: HILITE, part: "eyeHi" });
  dots.push({ x: 0.5, y: 0.376, r: 2.7, col: mix(DARK, GOLD, 0.15), part: "nose" });
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const sx = 0.462 + t * 0.076;
    const sy = 0.404 + Math.sin(t * Math.PI) * 0.016; // gentle upturned smile
    dots.push({ x: sx, y: sy, r: 1.5, col: DARK, part: "smile" });
  }
  return dots;
}

function rot(x: number, y: number, cx: number, cy: number, a: number): [number, number] {
  const dx = x - cx, dy = y - cy, c = Math.cos(a), s = Math.sin(a);
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
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
      const bear = buildBear();
      const N = bear.length;

      // sample the logo to N points (normalised band)
      const logo: { x: number; y: number }[] = [];
      if (img) {
        const lw = 220, lh = Math.max(1, Math.round((lw * img.height) / img.width));
        const lc = document.createElement("canvas");
        lc.width = lw; lc.height = lh;
        const lx = lc.getContext("2d");
        if (lx) {
          lx.drawImage(img, 0, 0, lw, lh);
          const d = lx.getImageData(0, 0, lw, lh).data;
          const ink: { x: number; y: number }[] = [];
          for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++)
            if (d[(y * lw + x) * 4 + 3] > 110) ink.push({ x: x / lw, y: y / lh });
          const ratio = lh / lw;
          for (let i = 0; i < N; i++) {
            const s = ink.length ? ink[(Math.random() * ink.length) | 0] : { x: 0.5, y: 0.5 };
            logo.push({ x: s.x, y: 0.5 + (s.y - 0.5) * ratio });
          }
        }
      }
      while (logo.length < N) logo.push({ x: Math.random(), y: 0.5 });

      type P = Dot & {
        lx: number; ly: number; cx: number; cy: number; ox: number; oy: number;
        seed: number; stag: number; head: boolean;
      };
      const parts: P[] = bear.map((b, i) => {
        const ang = Math.random() * Math.PI * 2;
        const dx = b.x - 0.5, dy = b.y - 0.55, dl = Math.hypot(dx, dy) || 1;
        const out = 0.4 + Math.random() * 0.4;
        return {
          ...b,
          lx: logo[i].x, ly: logo[i].y,
          cx: 0.5 + Math.cos(ang) * (0.55 + Math.random() * 0.7),
          cy: 0.55 + Math.sin(ang) * (0.55 + Math.random() * 0.7),
          ox: b.x + (dx / dl) * out, oy: b.y + (dy / dl) * out,
          seed: Math.random() * 6.28, stag: logo[i].x, head: HEAD_SET.has(b.part),
        };
      });

      const PH: [string, number][] = [
        ["appear", 1000], ["assemble", 2600], ["life", 3000], ["lean", 1100],
        ["disperse", 1100], ["vortex", 1300], ["buildD", 1600], ["hold", 900],
        ["wordmark", 1200], ["rest", 1400],
      ];
      const TOTAL = PH.reduce((s, p) => s + p[1], 0);

      let W = 0, H = 0, S = 0, ox0 = 0, oy0 = 0, sc = 1;
      const resize = () => {
        W = canvas.clientWidth; H = canvas.clientHeight;
        canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        S = Math.min(W * 0.82, H * 0.9); ox0 = (W - S) / 2; oy0 = (H - S) / 2; sc = S / 400;
      };
      const mx = (nx: number) => ox0 + nx * S;
      const my = (ny: number) => oy0 + ny * S;
      resize();
      const ro = window.ResizeObserver ? new ResizeObserver(resize) : null;
      ro?.observe(canvas);
      if (!ro) window.addEventListener("resize", resize);

      const drawStatic = () => {
        ctx.clearRect(0, 0, W, H);
        if (img) { const w = S, h = w * (img.height / img.width); ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h); }
      };
      if (reduced) { drawStatic(); cleanup = () => { ro?.disconnect(); if (!ro) window.removeEventListener("resize", resize); }; return; }

      let start = 0, finished = false;
      const frame = (now: number) => {
        if (cancelled) return;
        if (!start) start = now;
        let tm = now - start;
        if (loop) tm %= TOTAL; else if (tm > TOTAL) tm = TOTAL;
        let idx = 0, acc = 0;
        while (idx < PH.length - 1 && tm > acc + PH[idx][1]) { acc += PH[idx][1]; idx++; }
        const ph = PH[idx][0];
        const lt = clamp((tm - acc) / PH[idx][1], 0, 1);

        let imgA = 0;
        if (ph === "wordmark") imgA = easeIO(lt) * 0.85;
        else if (ph === "rest") imgA = 0.85 + easeIO(lt) * 0.15;

        // life gestures (shared)
        const breathe = 1 + 0.014 * Math.sin(now * 0.0018);
        const tilt = ph === "life" ? 0.09 * Math.sin(lt * Math.PI) : 0;
        const wave = ph === "life" ? 0.24 * Math.sin(now * 0.0065) * Math.sin(lt * Math.PI) : 0;
        const bt = now % 2600;                       // blink cycle
        const blink = bt < 150 ? 1 - Math.sin((bt / 150) * Math.PI) * 0.92 : 1;

        ctx.clearRect(0, 0, W, H);
        ctx.globalCompositeOperation = "source-over";

        for (let i = 0; i < N; i++) {
          const p = parts[i];
          let nx = p.x, ny = p.y, a = 1, squash = 1;
          const rr = p.r;

          if (ph === "appear") {
            nx = p.cx; ny = p.cy; a = easeOut(lt) * 0.92;
          } else if (ph === "assemble") {
            const e = easeIO(lt); nx = lerp(p.cx, p.x, e); ny = lerp(p.cy, p.y, e);
          } else if (ph === "life" || ph === "lean") {
            nx = 0.5 + (p.x - 0.5) * breathe; ny = 0.6 + (p.y - 0.6) * breathe;
            if (tilt && p.head) { const [rx, ry] = rot(nx, ny, 0.5, 0.47, tilt); nx = rx; ny = ry; }
            if (wave && p.part === "armR") { const [rx, ry] = rot(nx, ny, 0.66, 0.47, wave); nx = rx; ny = ry; }
            if (ph === "life" && p.part === "eye") squash = blink;
            if (ph === "life" && p.part === "eyeHi") a = blink;
            if (ph === "lean") { const s = 1 + 0.05 * Math.sin(lt * Math.PI); nx = 0.5 + (nx - 0.5) * s; ny = 0.58 + (ny - 0.58) * s; }
          } else if (ph === "disperse") {
            const e = easeIO(lt); nx = lerp(p.x, p.ox, e); ny = lerp(p.y, p.oy, e); a = 1 - 0.1 * e;
          } else if (ph === "vortex") {
            const e = easeIO(lt); const vx = lerp(p.ox, 0.5, e), vy = lerp(p.oy, 0.55, e);
            const ang = e * Math.PI * 1.6 + p.seed * 0.2, sx = vx - 0.5, sy = vy - 0.55, c = Math.cos(ang), s2 = Math.sin(ang);
            nx = 0.5 + sx * c - sy * s2; ny = 0.55 + sx * s2 + sy * c; a = 0.7 + 0.3 * (1 - e);
          } else if (ph === "buildD") {
            const local = clamp((lt - p.stag * 0.5) / (1 - p.stag * 0.5 + 0.001), 0, 1);
            const e = easeOut(local); nx = lerp(0.5, p.lx, e); ny = lerp(0.55, p.ly, e); a = 1 - imgA;
          } else { nx = p.lx; ny = p.ly; a = 1 - imgA; }

          if (a <= 0.01) continue;
          const x = mx(nx), y = my(ny), R = Math.max(0.5, rr * sc);
          ctx.globalAlpha = a;
          ctx.fillStyle = `rgb(${p.col[0] | 0},${p.col[1] | 0},${p.col[2] | 0})`;
          if (squash < 0.98) {
            ctx.beginPath(); ctx.ellipse(x, y, R, Math.max(0.4, R * squash), 0, 0, Math.PI * 2); ctx.fill();
          } else {
            ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
          }
        }

        ctx.globalAlpha = 1;
        if (imgA > 0 && img) {
          const w = S, h = w * (img.height / img.width);
          ctx.globalAlpha = imgA; ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h); ctx.globalAlpha = 1;
        }

        if (!loop && tm >= TOTAL) { if (!finished) { finished = true; drawStatic(); onDone?.(); } return; }
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
