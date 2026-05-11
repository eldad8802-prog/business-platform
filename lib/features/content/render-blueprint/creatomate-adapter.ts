import type { RenderBlueprint } from "./types";

type ElementRecord = Record<string, unknown>;

type CreatomatePayload = {
  duration?: number;
  elements?: ElementRecord[];
  [key: string]: unknown;
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Replaces only the alpha channel in an rgba() string.
 * Returns the original string unchanged if it doesn't match the pattern.
 */
function setRgbaOpacity(color: unknown, opacity: number): string {
  if (typeof color !== "string") return `rgba(0,0,0,${opacity.toFixed(2)})`;
  const m = color.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)$/);
  if (!m) return color;
  return `rgba(${m[1]},${m[2]},${m[3]},${opacity.toFixed(2)})`;
}

// ─── Element role detection ────────────────────────────────────────────────────
// Elements are identified by their y-position set in buildElements():
//   y="15%" → hook overlay
//   y="85%" → subtitle overlays (one per shot)
//   y="20%" → CTA overlay

function isVideo(el: ElementRecord): boolean {
  return el.type === "video";
}

function isHook(el: ElementRecord): boolean {
  return el.type === "text" && el.y === "15%";
}

function isSubtitle(el: ElementRecord): boolean {
  return el.type === "text" && el.y === "85%";
}

function isCta(el: ElementRecord): boolean {
  return el.type === "text" && el.y === "20%";
}

// ─── Adapter ───────────────────────────────────────────────────────────────────

/**
 * Pure function — never mutates the input payload.
 * Returns a new payload with render blueprint applied.
 * If anything fails the original payload is returned unchanged.
 */
export function applyRenderBlueprint(
  payload: Record<string, unknown>,
  renderBlueprint: RenderBlueprint
): Record<string, unknown> {
  try {
    const config = renderBlueprint.presetConfig;

    // Deep clone via JSON — Creatomate payloads are always JSON-serializable
    const cloned = JSON.parse(JSON.stringify(payload)) as CreatomatePayload;

    const elements = cloned.elements;
    if (!Array.isArray(elements) || elements.length === 0) return payload;

    // ── Partition elements by role ──────────────────────────────────────────
    const videoEls  = elements.filter(isVideo);
    const hookEl    = elements.find(isHook);
    const subtitleEls = elements.filter(isSubtitle);
    const ctaEl     = elements.find(isCta);

    // ── Clip duration adjustments ───────────────────────────────────────────
    // Only recalculate when timing deltas are non-zero to avoid floating-point
    // drift on payloads that are already correct.
    const { clipDurationDelta: delta, firstClipBonus, lastClipBonus } = config;
    const timingChanged = delta !== 0 || firstClipBonus !== 0 || lastClipBonus !== 0;

    if (timingChanged && videoEls.length > 0) {
      const lastIdx = videoEls.length - 1;
      let cursor = 0;

      videoEls.forEach((el, i) => {
        let dur = clamp(
          (el.duration as number) + delta,
          1.5,   // minimum clip: 1.5s
          20     // maximum clip: 20s (safety ceiling)
        );
        if (i === 0)       dur = clamp(dur + firstClipBonus, 1.5, 20);
        if (i === lastIdx) dur = clamp(dur + lastClipBonus,  1.5, 20);

        el.duration = round2(dur);
        el.time     = round2(cursor);
        cursor     += el.duration as number;
      });

      const totalDuration = videoEls.reduce((s, e) => s + (e.duration as number), 0);
      cloned.duration = round2(totalDuration);

      // Sync hook text duration with first clip
      if (hookEl && videoEls[0]) {
        hookEl.duration = videoEls[0].duration;
      }

      // Sync each subtitle with its corresponding video clip.
      // buildElements() generates subtitles in shot-index order, same as video clips.
      subtitleEls.forEach((sub, i) => {
        const vid = videoEls[i];
        if (!vid) return;
        sub.time     = round2((vid.time as number) + 0.2);
        sub.duration = round2(clamp((vid.duration as number) - 0.3, 0.5, 30));
      });

      // Anchor CTA at total - 2.5s
      if (ctaEl) {
        ctaEl.time = round2(cloned.duration - 2.5);
      }
    }

    // ── Hook text styling ───────────────────────────────────────────────────
    if (hookEl) {
      hookEl.font_size         = clamp(config.hookFontSize, 20, 56);
      hookEl.background_color  = setRgbaOpacity(hookEl.background_color, config.hookBgOpacity);
      hookEl.border_radius     = config.hookBorderRadius;
      hookEl.padding_x         = config.hookPaddingX;
      hookEl.padding_y         = config.hookPaddingY;
    }

    // ── Subtitle text styling ───────────────────────────────────────────────
    // Note: subtitleY is set here, AFTER using the original "85%" for detection above.
    for (const sub of subtitleEls) {
      sub.font_size        = clamp(config.subtitleFontSize, 20, 56);
      sub.font_weight      = config.subtitleFontWeight;
      sub.background_color = setRgbaOpacity(sub.background_color, config.subtitleBgOpacity);
      sub.y                = config.subtitleY;
    }

    // ── CTA text styling ────────────────────────────────────────────────────
    if (ctaEl) {
      ctaEl.font_size        = clamp(config.ctaFontSize, 20, 56);
      ctaEl.background_color = setRgbaOpacity(ctaEl.background_color, config.ctaBgOpacity);
    }

    return cloned;
  } catch {
    // Unconditional safety net: any error → return original payload untouched
    return payload;
  }
}
