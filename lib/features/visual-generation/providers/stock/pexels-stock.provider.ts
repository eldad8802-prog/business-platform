import type { VisualFallbackReason } from "../../types";

type PexelsVideoFile = {
  link?: string;
  quality?: string;
  width?: number;
  height?: number;
  file_type?: string;
};

type PexelsVideo = {
  id?: number;
  video_files?: PexelsVideoFile[];
};

type PexelsSearchJson = {
  videos?: PexelsVideo[];
};

export type PexelsStockOutcome =
  | { ok: true; url: string; pexelsVideoId: number }
  | { ok: false; reason: VisualFallbackReason };

function pickBestMp4Url(video: PexelsVideo): string | null {
  const files = video.video_files ?? [];
  const withLink = files.filter((f) => typeof f.link === "string" && f.link.length > 0);
  if (withLink.length === 0) return null;

  const mp4 = withLink.filter((f) =>
    (f.file_type || "").toLowerCase().includes("mp4")
  );
  const candidates = mp4.length > 0 ? mp4 : withLink;

  candidates.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  const reasonable =
    candidates.find((f) => (f.width ?? 0) <= 1920) ?? candidates[0];

  return reasonable?.link ?? null;
}

export async function fetchPexelsStockVideoUrl(params: {
  query: string;
  orientation: "portrait" | "landscape" | "square";
  apiKey: string;
  /** Pexels API page (1-based). */
  page?: number;
  /** URLs already assigned to other shots in this run — skip duplicates. */
  excludeUrls?: ReadonlySet<string>;
  excludeVideoIds?: ReadonlySet<number>;
}): Promise<PexelsStockOutcome> {
  const { query, orientation, apiKey, excludeUrls, excludeVideoIds } = params;
  const page = params.page && params.page > 0 ? params.page : 1;
  const trimmed = query.trim();
  if (!trimmed) {
    return { ok: false, reason: "no_results" };
  }

  const url = new URL("https://api.pexels.com/videos/search");
  url.searchParams.set("query", trimmed);
  url.searchParams.set("per_page", "15");
  url.searchParams.set("orientation", orientation);
  url.searchParams.set("page", String(page));

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: apiKey },
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "exception" };
  }

  if (res.status === 429) {
    return { ok: false, reason: "rate_limited" };
  }

  if (!res.ok) {
    return { ok: false, reason: "http_error" };
  }

  let data: PexelsSearchJson;
  try {
    data = (await res.json()) as PexelsSearchJson;
  } catch {
    return { ok: false, reason: "invalid_response" };
  }

  const videos = data.videos ?? [];
  if (videos.length === 0) {
    return { ok: false, reason: "no_results" };
  }

  let sawCandidate = false;

  for (const video of videos) {
    const vid = typeof video.id === "number" ? video.id : null;
    if (vid != null && excludeVideoIds?.has(vid)) {
      continue;
    }

    const mp4Url = pickBestMp4Url(video);
    if (!mp4Url) continue;

    sawCandidate = true;

    if (excludeUrls?.has(mp4Url)) {
      continue;
    }

    const pexelsVideoId = typeof video.id === "number" ? video.id : 0;
    return { ok: true, url: mp4Url, pexelsVideoId };
  }

  if (sawCandidate) {
    return { ok: false, reason: "pexels_all_used" };
  }

  return { ok: false, reason: "no_results" };
}
