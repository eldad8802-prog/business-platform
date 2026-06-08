import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type Platform = "instagram" | "tiktok" | "facebook" | "other";

type PerformanceMetrics = Partial<{
  dms: number;
  leads: number;
  saves: number;
  shares: number;
  profileVisits: number;
  views: number;
}>;

type SocialPostPerformanceRequest = {
  renderId: string;
  selectedVariantId: string;
  platform: Platform;
  postUrl: string;
  measuredAt?: string;
  metrics?: PerformanceMetrics;
  note?: string;
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

function toNonNegativeInt(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 0;

  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n < 0) return null;
  return n;
}

function resolveMeasuredAt(input?: string): string {
  if (typeof input === "string" && input.trim()) {
    const d = new Date(input);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  return new Date().toISOString();
}

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
      return authRequiredResponse(req);
    }

  let body: SocialPostPerformanceRequest | null = null;
  try {
    body = (await req.json()) as SocialPostPerformanceRequest;
  } catch {
    body = null;
  }

  const renderId = normalizeText(body?.renderId, 120);
  const selectedVariantId = normalizeText(body?.selectedVariantId, 160);
  const platform = normalizePlatform(body?.platform);
  const postUrl = normalizeText(body?.postUrl, 2048);
  const measuredAt = resolveMeasuredAt(body?.measuredAt);
  const note = normalizeText(body?.note, 600);

  if (!renderId || !selectedVariantId || !postUrl) {
    return Response.json({ error: "missing_fields" }, { status: 400 });
  }

  if (!isValidHttpUrl(postUrl)) {
    return Response.json({ error: "invalid_post_url" }, { status: 400 });
  }

  const rawMetrics = (body?.metrics || {}) as Record<string, unknown>;

  const dms = toNonNegativeInt(rawMetrics.dms);
  const leads = toNonNegativeInt(rawMetrics.leads);
  const saves = toNonNegativeInt(rawMetrics.saves);
  const shares = toNonNegativeInt(rawMetrics.shares);
  const profileVisits = toNonNegativeInt(rawMetrics.profileVisits);
  const views = toNonNegativeInt(rawMetrics.views);

  if (
    dms === null ||
    leads === null ||
    saves === null ||
    shares === null ||
    profileVisits === null ||
    views === null
  ) {
    return Response.json({ error: "invalid_metrics" }, { status: 400 });
  }

  await prisma.learningEvent.create({
    data: {
      businessId: user.businessId,
      eventType: "CONTENT_POST_PERFORMANCE_RECORDED",
      entityType: "CONTENT_RENDER",
      entityId: null,
      payload: {
        renderId,
        selectedVariantId,
        platform,
        postUrl,
        measuredAt,
        source: "manual",
        metrics: {
          dms,
          leads,
          saves,
          shares,
          profileVisits,
          views,
        },
        ...(note ? { note } : {}),
      },
    },
  });

  return Response.json({ success: true });
}

