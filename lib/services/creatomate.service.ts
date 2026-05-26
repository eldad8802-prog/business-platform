import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import { applyRenderBlueprint } from "@/lib/features/content/render-blueprint/creatomate-adapter";
import {
  CREATOMATE_HEBREW_FONT_FAMILY,
  defaultCreatomateHebrewFonts,
  prepareCreatomateOverlayText,
} from "@/lib/services/creatomate-text-prep";

type SelectedFormat = "reel" | "video" | "image" | "post";
type SelectedPlatform = "instagram" | "tiktok" | "facebook";

type Shot = {
  visual: string;
  voice: string;
  beatDurationSeconds?: number;
  emotionalFunction?: string;
  narrativeRole?: string;
  retentionDriver?: string;
};

type RenderInput = {
  assets: string[];
  shots: Shot[];
  scriptText: string;
  caption?: string;
  selectedFormat: SelectedFormat;
  selectedPlatform: SelectedPlatform;
  renderBlueprint?: RenderBlueprint;
};

type CreatomateRenderResponse = {
  id: string;
  status: string;
  url?: string | null;
  snapshot_url?: string | null;
  error_message?: string | null;
};

function getDimensions(format: SelectedFormat, platform: SelectedPlatform) {
  if (format === "image" || format === "post") {
    return { width: 1080, height: 1350 };
  }

  if (platform === "facebook") {
    return { width: 1080, height: 1080 };
  }

  return { width: 1080, height: 1920 };
}

function getClipDurations(count: number, format: SelectedFormat, shots?: Shot[]) {
  const base = format === "reel" ? 2.2 : 3;

  return Array.from({ length: count }).map((_, i) => {
    const beatDur = shots?.[i]?.beatDurationSeconds;
    if (beatDur && beatDur > 0) return Math.max(1.5, beatDur);

    if (i === 0) return base + 0.6;
    if (i === count - 1) return base + 0.4;
    return base;
  });
}

function pickAssetsForShots(assets: string[], shots: Shot[]) {
  if (assets.length >= shots.length) {
    return assets.slice(0, shots.length);
  }

  const result: string[] = [];

  for (let i = 0; i < shots.length; i++) {
    result.push(assets[i % assets.length]);
  }

  return result;
}

function buildElements(input: RenderInput) {
  const assets = pickAssetsForShots(input.assets, input.shots);
  const durations = getClipDurations(assets.length, input.selectedFormat, input.shots);

  let currentTime = 0;

  const videoElements = assets.map((url, i) => {
    const el = {
      type: "video",
      source: url,
      track: 1,
      time: currentTime,
      duration: durations[i],
      fit: "cover",
    };

    currentTime += durations[i];
    return el;
  });

  const hookText = prepareCreatomateOverlayText(input.scriptText, 90);

  const hook = {
    type: "text",
    text: hookText,
    track: 2,
    time: 0,
    duration: durations[0],
    x: "50%",
    y: "15%",
    width: "85%",
    font_family: CREATOMATE_HEBREW_FONT_FAMILY,
    font_weight: 700,
    font_size: 46,
    fill_color: "#ffffff",
    background_color: "rgba(0,0,0,0.5)",
    x_alignment: "50%",
    y_alignment: "50%",
    padding_x: 20,
    padding_y: 16,
    border_radius: 16,
  };

  let t = 0;
  const subtitles = input.shots.map((shot, i) => {
    const sub = {
      type: "text",
      text: prepareCreatomateOverlayText(shot.voice, 320),
      track: 2,
      time: t + 0.2,
      duration: durations[i] - 0.3,
      x: "50%",
      y: "85%",
      width: "90%",
      font_family: CREATOMATE_HEBREW_FONT_FAMILY,
      font_weight: 700,
      font_size: 30,
      fill_color: "#ffffff",
      background_color: "rgba(0,0,0,0.6)",
      x_alignment: "50%",
      y_alignment: "100%",
      padding_x: 14,
      padding_y: 10,
      border_radius: 14,
    };

    t += durations[i];
    return sub;
  });

  const totalDuration = durations.reduce((a, b) => a + b, 0);

  const cta = {
    type: "text",
    text: prepareCreatomateOverlayText(
      input.caption || "שלחו הודעה עכשיו",
      500
    ),
    track: 2,
    time: totalDuration - 2.5,
    duration: 2.5,
    x: "50%",
    y: "20%",
    width: "80%",
    font_family: CREATOMATE_HEBREW_FONT_FAMILY,
    font_weight: 700,
    font_size: 34,
    fill_color: "#ffffff",
    background_color: "rgba(17,24,39,0.8)",
    x_alignment: "50%",
    y_alignment: "50%",
    padding_x: 18,
    padding_y: 12,
    border_radius: 14,
  };

  return [...videoElements, hook, ...subtitles, cta];
}

function buildPayload(input: RenderInput) {
  const { width, height } = getDimensions(
    input.selectedFormat,
    input.selectedPlatform
  );

  const elements = buildElements(input);

  const duration = elements
    .filter((e: any) => e.type === "video")
    .reduce((sum: number, e: any) => sum + e.duration, 0);

  return {
    output_format: "mp4",
    width,
    height,
    duration,
    fonts: defaultCreatomateHebrewFonts(),
    elements,
  };
}

/** Strips BOM / outer quotes — common .env paste issues. */
function normalizeCreatomateApiKey(raw?: string | null): string | undefined {
  if (raw == null) return undefined;
  let s = String(raw).trim();
  if (s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1).trim();
  }
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      s = s.slice(1, -1).trim();
    }
  }
  return s.length ? s : undefined;
}

function creatomateMockReason(apiKey: string | undefined): string {
  if (process.env.FORCE_MOCK_RENDER === "true") {
    return "FORCE_MOCK_RENDER=true";
  }
  if (apiKey == null || apiKey === "") {
    return "CREATOMATE_API_KEY missing or empty (after normalize)";
  }
  if (apiKey === "המפתח_האמיתי_שלך") {
    return "placeholder_key_he";
  }
  if (apiKey.toLowerCase().includes("your_real")) {
    return "placeholder_key_en";
  }
  return "live";
}

function shouldUseMockRender(apiKey: string | undefined) {
  const forceMock = process.env.FORCE_MOCK_RENDER === "true";

  if (forceMock) {
    return true;
  }

  if (!apiKey) return true;

  const trimmed = apiKey.trim();

  if (!trimmed) return true;
  if (trimmed === "המפתח_האמיתי_שלך") return true;
  if (trimmed.toLowerCase().includes("your_real")) return true;

  return false;
}

function createMockRenderResponse(): CreatomateRenderResponse {
  return {
    id: `mock_render_${Date.now()}`,
    status: "succeeded",
    url: "https://samplelib.com/lib/preview/mp4/sample-5s.mp4",
    snapshot_url: null,
    error_message: null,
  };
}

export async function createCreatomateRender(
  input: RenderInput
): Promise<CreatomateRenderResponse> {
  const apiKey = normalizeCreatomateApiKey(process.env.CREATOMATE_API_KEY);

  if (shouldUseMockRender(apiKey)) {
    console.warn(
      "[creatomate] MOCK render —",
      creatomateMockReason(apiKey),
      "| keyLen=" + (apiKey?.length ?? 0)
    );
    return createMockRenderResponse();
  }

  const rawPayload = buildPayload(input);
  const payload = input.renderBlueprint
    ? applyRenderBlueprint(rawPayload, input.renderBlueprint)
    : rawPayload;

  console.log("CREATOMATE PAYLOAD:", JSON.stringify(payload, null, 2));

  const res = await fetch("https://api.creatomate.com/v2/renders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await res.text();

  let data: any = null;

  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    data = rawText;
  }

  console.log("CREATOMATE STATUS:", res.status);
  console.log("CREATOMATE RESPONSE:", data);

  if (!res.ok) {
    const details =
      typeof data === "string"
        ? data
        : JSON.stringify(data ?? { message: "Unknown Creatomate error" });

    throw new Error(`Creatomate failed: ${res.status} ${details}`);
  }

  return data as CreatomateRenderResponse;
}

export async function getCreatomateRenderStatus(renderId: string) {
  const apiKey = normalizeCreatomateApiKey(process.env.CREATOMATE_API_KEY);

  if (shouldUseMockRender(apiKey)) {
    console.warn(
      "[creatomate] MOCK status —",
      creatomateMockReason(apiKey),
      "| renderId=" + renderId
    );

    return {
      id: renderId,
      status: "succeeded",
      url: "https://samplelib.com/lib/preview/mp4/sample-5s.mp4",
      snapshot_url: null,
      error_message: null,
    };
  }

  const res = await fetch(`https://api.creatomate.com/v2/renders/${renderId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const rawText = await res.text();

  let data: any = null;

  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    data = rawText;
  }

  if (!res.ok) {
    const details =
      typeof data === "string"
        ? data
        : JSON.stringify(data ?? { message: "Unknown Creatomate status error" });

    throw new Error(`Creatomate status failed: ${res.status} ${details}`);
  }

  return data;
}