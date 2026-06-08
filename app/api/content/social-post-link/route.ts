import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type Platform = "instagram" | "tiktok" | "facebook" | "other";

type ContentArtifactSnapshot = {
  selectedVariantId?: string;
  structure?: string[];
  videoType?: "SHORT" | "MID" | "FULL";
  durationSeconds?: number;
  pace?: "fast" | "medium" | "slow";
  script?: {
    hook?: string;
    caption?: string;
    scriptText?: string;
    shots?: Array<{ voice?: string; visual?: string }>;
  };
};

type ExecutionArtifactSnapshot = {
  renderId?: string;
  renderedVideoUrl?: string;
  snapshotUrl?: string | null;
};

type PublishedArtifactSnapshot = {
  platform?: Platform;
  postUrl?: string;
};

type SocialPostLinkRequest = {
  // Legacy flat payload (still accepted)
  renderId?: string;
  renderedVideoUrl?: string;
  selectedVariantId?: string;
  platform?: Platform;
  postUrl?: string;

  // New snapshot payload
  contentArtifact?: ContentArtifactSnapshot;
  executionArtifact?: ExecutionArtifactSnapshot;
  publishedArtifact?: PublishedArtifactSnapshot;
};

function normalizeText(value: unknown, maxLen: number): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trim();
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizePlatform(value: unknown): Platform {
  const p = normalizeText(value, 24).toLowerCase();
  if (p === "instagram" || p === "tiktok" || p === "facebook" || p === "other") {
    return p as Platform;
  }
  return "other";
}

function toNonNegativeIntOrUndef(value: unknown, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return undefined;
  const ni = Math.floor(n);
  if (ni < 0) return undefined;
  return Math.min(ni, max);
}

function normalizeStringArray(value: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((v) => normalizeText(v, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
  return items.length ? items : undefined;
}

function normalizeShots(
  value: unknown,
  maxItems: number,
  maxVoiceLen: number,
  maxVisualLen: number
): Array<{ voice?: string; visual?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const shots = value
    .slice(0, maxItems)
    .map((raw: any) => {
      const voice = normalizeText(raw?.voice, maxVoiceLen);
      const visual = normalizeText(raw?.visual, maxVisualLen);
      const out: { voice?: string; visual?: string } = {};
      if (voice) out.voice = voice;
      if (visual) out.visual = visual;
      return out;
    })
    .filter((s) => Boolean(s.voice || s.visual));
  return shots.length ? shots : undefined;
}

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
      return authRequiredResponse(req);
    }

  let body: SocialPostLinkRequest | null = null;
  try {
    body = (await req.json()) as SocialPostLinkRequest;
  } catch {
    body = null;
  }

  const legacyRenderId = normalizeText(body?.renderId, 120);
  const legacyRenderedVideoUrl = normalizeText(body?.renderedVideoUrl, 2048);
  const legacySelectedVariantId = normalizeText(body?.selectedVariantId, 160);
  const legacyPlatform = normalizePlatform(body?.platform);
  const legacyPostUrl = normalizeText(body?.postUrl, 2048);

  const content = body?.contentArtifact;
  const execution = body?.executionArtifact;
  const published = body?.publishedArtifact;

  const renderId = normalizeText(execution?.renderId ?? legacyRenderId, 120);
  const renderedVideoUrl = normalizeText(
    execution?.renderedVideoUrl ?? legacyRenderedVideoUrl,
    2048
  );
  const snapshotUrlRaw = normalizeText(execution?.snapshotUrl, 2048);
  const snapshotUrl = snapshotUrlRaw ? snapshotUrlRaw : undefined;

  const selectedVariantId = normalizeText(
    content?.selectedVariantId ?? legacySelectedVariantId,
    160
  );

  const platform = normalizePlatform(published?.platform ?? legacyPlatform);
  const postUrl = normalizeText(published?.postUrl ?? legacyPostUrl, 2048);

  if (!renderId || !renderedVideoUrl || !selectedVariantId || !postUrl) {
    return Response.json(
      { error: "missing_fields" },
      { status: 400 }
    );
  }

  if (!isValidHttpUrl(postUrl)) {
    return Response.json(
      { error: "invalid_post_url" },
      { status: 400 }
    );
  }

  if (!isValidHttpUrl(renderedVideoUrl)) {
    return Response.json(
      { error: "invalid_rendered_video_url" },
      { status: 400 }
    );
  }

  const structure = normalizeStringArray(content?.structure, 24, 40);
  const videoTypeRaw = normalizeText(content?.videoType, 8).toUpperCase();
  const videoType =
    videoTypeRaw === "SHORT" || videoTypeRaw === "MID" || videoTypeRaw === "FULL"
      ? (videoTypeRaw as "SHORT" | "MID" | "FULL")
      : undefined;

  const paceRaw = normalizeText(content?.pace, 8).toLowerCase();
  const pace =
    paceRaw === "fast" || paceRaw === "medium" || paceRaw === "slow"
      ? (paceRaw as "fast" | "medium" | "slow")
      : undefined;

  const durationSeconds = toNonNegativeIntOrUndef(content?.durationSeconds, 300);

  const scriptHook = normalizeText(content?.script?.hook, 220);
  const scriptCaption = normalizeText(content?.script?.caption, 500);
  const scriptText = normalizeText(content?.script?.scriptText, 3500);
  const shots = normalizeShots(content?.script?.shots, 18, 360, 360);

  const contentArtifact: ContentArtifactSnapshot = {
    selectedVariantId,
    ...(structure ? { structure } : {}),
    ...(videoType ? { videoType } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(pace ? { pace } : {}),
    ...((scriptHook || scriptCaption || scriptText || shots)
      ? {
          script: {
            ...(scriptHook ? { hook: scriptHook } : {}),
            ...(scriptCaption ? { caption: scriptCaption } : {}),
            ...(scriptText ? { scriptText } : {}),
            ...(shots ? { shots } : {}),
          },
        }
      : {}),
  };

  await prisma.learningEvent.create({
    data: {
      businessId: user.businessId,
      eventType: "CONTENT_POST_LINKED",
      entityType: "CONTENT_RENDER",
      entityId: null,
      payload: {
        contentArtifact,
        executionArtifact: {
          renderId,
          renderedVideoUrl,
          ...(snapshotUrl ? { snapshotUrl } : {}),
        },
        publishedArtifact: {
          platform,
          postUrl,
        },
      },
    },
  });

  return Response.json({ success: true });
}

