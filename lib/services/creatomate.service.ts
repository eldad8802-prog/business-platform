type SelectedFormat = "reel" | "video" | "image" | "post";
type SelectedPlatform = "instagram" | "tiktok" | "facebook";

type Shot = {
  visual: string;
  voice: string;
};

type RenderInput = {
  assets: string[];
  shots: Shot[];
  scriptText: string;
  caption?: string;
  selectedFormat: SelectedFormat;
  selectedPlatform: SelectedPlatform;
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

function getClipDurations(count: number, format: SelectedFormat) {
  const base = format === "reel" ? 2.2 : 3;

  return Array.from({ length: count }).map((_, i) => {
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
  const durations = getClipDurations(assets.length, input.selectedFormat);

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

  const hook = {
    type: "text",
    text: input.scriptText.slice(0, 90),
    track: 2,
    time: 0,
    duration: durations[0],
    x: "50%",
    y: "15%",
    width: "85%",
    font_family: "Arial",
    font_weight: "700",
    font_size: 46,
    fill_color: "#ffffff",
    background_color: "rgba(0,0,0,0.5)",
    text_align: "center",
    padding_x: 20,
    padding_y: 16,
    border_radius: 16,
  };

  let t = 0;
  const subtitles = input.shots.map((shot, i) => {
    const sub = {
      type: "text",
      text: shot.voice,
      track: 2,
      time: t + 0.2,
      duration: durations[i] - 0.3,
      x: "50%",
      y: "85%",
      width: "90%",
      font_family: "Arial",
      font_weight: "700",
      font_size: 30,
      fill_color: "#ffffff",
      background_color: "rgba(0,0,0,0.6)",
      text_align: "center",
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
    text: input.caption || "שלחו הודעה עכשיו",
    track: 2,
    time: totalDuration - 2.5,
    duration: 2.5,
    x: "50%",
    y: "20%",
    width: "80%",
    font_family: "Arial",
    font_weight: "700",
    font_size: 34,
    fill_color: "#ffffff",
    background_color: "rgba(17,24,39,0.8)",
    text_align: "center",
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
    elements,
  };
}

function shouldUseMockRender(apiKey?: string) {
  const forceMock = process.env.FORCE_MOCK_RENDER === "true";

  if (forceMock) {
    return true;
  }

  if (!apiKey) return true;

  const trimmed = apiKey.trim();

  if (!trimmed) return true;
  if (trimmed === "המפתח_האמיתי_שלך") return true;
  if (trimmed.toLowerCase().includes("your_real")) return true;

  // אם זה לא נראה בכלל כמו מפתח אמיתי של Creatomate
  if (!trimmed.startsWith("sk_")) return true;

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
  const apiKey = process.env.CREATOMATE_API_KEY;

  if (shouldUseMockRender(apiKey)) {
    console.log("CREATOMATE MOCK MODE: using fallback video render");
    return createMockRenderResponse();
  }

  const payload = buildPayload(input);

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
  const apiKey = process.env.CREATOMATE_API_KEY;

  if (shouldUseMockRender(apiKey)) {
    console.log("CREATOMATE MOCK STATUS MODE:", renderId);

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