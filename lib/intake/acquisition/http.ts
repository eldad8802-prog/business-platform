/**
 * M6 — bounded request reading for the public acquisition endpoints (a webhook body is otherwise
 * unbounded in a Next route handler). Reads the stream and stops at the limit.
 */
export const BODY_LIMITS = {
  "web.form": 32 * 1024,
  "google.lead_form": 64 * 1024,
  "meta.lead_ads": 512 * 1024,
  // M7-B / M7-C — a full order (up to 500 lines) and a JWT-wrapped order; a call event is small.
  "commerce.woocommerce": 2 * 1024 * 1024,
  "commerce.wix": 2 * 1024 * 1024,
  "telephony.cloudtalk": 128 * 1024,
  "telephony.voicenter": 128 * 1024,
} as const;

export class BodyTooLargeError extends Error {
  readonly code = "body_too_large";
}

export async function readBodyLimited(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/** JSON or application/x-www-form-urlencoded → a plain object; null when unparsable. */
export function parseBody(raw: string, contentType: string | null): unknown {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded")) {
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
    return out;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
