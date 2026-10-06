/**
 * POST /api/intake/telephony/voicenter/<publicId>/<key> — Voicenter's CDR notification (M7-C).
 *
 * Voicenter documents no signature, secret or IP list for the CDR push — only "a Web-Service that was provided
 * to us". The URL itself is therefore the credential: an unguessable endpoint id + a 256-bit key (dvk_…), shown
 * to the owner once and stored only as its sha256. It goes to Voicenter's Backoffice as the CDR target URL.
 * Answers in Voicenter's own format: {"Err":0,"Errdesc":"OK"} (anything else → Voicenter re-sends).
 */
import { NextResponse } from "next/server";
import { BODY_LIMITS, BodyTooLargeError, readBodyLimited } from "@/lib/intake/acquisition/http";
import { receiveKeyedDelivery } from "@/lib/intake/acquisition/receive";
import { parseVoicenterCdr, readVoicenterCdr, VOICENTER_SOURCE } from "@/lib/intake/calls/voicenter";

export const runtime = "nodejs";

const answer = (status: number, err: number, desc: string, headers?: Record<string, string>) =>
  NextResponse.json({ Err: err, Errdesc: desc }, { status, headers });

export async function POST(req: Request, ctx: { params: Promise<{ publicId: string; key: string }> }) {
  const { publicId, key } = await ctx.params;
  let raw: string;
  try {
    raw = await readBodyLimited(req, BODY_LIMITS[VOICENTER_SOURCE]);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return answer(413, 1, "Too large");
    throw e;
  }
  const contentType = req.headers.get("content-type");
  const r = await receiveKeyedDelivery({
    sourceKey: VOICENTER_SOURCE,
    publicId,
    key,
    raw,
    parse: (body) => {
      const cdr = readVoicenterCdr(body, contentType);
      if (!cdr) return { ok: false, code: "malformed" };
      const p = parseVoicenterCdr(cdr, publicId);
      if (!p.ok) return { ok: false, code: p.code };
      return { ok: true, receipts: "receipt" in p ? [p.receipt] : [] };
    },
  });
  if (r.status === 200) return answer(200, 0, "OK");
  if (r.status === 400) return answer(400, 1, "Parse error");
  if (r.status === 401) return answer(401, 2, "Application error");
  return answer(r.status, 2, "Application error", r.headers);
}
