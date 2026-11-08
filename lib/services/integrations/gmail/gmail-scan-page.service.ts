/**
 * One page of the extended Gmail scan (2026-11-09 B3-a).
 *
 * # What a page is
 *
 * One `messages.list` call (at most GMAIL_SCAN_PAGE_SIZE ids, one search
 * window, optionally resuming at Gmail's page token) and one `messages.get`
 * per listed id, at most GMAIL_SCAN_CONCURRENCY at a time. The legacy scan
 * (discoverGmailAttachments) is not touched; this is a separate path.
 *
 * # The rule that matters: never skip a message silently
 *
 * A page is `complete` only when EVERY listed message was read (or Gmail says
 * it no longer exists — a deleted message carries no document to find). If
 * any read fails, or was never launched because Gmail asked us to slow down or
 * the page ran out of time, the page is `complete: false` and the caller must
 * NOT advance past it: it re-issues a cursor for the SAME page token, so the
 * retry lists the same page again and reads every message on it. Results of a
 * retried page overlap the partial ones by design; the stable key
 * (attachment-key.ts) makes the overlap harmless.
 *
 * # Load on Gmail
 *
 * - Retries only on 429 / 503, at most once per request and at most
 *   GMAIL_PAGE_RETRY_BUDGET per page, waiting what Gmail asks (Retry-After)
 *   plus a little jitter — and not at all when Gmail asks for longer than
 *   GMAIL_RETRY_MAX_WAIT_MS (we would be retrying sooner than asked).
 * - After the first 429 / 503 no NEW read is launched in this page; the page
 *   ends incomplete and the owner decides when to continue.
 * - Nothing retries in the background. Every call happens inside the request.
 *
 * Bounded cost of one page: 1 list + PAGE_SIZE reads + RETRY_BUDGET retries.
 */

import type { GmailScanWindow } from "@/lib/services/email-import/scan-window";
import { gmailScanQuery } from "@/lib/services/email-import/scan-window";
import {
  emptyRejectedTypeCounts,
  REJECTED_TYPE_GROUPS,
  type RejectedTypeCounts,
} from "@/lib/services/email-import/rejected-types";
import { classifyGmailMessage, type GmailAttachmentMetadata } from "./gmail-discovery.service";
import type { GmailMessageResponse } from "./gmail-message-parts";

export const GMAIL_SCAN_PAGE_SIZE = 25;
export const GMAIL_SCAN_SESSION_CAP = 500;
export const GMAIL_SCAN_CONCURRENCY = 4;
export const GMAIL_RETRY_MAX_WAIT_MS = 5_000;
export const GMAIL_PAGE_RETRY_BUDGET = 4;
const RETRY_DEFAULT_WAIT_MS = 1_000;
const RETRY_JITTER_MS = 250;
const REQUEST_TIMEOUT_MS = 10_000;
/** No new read is launched after this long; the page then ends incomplete. */
const PAGE_DEADLINE_MS = 25_000;
const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

export type GmailScanDeps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
};

const defaultDeps: GmailScanDeps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  now: Date.now,
};

/** The list call itself failed: nothing on this page was read. */
export class GmailScanListError extends Error {
  readonly kind: "unauthorized" | "throttled" | "failed";
  constructor(kind: "unauthorized" | "throttled" | "failed") {
    super(`Gmail scan list failed: ${kind}`);
    this.name = "GmailScanListError";
    this.kind = kind;
  }
}

export type GmailScanPageResult = {
  /** Every listed message was read or is gone. Only then may the scan advance. */
  complete: boolean;
  listedMessages: number;
  readMessages: number;
  goneMessages: number;
  failedMessages: number;
  /** Listed but never read: launched no more after a 429/503 or the page deadline. */
  skippedMessages: number;
  retries: number;
  throttled: boolean;
  /** Gmail's token for the page after this one; null when Gmail has no more. */
  nextPageToken: string | null;
  attachments: GmailAttachmentMetadata[];
  attachmentParts: number;
  unsupportedType: number;
  rejectedByType: RejectedTypeCounts;
};

type RequestOutcome =
  | { ok: true; json: unknown }
  | { ok: false; status: number | null; throttle: boolean };

export type GmailScanPagePlan = {
  /** Messages the scan has covered after this page (unchanged when the page is incomplete). */
  scannedTotal: number;
  /** The session cap stopped the scan although Gmail may hold more. */
  capReached: boolean;
  /** Messages in the window the scan has NOT covered yet (true while a page must be retried). */
  hasMore: boolean;
  /** Issue a cursor for the NEXT page at this token, or null. */
  advanceTo: string | null;
  /** Issue a cursor for the SAME page (the one just attempted). */
  retrySamePage: boolean;
};

/**
 * What the scan may do after one page. Pure.
 *
 * Incomplete page → never advance: retry the same page, count nothing.
 * Complete page   → advance to Gmail's next token, unless Gmail has no more
 *                   or the session cap is reached; in the second case
 *                   `hasMore` stays true so nobody reads "all found".
 */
export function planAfterPage(input: {
  complete: boolean;
  listedMessages: number;
  nextPageToken: string | null;
  scannedBefore: number;
}): GmailScanPagePlan {
  if (!input.complete) {
    return { scannedTotal: input.scannedBefore, capReached: false, hasMore: true, advanceTo: null, retrySamePage: true };
  }
  const scannedTotal = input.scannedBefore + input.listedMessages;
  const hasMore = input.nextPageToken !== null;
  // Only "stopped by the cap" counts: reaching 500 exactly with nothing left is a finished scan.
  const capReached = hasMore && scannedTotal >= GMAIL_SCAN_SESSION_CAP;
  return {
    scannedTotal,
    capReached,
    hasMore,
    advanceTo: hasMore && !capReached ? input.nextPageToken : null,
    retrySamePage: false,
  };
}

/** How long to wait before the one retry, or null when we must not retry. */
export function retryDelayMs(retryAfter: string | null, deps: Pick<GmailScanDeps, "random" | "now">): number | null {
  let base = RETRY_DEFAULT_WAIT_MS;
  if (retryAfter != null && retryAfter.trim() !== "") {
    const value = retryAfter.trim();
    if (/^\d+$/.test(value)) {
      base = Number(value) * 1000;
    } else {
      const at = Date.parse(value);
      if (Number.isNaN(at)) return null;
      base = Math.max(0, at - deps.now());
    }
  }
  // Gmail asked for longer than we will wait: retrying now would be sooner than asked.
  if (base > GMAIL_RETRY_MAX_WAIT_MS) return null;
  return Math.min(GMAIL_RETRY_MAX_WAIT_MS, base + Math.floor(deps.random() * RETRY_JITTER_MS));
}

export async function scanGmailPage(
  params: {
    accessToken: string;
    window: GmailScanWindow;
    pageToken: string | null;
    pageSize: number;
  },
  deps: GmailScanDeps = defaultDeps
): Promise<GmailScanPageResult> {
  const startedAt = deps.now();
  const state = { retries: 0, throttled: false };
  const pageSize = Math.min(Math.max(Math.floor(params.pageSize), 1), GMAIL_SCAN_PAGE_SIZE);

  async function request(url: string): Promise<RequestOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      let res: Response;
      try {
        res = await deps.fetch(url, {
          headers: { Authorization: `Bearer ${params.accessToken}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        // Network error or timeout: not retried (the owner can retry the page).
        return { ok: false, status: null, throttle: false };
      }
      if (res.ok) {
        try {
          return { ok: true, json: await res.json() };
        } catch {
          return { ok: false, status: res.status, throttle: false };
        }
      }
      // The body is never read into a log; drain it so the socket is released.
      await res.text().catch(() => "");
      const throttle = res.status === 429 || res.status === 503;
      if (throttle) state.throttled = true;
      if (!throttle || attempt >= 1 || state.retries >= GMAIL_PAGE_RETRY_BUDGET) {
        return { ok: false, status: res.status, throttle };
      }
      const wait = retryDelayMs(res.headers.get("retry-after"), deps);
      if (wait === null) return { ok: false, status: res.status, throttle };
      state.retries += 1;
      await deps.sleep(wait);
    }
  }

  // 1. The list.
  const listUrl = new URL(GMAIL_MESSAGES_URL);
  listUrl.searchParams.set("q", gmailScanQuery(params.window));
  listUrl.searchParams.set("maxResults", String(pageSize));
  if (params.pageToken) listUrl.searchParams.set("pageToken", params.pageToken);

  const list = await request(listUrl.toString());
  if (!list.ok) {
    throw new GmailScanListError(list.status === 401 ? "unauthorized" : list.throttle ? "throttled" : "failed");
  }
  const listJson = (list.json ?? {}) as { messages?: unknown; nextPageToken?: unknown };
  const rawMessages = Array.isArray(listJson.messages) ? listJson.messages : [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of rawMessages) {
    const id = (m as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  const nextPageToken =
    typeof listJson.nextPageToken === "string" && listJson.nextPageToken.length > 0 ? listJson.nextPageToken : null;

  // 2. The reads, at most GMAIL_SCAN_CONCURRENCY in flight.
  const outcomes: Array<RequestOutcome | undefined> = new Array(ids.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (state.throttled || deps.now() - startedAt > PAGE_DEADLINE_MS) return;
      const i = nextIndex;
      if (i >= ids.length) return;
      nextIndex += 1;
      const url = new URL(`${GMAIL_MESSAGES_URL}/${encodeURIComponent(ids[i])}`);
      url.searchParams.set("format", "full");
      outcomes[i] = await request(url.toString());
    }
  }
  await Promise.all(Array.from({ length: Math.min(GMAIL_SCAN_CONCURRENCY, ids.length) }, () => worker()));

  // 3. Classify in list order.
  const attachments: GmailAttachmentMetadata[] = [];
  let attachmentParts = 0;
  let unsupportedType = 0;
  const rejectedByType = emptyRejectedTypeCounts();
  let readMessages = 0;
  let goneMessages = 0;
  let failedMessages = 0;
  let skippedMessages = 0;

  ids.forEach((messageId, i) => {
    const outcome = outcomes[i];
    if (outcome === undefined) {
      skippedMessages += 1;
      return;
    }
    if (!outcome.ok) {
      // Deleted between the list and the read: nothing left to find.
      if (outcome.status === 404) goneMessages += 1;
      else failedMessages += 1;
      return;
    }
    if (!outcome.json || typeof outcome.json !== "object") {
      failedMessages += 1;
      return;
    }
    readMessages += 1;
    const classified = classifyGmailMessage(messageId, outcome.json as GmailMessageResponse);
    attachments.push(...classified.attachments);
    attachmentParts += classified.attachmentParts;
    unsupportedType += classified.unsupportedType;
    for (const group of REJECTED_TYPE_GROUPS) {
      rejectedByType[group] += classified.rejectedByType[group];
    }
  });

  return {
    complete: failedMessages === 0 && skippedMessages === 0,
    listedMessages: ids.length,
    readMessages,
    goneMessages,
    failedMessages,
    skippedMessages,
    retries: state.retries,
    throttled: state.throttled,
    nextPageToken,
    attachments,
    attachmentParts,
    unsupportedType,
    rejectedByType,
  };
}
