/**
 * Gmail scan B3-a — foundation verify (2026-11-09).
 *
 * Pins:
 *  A. Stable identity: messageId + partId, the top-level ("root") attachment,
 *     changing attachment ids, rescans, two parts of one message, duplicate
 *     names, nested MIME; the resolver's root step never reaches another part.
 *  B. Cursor: sealed (Gmail's token unreadable) and signed; forged, edited,
 *     expired, future, other business / user / account / window all refused;
 *     keys separated from every other use of the secret.
 *  C. Page engine: closed window → query; ≤25 per page; ≤4 reads in flight;
 *     429/503 retried once, Retry-After honoured and capped, budget per page;
 *     no new reads after a throttle; failed or skipped reads make the page
 *     incomplete; deleted messages do not.
 *  D. Advancing: an incomplete page never advances; the 500 cap never reads
 *     as "all found".
 *  E. Rate limit: GMAIL_SCAN per user + business only; one business cannot
 *     spend another's; Redis down keeps the same limits locally; every other
 *     bucket's fail mode unchanged.
 *  F. Old paths: /sync, import, the legacy scan untouched; the new route
 *     takes no free-text query, checks the cursor before Google, logs numbers.
 *
 *   npx tsx lib/services/integrations/gmail/gmail-scan-b3a.verify.test.ts
 */

process.env.RATE_LIMIT_BACKEND = "memory";
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "b3a-verify-secret-not-a-real-one-000000";

import assert from "node:assert/strict";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { GMAIL_ROOT_PART_ID, gmailAttachmentKey } from "@/lib/services/email-import/attachment-key";
import { attachmentKey, scoreAttachments } from "@/lib/services/email-import/scoring";
import {
  DEFAULT_GMAIL_SCAN_WINDOW,
  gmailScanQuery,
  parseGmailScanWindow,
} from "@/lib/services/email-import/scan-window";
import {
  collectAttachmentParts,
  resolveAttachmentInMessage,
  type GmailMessagePart,
} from "@/lib/services/integrations/gmail/gmail-message-parts";
import {
  classifyAttachmentParts,
  classifyGmailMessage,
} from "@/lib/services/integrations/gmail/gmail-discovery.service";
import {
  GMAIL_SCAN_CURSOR_TTL_SECONDS,
  GmailScanCursorConfigError,
  issueGmailScanCursor,
  verifyGmailScanCursor,
  type GmailScanCursorFacts,
} from "@/lib/services/integrations/gmail/gmail-scan-cursor";
import {
  GMAIL_PAGE_RETRY_BUDGET,
  GMAIL_RETRY_MAX_WAIT_MS,
  GMAIL_SCAN_CONCURRENCY,
  GMAIL_SCAN_MAX_PAGE_ATTEMPTS,
  GMAIL_SCAN_PAGE_SIZE,
  GMAIL_SCAN_SESSION_CAP,
  GmailScanListError,
  planAfterPage,
  retryDelayMs,
  scanGmailPage,
  type GmailScanDeps,
} from "@/lib/services/integrations/gmail/gmail-scan-page.service";
import { fetchGmailAttachmentDescriptor } from "@/lib/services/integrations/gmail/gmail-attachment-metadata.service";
import {
  GMAIL_SCAN_BUDGETS,
  GMAIL_UNITS_GET_FULL,
  GMAIL_UNITS_LIST,
  REFUND_LUA,
  RESERVE_LUA,
  budgetLines,
  configureGmailBudgetStoreForTests,
  gmailPageWorstCaseUnits,
  gmailUnitsSpent,
  memoryBudgetStore,
  redisBudgetStore,
  reserveGmailScanBudget,
  settleGmailScanBudget,
  type EvalClient,
  type GmailBudgetStore,
} from "@/lib/services/integrations/gmail/gmail-quota-budget";
import { BUCKETS } from "@/lib/security/rate-limiter/buckets";
import { checkRateLimit, configureRateLimiterForTests } from "@/lib/security/rate-limiter";
import { resetMemoryBackendForTests } from "@/lib/security/rate-limiter/memory-backend";
import { RateLimiterBackendError } from "@/lib/security/rate-limiter/errors";
import type { RateLimitBackend } from "@/lib/security/rate-limiter/types";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`OK  : ${name}`);
}
const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const meta = (messageId: string) => ({ messageId, fromEmail: null, subject: null, sentAt: null });

const leaf = (partId: string, attachmentId: string, filename: string, size: number, mimeType = "application/pdf"): GmailMessagePart => ({
  partId, mimeType, filename, body: { attachmentId, size },
});

/** Text body, two PDFs + an image + a same-named PDF, and a PDF two levels down. */
function complex(ids: Record<"a" | "b" | "img" | "dup" | "deep", string>): GmailMessagePart {
  return {
    partId: "",
    mimeType: "multipart/mixed",
    parts: [
      { partId: "0", mimeType: "multipart/alternative", parts: [
        { partId: "0.0", mimeType: "text/plain", filename: "", body: { size: 120 } },
        { partId: "0.1", mimeType: "text/html", filename: "", body: { size: 400 } },
      ] },
      leaf("1", ids.a, "invoice.pdf", 200_000),
      leaf("2", ids.b, "receipt.pdf", 64_000),
      leaf("3", ids.img, "logo.png", 5_000, "image/png"),
      leaf("4", ids.dup, "invoice.pdf", 200_000), // same name AND size as part 1
      { partId: "5", mimeType: "multipart/related", parts: [
        { partId: "5.0", mimeType: "multipart/mixed", parts: [leaf("5.0.0", ids.deep, "statement.pdf", 90_000)] },
      ] },
    ],
  };
}
/** A message that IS the file: the payload carries the attachment, no path. */
function single(attachmentId: string, partIdField: string | undefined = ""): GmailMessagePart {
  const p: GmailMessagePart = { mimeType: "application/pdf", filename: "scan-0001.pdf", body: { attachmentId, size: 333_000 } };
  if (partIdField !== undefined) p.partId = partIdField;
  return p;
}

async function main() {
  // ================================================================ A. identity
  await check("A1 key: messageId + partId; attachment id ignored when a partId exists", () => {
    assert.equal(gmailAttachmentKey({ messageId: "m", attachmentId: "X1", partId: "1" }), "m:part:1");
    assert.equal(gmailAttachmentKey({ messageId: "m", attachmentId: "X2", partId: "1" }), "m:part:1");
    assert.equal(gmailAttachmentKey({ messageId: "m", attachmentId: "X", partId: GMAIL_ROOT_PART_ID }), "m:part:root");
    // Older server, no partId: the only identity there is.
    assert.equal(gmailAttachmentKey({ messageId: "m", attachmentId: "X", partId: null }), "m:X");
    assert.equal(gmailAttachmentKey({ messageId: "m", attachmentId: "X" }), "m:X");
    assert.equal(gmailAttachmentKey({ messageId: "m", attachmentId: "X", partId: "" }), "m:X");
    // Same partId in two messages = two attachments.
    assert.notEqual(gmailAttachmentKey({ messageId: "m1", attachmentId: "X", partId: "1" }), gmailAttachmentKey({ messageId: "m2", attachmentId: "X", partId: "1" }));
    // The screen's key is the same function.
    const a = { messageId: "m", attachmentId: "Z", partId: "2", filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 1, fromEmail: null, subject: null, sentAt: null };
    assert.equal(attachmentKey(a), "m:part:2");
  });

  const FIRST = complex({ a: "A1", b: "B1", img: "I1", dup: "U1", deep: "D1" });
  const SECOND = complex({ a: "A2", b: "B2", img: "I2", dup: "U2", deep: "D2" }); // every id changed
  const keysOf = (payload: GmailMessagePart) =>
    classifyGmailMessage("m-1", { id: "m-1", payload }).attachments.map((x) => gmailAttachmentKey(x));

  await check("A2 rescan with every attachment id changed → the same keys, no new item", () => {
    const k1 = keysOf(FIRST);
    const k2 = keysOf(SECOND);
    assert.deepEqual(k1, k2);
    assert.equal(new Set([...k1, ...k2]).size, k1.length, "merging both scans adds nothing");
    // Through the screen's scoring too (statuses are keyed by this).
    const s1 = scoreAttachments(classifyGmailMessage("m-1", { id: "m-1", payload: FIRST }).attachments).map((x) => x.key);
    const s2 = scoreAttachments(classifyGmailMessage("m-1", { id: "m-1", payload: SECOND }).attachments).map((x) => x.key);
    assert.deepEqual(s1, s2);
  });

  await check("A3 two different attachments of one message stay two (same name and size included)", () => {
    const k = keysOf(FIRST);
    assert.equal(k.length, 5, "a, b, img, dup, deep");
    assert.equal(new Set(k).size, 5);
    assert.ok(k.includes("m-1:part:1") && k.includes("m-1:part:4"), "same-named parts keep distinct keys");
    assert.ok(k.includes("m-1:part:5.0.0"), "nested part keeps its full path");
  });

  await check("A4 classify: the top-level attachment is reported as root; multipart tops are not", () => {
    for (const partIdField of ["", undefined]) {
      const payload = single("S1", partIdField);
      const r = classifyGmailMessage("m-s", { id: "m-s", payload });
      assert.equal(r.attachments.length, 1);
      assert.equal(r.attachments[0].partId, GMAIL_ROOT_PART_ID, `payload partId ${JSON.stringify(partIdField)}`);
    }
    // Multipart message: the top carries no attachment; children keep their own ids, none is root.
    const r = classifyGmailMessage("m-1", { id: "m-1", payload: FIRST });
    assert.equal(r.attachments.some((x) => x.partId === GMAIL_ROOT_PART_ID), false);
    // Legacy call without the root argument: exactly the old behaviour ("" → null).
    const legacy = classifyAttachmentParts(collectAttachmentParts(single("S1")), meta("m-s"));
    assert.equal(legacy.attachments[0].partId, null);
  });

  await check("A5 import: every attachment discovered in FIRST resolves to ITS part in SECOND (ids all changed)", () => {
    const discovered = classifyGmailMessage("m-1", { id: "m-1", payload: FIRST }).attachments;
    for (const d of discovered) {
      const r = resolveAttachmentInMessage(SECOND, d);
      assert.equal(r.ok, true, d.partId ?? "");
      if (!r.ok) continue;
      assert.equal(r.matchedBy, "part_id");
      assert.equal(r.part.partId, d.partId, "the same part, not a look-alike");
      assert.equal(r.attachmentId, r.part.body?.attachmentId, "download id comes from THIS fetch");
    }
    // The id path is unchanged when ids do not move.
    for (const d of discovered) {
      const r = resolveAttachmentInMessage(FIRST, d);
      assert.ok(r.ok && r.matchedBy === "attachment_id");
    }
  });

  await check("A6 root: a single-file message whose id changed is found, only with name AND size agreeing", () => {
    const discovered = classifyGmailMessage("m-s", { id: "m-s", payload: single("S1") }).attachments[0];
    const later = single("S2"); // id changed
    const r = resolveAttachmentInMessage(later, discovered);
    assert.ok(r.ok && r.matchedBy === "root_part" && r.attachmentId === "S2" && r.part === later);
    // Same id still resolves by id, as before.
    const same = resolveAttachmentInMessage(single("S1"), discovered);
    assert.ok(same.ok && same.matchedBy === "attachment_id");

    const ref = { attachmentId: "S1", partId: GMAIL_ROOT_PART_ID };
    assert.deepEqual(resolveAttachmentInMessage(later, { ...ref, filename: "scan-0001.pdf", sizeBytes: 1 }), { ok: false, reason: "part_mismatch" });
    assert.deepEqual(resolveAttachmentInMessage(later, { ...ref, filename: "other.pdf", sizeBytes: 333_000 }), { ok: false, reason: "part_mismatch" });
    // Unlike a numbered part, root never settles for one of the two.
    assert.deepEqual(resolveAttachmentInMessage(later, { ...ref, filename: "scan-0001.pdf" }), { ok: false, reason: "part_unverifiable" });
    assert.deepEqual(resolveAttachmentInMessage(later, { ...ref, sizeBytes: 333_000 }), { ok: false, reason: "part_unverifiable" });
    assert.deepEqual(resolveAttachmentInMessage(later, { ...ref, filename: "", sizeBytes: 333_000 }), { ok: false, reason: "part_unverifiable" });
    assert.deepEqual(resolveAttachmentInMessage(later, { ...ref, filename: null, sizeBytes: null }), { ok: false, reason: "part_unverifiable" });
  });

  await check("A7 root can never reach a nested part or another file", () => {
    // Multipart message: "root" names the top, which is no attachment → refused, even
    // though a nested part has exactly the filename and size asked for.
    const ref = { attachmentId: "gone", partId: GMAIL_ROOT_PART_ID, filename: "invoice.pdf", sizeBytes: 200_000 };
    assert.deepEqual(resolveAttachmentInMessage(SECOND, ref), { ok: false, reason: "part_not_found" });
    // A nested part literally labelled "root" is never matched by that string.
    const trick: GmailMessagePart = { partId: "", mimeType: "multipart/mixed", parts: [leaf("root", "R1", "invoice.pdf", 200_000)] };
    assert.deepEqual(resolveAttachmentInMessage(trick, ref), { ok: false, reason: "part_not_found" });
    // A numbered partId never matches the top-level payload, whatever its own partId says.
    const oddTop: GmailMessagePart = { partId: "1", mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "T2", size: 10 } };
    assert.deepEqual(resolveAttachmentInMessage(oddTop, { attachmentId: "T1", partId: "1", filename: "a.pdf", sizeBytes: 10 }), { ok: false, reason: "part_not_found" });
    // No payload at all.
    assert.deepEqual(resolveAttachmentInMessage(undefined, ref), { ok: false, reason: "part_not_found" });
    // Missing partId stays exactly as #1009 left it.
    assert.deepEqual(resolveAttachmentInMessage(single("S2"), { attachmentId: "S1", filename: "scan-0001.pdf", sizeBytes: 333_000 }), { ok: false, reason: "no_part_id" });
  });

  await check("A8 exhaustive: over every part of many shapes, a changed id resolves to the same part or is refused", () => {
    let cases = 0;
    const shapes: GmailMessagePart[] = [FIRST, single("S1"), single("S1", undefined),
      { partId: "", mimeType: "multipart/mixed", parts: [leaf("0", "x0", "a.pdf", 1), leaf("1", "x1", "a.pdf", 1), leaf("2", "x2", "a.pdf", 2)] },
      { partId: "", mimeType: "multipart/mixed", parts: [{ partId: "0", mimeType: "message/rfc822", parts: [{ partId: "0.0", mimeType: "multipart/mixed", parts: [leaf("0.0.0", "f0", "fwd.pdf", 7), leaf("0.0.1", "f1", "fwd.pdf", 7)] }] }] },
    ];
    for (const shape of shapes) {
      const renamed: GmailMessagePart = JSON.parse(JSON.stringify(shape).replace(/"attachmentId":"([^"]+)"/g, '"attachmentId":"$1-new"'));
      for (const d of classifyGmailMessage("m", { id: "m", payload: shape }).attachments) {
        cases += 1;
        const r = resolveAttachmentInMessage(renamed, d);
        assert.ok(r.ok, `${d.partId}`);
        if (!r.ok) continue;
        assert.equal(r.attachmentId, `${d.attachmentId}-new`, "exactly the corresponding part");
        assert.equal(r.part.filename, d.filename);
        assert.equal(r.part.body?.size, d.sizeBytes);
      }
    }
    assert.ok(cases >= 12);
  });

  // ================================================================ B. cursor
  const facts: GmailScanCursorFacts = { businessId: 9, userId: 4, connectionId: 12, window: 90, pageToken: "GMAIL-PAGE-TOKEN-0123456789", scanned: 75, attempt: 0 };
  const expect = { businessId: 9, userId: 4, window: 90 as const };
  const T0 = Date.UTC(2026, 10, 9, 10, 0, 0);

  await check("B1 cursor round-trip; Gmail's token cannot be read from it", () => {
    const c = issueGmailScanCursor(facts, T0);
    const r = verifyGmailScanCursor(c, expect, T0 + 1000);
    assert.deepEqual(r, { ok: true, facts });
    assert.equal(c.includes("GMAIL-PAGE-TOKEN"), false);
    for (const seg of c.split(".")) {
      const decoded = Buffer.from(seg, "base64url").toString("latin1");
      assert.equal(decoded.includes("GMAIL-PAGE-TOKEN"), false, "no segment decodes to the token");
      assert.equal(/"b":9|"businessId"/.test(decoded), false, "no readable payload");
    }
    // Two cursors for the same facts differ (fresh IV each time).
    assert.notEqual(issueGmailScanCursor(facts, T0), issueGmailScanCursor(facts, T0));
    // First page (no Gmail token yet) round-trips too.
    const first = issueGmailScanCursor({ ...facts, pageToken: null, scanned: 0 }, T0);
    assert.deepEqual(verifyGmailScanCursor(first, expect, T0), { ok: true, facts: { ...facts, pageToken: null, scanned: 0 } });
  });

  await check("B2 any edited byte, in any segment, is refused before decryption", () => {
    const c = issueGmailScanCursor(facts, T0);
    const parts = c.split(".");
    for (let s = 1; s < parts.length; s += 1) {
      const seg = parts[s];
      for (const i of [0, Math.floor(seg.length / 2), seg.length - 1]) {
        const flipped = seg.slice(0, i) + (seg[i] === "A" ? "B" : "A") + seg.slice(i + 1);
        const forged = [...parts.slice(0, s), flipped, ...parts.slice(s + 1)].join(".");
        if (forged === c) continue;
        const r = verifyGmailScanCursor(forged, expect, T0);
        assert.equal(r.ok, false);
        assert.ok(!r.ok && (r.reason === "bad_signature" || r.reason === "malformed"), `segment ${s} → ${!r.ok && r.reason}`);
      }
    }
    // Swapping in another cursor's ciphertext under this signature.
    const other = issueGmailScanCursor({ ...facts, businessId: 10 }, T0).split(".");
    const mixed = [parts[0], other[1], other[2], other[3], parts[4]].join(".");
    assert.deepEqual(verifyGmailScanCursor(mixed, expect, T0), { ok: false, reason: "bad_signature" });
  });

  await check("B2b one spelling per cursor: a same-bytes variant of any segment is refused (deterministic)", () => {
    // Segments whose length is not a multiple of 4 end in a character with unused low bits
    // (tag 22 chars, signature 43): flipping those bits keeps the bytes. Search until each case occurs.
    const bump = (s: string) => {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const i = alphabet.indexOf(s[s.length - 1]);
      return s.slice(0, -1) + alphabet[i ^ 1];
    };
    for (const seg of [3, 4]) {
      let found = false;
      for (let n = 0; n < 2000 && !found; n += 1) {
        const parts = issueGmailScanCursor(facts, T0).split(".");
        const variant = bump(parts[seg]);
        if (Buffer.from(variant, "base64url").equals(Buffer.from(parts[seg], "base64url"))) {
          found = true;
          const forged = [...parts.slice(0, seg), variant, ...parts.slice(seg + 1)].join(".");
          const r = verifyGmailScanCursor(forged, expect, T0);
          assert.equal(r.ok, false, `segment ${seg}: a second spelling must not verify`);
          assert.ok(!r.ok && r.reason === "malformed", `segment ${seg} → ${!r.ok && r.reason}`);
        }
      }
      assert.ok(found, `segment ${seg}: no same-bytes variant found to test`);
    }
  });

  await check("B3 a cursor made with another secret, or another purpose's key, is refused", () => {
    const original = process.env.AUTH_TOKEN_SECRET;
    process.env.AUTH_TOKEN_SECRET = "a-completely-different-secret-value";
    const foreign = issueGmailScanCursor(facts, T0);
    process.env.AUTH_TOKEN_SECRET = original;
    assert.deepEqual(verifyGmailScanCursor(foreign, expect, T0), { ok: false, reason: "bad_signature" });

    // Signed the way the OAuth-state / data-transfer envelopes derive keys (HMAC(secret, label)).
    const parts = issueGmailScanCursor(facts, T0).split(".");
    const signed = parts.slice(0, 4).join(".");
    for (const label of ["dubiz-gmail-oauth-state-v1", "mac-v1", "dubiz-gmail-scan-cursor"]) {
      const k = createHmac("sha256", String(original)).update(label).digest();
      const sig = createHmac("sha256", k).update(signed).digest("base64url");
      assert.deepEqual(verifyGmailScanCursor(`${signed}.${sig}`, expect, T0), { ok: false, reason: "bad_signature" }, label);
    }
    // Raw secret as the HMAC key (the auth-token construction).
    const raw = createHmac("sha256", String(original)).update(signed).digest("base64url");
    assert.deepEqual(verifyGmailScanCursor(`${signed}.${raw}`, expect, T0), { ok: false, reason: "bad_signature" });
  });

  await check("B4 expiry at 30 minutes; a cursor from the future is refused", () => {
    const c = issueGmailScanCursor(facts, T0);
    assert.equal(verifyGmailScanCursor(c, expect, T0 + (GMAIL_SCAN_CURSOR_TTL_SECONDS - 1) * 1000).ok, true);
    assert.deepEqual(verifyGmailScanCursor(c, expect, T0 + GMAIL_SCAN_CURSOR_TTL_SECONDS * 1000), { ok: false, reason: "expired" });
    assert.deepEqual(verifyGmailScanCursor(c, expect, T0 + 24 * 3600 * 1000), { ok: false, reason: "expired" });
    assert.equal(GMAIL_SCAN_CURSOR_TTL_SECONDS, 1800);
    const future = issueGmailScanCursor(facts, T0 + 5 * 60 * 1000);
    assert.deepEqual(verifyGmailScanCursor(future, expect, T0), { ok: false, reason: "invalid_payload" });
  });

  await check("B5 another business, user, Gmail account or window → refused", () => {
    const c = issueGmailScanCursor(facts, T0);
    assert.deepEqual(verifyGmailScanCursor(c, { ...expect, businessId: 38 }, T0), { ok: false, reason: "wrong_business" });
    assert.deepEqual(verifyGmailScanCursor(c, { ...expect, userId: 5 }, T0), { ok: false, reason: "wrong_user" });
    assert.deepEqual(verifyGmailScanCursor(c, { ...expect, connectionId: 13 }, T0), { ok: false, reason: "wrong_connection" });
    assert.equal(verifyGmailScanCursor(c, { ...expect, connectionId: 12 }, T0).ok, true);
    // Changing the window in the middle of a scan.
    assert.deepEqual(verifyGmailScanCursor(c, { ...expect, window: 30 }, T0), { ok: false, reason: "wrong_window" });
    assert.deepEqual(verifyGmailScanCursor(c, { ...expect, window: 365 }, T0), { ok: false, reason: "wrong_window" });
  });

  await check("B6 malformed input never throws; missing secret fails closed", () => {
    for (const bad of [undefined, null, 42, "", "x", "gsc1.a.b.c", "gsc1.a.b.c.d.e", "gsc2.a.b.c.d", "gsc1..b.c.d", "gsc1.a+b.c.d.e", "x".repeat(5000), {}]) {
      const r = verifyGmailScanCursor(bad, expect, T0);
      assert.equal(r.ok, false);
    }
    const original = process.env.AUTH_TOKEN_SECRET;
    delete process.env.AUTH_TOKEN_SECRET;
    assert.throws(() => issueGmailScanCursor(facts, T0), GmailScanCursorConfigError);
    assert.throws(() => verifyGmailScanCursor("gsc1.AAAA.AAAA.AAAA.AAAA", expect, T0), GmailScanCursorConfigError);
    process.env.AUTH_TOKEN_SECRET = original;
    assert.throws(() => issueGmailScanCursor({ ...facts, window: 60 as never }, T0), GmailScanCursorConfigError);
    assert.throws(() => issueGmailScanCursor({ ...facts, businessId: 0 }, T0), GmailScanCursorConfigError);
    assert.throws(() => issueGmailScanCursor({ ...facts, pageToken: "" }, T0), GmailScanCursorConfigError);
  });

  // ================================================================ C. page engine
  await check("C1 window: closed list only; the query is built by the server", () => {
    assert.equal(parseGmailScanWindow(null), DEFAULT_GMAIL_SCAN_WINDOW);
    assert.equal(parseGmailScanWindow(""), 30);
    assert.equal(parseGmailScanWindow("30"), 30);
    assert.equal(parseGmailScanWindow("90"), 90);
    assert.equal(parseGmailScanWindow("365"), 365);
    for (const bad of ["60", "30.0", " 90", "0x1e", "365d", "-30", "1e2", "has:attachment", "30 OR from:x"]) {
      assert.equal(parseGmailScanWindow(bad), "invalid", bad);
    }
    assert.equal(gmailScanQuery(30), "has:attachment newer_than:30d");
    assert.equal(gmailScanQuery(365), "has:attachment newer_than:365d");
  });

  type Call = { url: URL };
  function fakeGmail(opts: {
    ids: string[];
    nextPageToken?: string;
    listStatus?: number[];
    message?: (id: string, attempt: number) => { status: number; retryAfter?: string; body?: unknown } | "throw";
    clock?: { t: number };
    readCostMs?: number;
  }) {
    const calls: Call[] = [];
    const sleeps: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const attempts = new Map<string, number>();
    let listAttempt = 0;
    const deps: GmailScanDeps = {
      fetch: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        calls.push({ url });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        if (opts.clock && opts.readCostMs) opts.clock.t += opts.readCostMs;
        inFlight -= 1;
        const isList = url.pathname.endsWith("/messages");
        if (isList) {
          const status = opts.listStatus?.[listAttempt] ?? 200;
          listAttempt += 1;
          if (status !== 200) return new Response("{}", { status, headers: { "retry-after": "1" } });
          return Response.json({ messages: opts.ids.map((id) => ({ id })), nextPageToken: opts.nextPageToken, resultSizeEstimate: 9999 });
        }
        const id = decodeURIComponent(url.pathname.split("/").pop() || "");
        const n = attempts.get(id) ?? 0;
        attempts.set(id, n + 1);
        const r = opts.message?.(id, n) ?? { status: 200 };
        if (r === "throw") throw new Error("network down");
        if (r.status !== 200) return new Response("secret body text", { status: r.status, headers: r.retryAfter ? { "retry-after": r.retryAfter } : {} });
        return Response.json(r.body ?? { id, payload: single(`att-${id}`) });
      }) as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0.5,
      now: () => opts.clock?.t ?? 0,
    };
    return { deps, calls, sleeps, attempts, get maxInFlight() { return maxInFlight; } };
  }
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `msg-${i}`);
  const page = (deps: GmailScanDeps, extra: Partial<{ pageToken: string | null; pageSize: number; window: 30 | 90 | 365 }> = {}) =>
    scanGmailPage({ accessToken: "tok", window: extra.window ?? 90, pageToken: extra.pageToken ?? null, pageSize: extra.pageSize ?? 25 }, deps);

  await check("C2 normal page: query, page size, token, ≤4 in flight, every message read", async () => {
    const g = fakeGmail({ ids: ids(25), nextPageToken: "NEXT" });
    const r = await page(g.deps, { pageToken: "PREV", window: 365 });
    const list = g.calls[0].url;
    assert.equal(list.searchParams.get("q"), "has:attachment newer_than:365d");
    assert.equal(list.searchParams.get("maxResults"), "25");
    assert.equal(list.searchParams.get("pageToken"), "PREV");
    assert.equal(g.calls.length, 26, "1 list + 25 reads");
    assert.ok(g.maxInFlight <= 4 && g.maxInFlight >= 2, `in flight ${g.maxInFlight}`);
    // The approved limits, as literals (a constant compared with itself proves nothing).
    assert.deepEqual(
      [GMAIL_SCAN_PAGE_SIZE, GMAIL_SCAN_SESSION_CAP, GMAIL_SCAN_CONCURRENCY, GMAIL_PAGE_RETRY_BUDGET, GMAIL_RETRY_MAX_WAIT_MS],
      [25, 500, 4, 4, 5000]
    );
    assert.equal(r.complete, true);
    assert.equal(r.readMessages, 25);
    assert.equal(r.nextPageToken, "NEXT");
    assert.equal(r.attachments.length, 25);
    assert.ok(r.attachments.every((a) => a.partId === GMAIL_ROOT_PART_ID));
    assert.equal(r.retries, 0);
    // Page size is clamped to 25 whatever is asked.
    const big = fakeGmail({ ids: ids(3) });
    await page(big.deps, { pageSize: 500 });
    assert.equal(big.calls[0].url.searchParams.get("maxResults"), String(GMAIL_SCAN_PAGE_SIZE));
    const first = fakeGmail({ ids: ids(1) });
    await page(first.deps);
    assert.equal(first.calls[0].url.searchParams.has("pageToken"), false);
  });

  await check("C3 one 429 → one retry after Retry-After; no new reads launched after it; page incomplete", async () => {
    const g = fakeGmail({ ids: ids(25), nextPageToken: "NEXT", message: (id, n) => (id === "msg-0" && n === 0 ? { status: 429, retryAfter: "2" } : { status: 200 }) });
    const r = await page(g.deps);
    assert.equal(g.attempts.get("msg-0"), 2, "retried exactly once");
    assert.deepEqual(g.sleeps, [2000 + 125], "Retry-After 2s + jitter");
    assert.equal(r.throttled, true);
    assert.ok(r.skippedMessages > 0, "the rest were not launched");
    assert.ok(g.calls.length - 1 <= GMAIL_SCAN_CONCURRENCY + 1, `reads ${g.calls.length - 1}`);
    assert.equal(r.complete, false);
    assert.equal(r.readMessages + r.skippedMessages + r.failedMessages, 25);
  });

  await check("C4 429 twice on one read → no third try; 503 treated the same; budget ≤4 per page", async () => {
    const g = fakeGmail({ ids: ids(4), message: () => ({ status: 429, retryAfter: "0" }) });
    const r = await page(g.deps);
    for (const id of ids(4)) assert.ok((g.attempts.get(id) ?? 0) <= 2, id);
    assert.ok(r.retries <= GMAIL_PAGE_RETRY_BUDGET);
    assert.equal(r.complete, false);
    assert.equal(r.failedMessages + r.skippedMessages, 4);

    const s = fakeGmail({ ids: ids(25), message: () => ({ status: 503 }) });
    const rs = await page(s.deps);
    assert.ok(rs.retries <= GMAIL_PAGE_RETRY_BUDGET);
    assert.ok(s.calls.length - 1 <= GMAIL_SCAN_CONCURRENCY + GMAIL_PAGE_RETRY_BUDGET, `reads ${s.calls.length - 1}`);
    assert.equal(rs.complete, false);
  });

  await check("C5 Retry-After longer than 5s → no retry at all; waits never exceed 5s", async () => {
    const g = fakeGmail({ ids: ids(2), message: (id, n) => (n === 0 ? { status: 429, retryAfter: "30" } : { status: 200 }) });
    const r = await page(g.deps);
    assert.equal(g.sleeps.length, 0);
    assert.equal(r.retries, 0);
    assert.equal(r.complete, false);
    const deps = { random: () => 0.999, now: () => 0 };
    assert.equal(retryDelayMs("5", deps), GMAIL_RETRY_MAX_WAIT_MS);
    assert.equal(retryDelayMs("6", deps), null);
    assert.equal(retryDelayMs(null, deps), 1000 + 249);
    assert.equal(retryDelayMs("not a date", deps), null);
    assert.equal(retryDelayMs(new Date(3000).toUTCString(), deps), 3000 + 249);
    for (const v of [null, "0", "1", "4", "5", new Date(4999).toUTCString()]) {
      const w = retryDelayMs(v, deps);
      assert.ok(w !== null && w <= GMAIL_RETRY_MAX_WAIT_MS, String(v));
    }
  });

  await check("C6 other errors are not retried and make the page incomplete; 404 = deleted, page still complete", async () => {
    const e = fakeGmail({ ids: ids(5), message: (id) => (id === "msg-2" ? { status: 500 } : { status: 200 }) });
    const re = await page(e.deps);
    assert.equal(e.attempts.get("msg-2"), 1);
    assert.equal(re.failedMessages, 1);
    assert.equal(re.complete, false);

    const n = fakeGmail({ ids: ids(5), message: (id) => (id === "msg-2" ? "throw" : { status: 200 }) });
    const rn = await page(n.deps);
    assert.equal(rn.failedMessages, 1);
    assert.equal(rn.complete, false);

    const bad = fakeGmail({ ids: ids(2), message: (id) => (id === "msg-1" ? { status: 200, body: "not an object" } : { status: 200 }) });
    const rb = await page(bad.deps);
    assert.equal(rb.failedMessages, 1);
    assert.equal(rb.complete, false);

    const gone = fakeGmail({ ids: ids(5), nextPageToken: "N", message: (id) => (id === "msg-2" ? { status: 404 } : { status: 200 }) });
    const rg = await page(gone.deps);
    assert.equal(rg.goneMessages, 1);
    assert.equal(rg.complete, true);
    assert.equal(rg.readMessages, 4);
  });

  await check("C7 list failures: 401 → unauthorized; 429 twice → throttled; 500 → failed; never a partial list", async () => {
    for (const [statuses, kind] of [[[401], "unauthorized"], [[429, 429], "throttled"], [[503, 503], "throttled"], [[500], "failed"]] as const) {
      const g = fakeGmail({ ids: ids(3), listStatus: [...statuses] });
      await assert.rejects(page(g.deps), (e: unknown) => e instanceof GmailScanListError && e.kind === kind);
      assert.equal(g.calls.length, statuses.length, "no message read after a failed list");
    }
    const once = fakeGmail({ ids: ids(3), listStatus: [429, 200] });
    const r = await page(once.deps);
    assert.equal(r.readMessages, 0, "throttled on the list: no reads launched");
    assert.equal(r.complete, false);
  });

  await check("C8 the page deadline stops new reads → incomplete, never silently short", async () => {
    const clock = { t: 0 };
    const g = fakeGmail({ ids: ids(25), clock, readCostMs: 4_000 });
    const r = await page(g.deps);
    assert.ok(r.skippedMessages > 0);
    assert.equal(r.complete, false);
    assert.equal(r.readMessages + r.skippedMessages, 25);
  });

  await check("C9 a duplicated id in Gmail's list is read once", async () => {
    const g = fakeGmail({ ids: ["a", "b", "a", "c", "b"] });
    const r = await page(g.deps);
    assert.equal(r.listedMessages, 3);
    assert.equal(g.calls.length, 4);
  });

  // ================================================================ D. advancing
  await check("D1 an incomplete page never advances and counts nothing", () => {
    const p = planAfterPage({ complete: false, listedMessages: 25, nextPageToken: "N", scannedBefore: 50, attempt: 0 });
    assert.deepEqual(p, { scannedTotal: 50, capReached: false, hasMore: true, advanceTo: null, retrySamePage: true, stoppedUnfinished: false });
  });

  await check("D2 complete pages advance; the end of the window is reported as the end", () => {
    assert.deepEqual(planAfterPage({ complete: true, listedMessages: 25, nextPageToken: "N", scannedBefore: 0, attempt: 0 }),
      { scannedTotal: 25, capReached: false, hasMore: true, advanceTo: "N", retrySamePage: false, stoppedUnfinished: false });
    assert.deepEqual(planAfterPage({ complete: true, listedMessages: 7, nextPageToken: null, scannedBefore: 25, attempt: 0 }),
      { scannedTotal: 32, capReached: false, hasMore: false, advanceTo: null, retrySamePage: false, stoppedUnfinished: false });
  });

  await check("D3 the 500 cap stops the scan but never claims everything was found", () => {
    const p = planAfterPage({ complete: true, listedMessages: 25, nextPageToken: "N", scannedBefore: GMAIL_SCAN_SESSION_CAP - 25, attempt: 0 });
    assert.deepEqual(p, { scannedTotal: 500, capReached: true, hasMore: true, advanceTo: null, retrySamePage: false, stoppedUnfinished: false });
    // Exactly 500 with nothing left: a finished scan, not a capped one.
    const done = planAfterPage({ complete: true, listedMessages: 25, nextPageToken: null, scannedBefore: 475, attempt: 0 });
    assert.equal(done.capReached, false);
    assert.equal(done.hasMore, false);
    // Walk a whole session: at most 20 pages, never a cursor past 500.
    let scanned = 0;
    let pages = 0;
    let token: string | null = "start";
    while (token !== null) {
      const plan = planAfterPage({ complete: true, listedMessages: Math.min(GMAIL_SCAN_PAGE_SIZE, GMAIL_SCAN_SESSION_CAP - scanned), nextPageToken: "more", scannedBefore: scanned, attempt: 0 });
      scanned = plan.scannedTotal;
      token = plan.advanceTo;
      pages += 1;
      assert.ok(pages <= 20);
    }
    assert.equal(scanned, 500);
    assert.equal(pages, 20);
  });

  await check("D4 a message that keeps failing: same page retried at most 3 times in all, then the scan STOPS unfinished", async () => {
    assert.equal(GMAIL_SCAN_MAX_PAGE_ATTEMPTS, 3);
    // Drive the real engine + plan + cursor the way the route does, with one message that never reads.
    const g = fakeGmail({ ids: ids(25), nextPageToken: "NEXT", message: (id) => (id === "msg-7" ? { status: 500 } : { status: 200 }) });
    let cursor: string | null = issueGmailScanCursor({ ...facts, pageToken: "PAGE-3", scanned: 50, attempt: 0 }, T0);
    let requests = 0;
    let last: ReturnType<typeof planAfterPage> | null = null;
    while (cursor !== null) {
      requests += 1;
      assert.ok(requests <= 10, "never an endless loop");
      const v = verifyGmailScanCursor(cursor, expect, T0);
      assert.ok(v.ok);
      if (!v.ok) break;
      assert.equal(v.facts.pageToken, "PAGE-3", "never moves past the failing page");
      assert.equal(v.facts.scanned, 50, "nothing counted");
      const r = await page(g.deps, { pageToken: v.facts.pageToken });
      assert.equal(r.complete, false);
      last = planAfterPage({ complete: r.complete, listedMessages: r.listedMessages, nextPageToken: r.nextPageToken, scannedBefore: v.facts.scanned, attempt: v.facts.attempt });
      assert.equal(last.advanceTo, null, "no next cursor while a message is unread");
      cursor = last.retrySamePage ? issueGmailScanCursor({ ...v.facts, attempt: v.facts.attempt + 1 }, T0) : null;
    }
    assert.equal(requests, 3);
    assert.ok(last && last.stoppedUnfinished && !last.retrySamePage && last.hasMore && last.scannedTotal === 50);
    assert.equal(g.attempts.get("msg-7"), 3, "the failing message was tried once per attempt — no hidden retries on a 500");
    // Bounded Gmail cost for the whole episode: 3 × (1 list + 25 reads).
    assert.equal(g.calls.length, 3 * 26);
    // Same rule when the LIST itself keeps failing.
    assert.equal(planAfterPage({ complete: false, listedMessages: 0, nextPageToken: null, scannedBefore: 0, attempt: 2 }).stoppedUnfinished, true);
    assert.equal(planAfterPage({ complete: false, listedMessages: 0, nextPageToken: null, scannedBefore: 0, attempt: 1 }).retrySamePage, true);
    // A complete page after earlier failures resets the counter (next cursor attempt 0, see F6).
    assert.equal(planAfterPage({ complete: true, listedMessages: 25, nextPageToken: "N", scannedBefore: 0, attempt: 2 }).advanceTo, "N");
  });

  await check("D5 cursor attempt field: carried sealed, bounded, cannot be forged downward", () => {
    const c = issueGmailScanCursor({ ...facts, attempt: 2 }, T0);
    const v = verifyGmailScanCursor(c, expect, T0);
    assert.ok(v.ok && v.facts.attempt === 2);
    assert.throws(() => issueGmailScanCursor({ ...facts, attempt: -1 }, T0), GmailScanCursorConfigError);
    assert.throws(() => issueGmailScanCursor({ ...facts, attempt: 11 }, T0), GmailScanCursorConfigError);
    assert.throws(() => issueGmailScanCursor({ ...facts, attempt: 1.5 }, T0), GmailScanCursorConfigError);
    // Resetting the counter means editing the sealed payload → bad signature (B2 covers every byte).
  });

  await check("D6 import lookup (Gmail mocked): root with a changed id imports; regular + nested parts unaffected", async () => {
    const realFetch = globalThis.fetch;
    let served: GmailMessagePart = single("S2");
    globalThis.fetch = (async () => Response.json({ id: "m", payload: served })) as typeof fetch;
    try {
      // What the current screen got from discovery for a single-file message (id S1), sent back as-is.
      const picked = classifyGmailMessage("m", { id: "m", payload: single("S1") }).attachments[0];
      const root = await fetchGmailAttachmentDescriptor({ accessToken: "t", messageId: "m", attachmentId: picked.attachmentId, partId: picked.partId, filename: picked.filename, sizeBytes: picked.sizeBytes });
      assert.ok(root.ok);
      if (root.ok) {
        assert.equal(root.descriptor.matchedBy, "root_part");
        assert.equal(root.descriptor.attachmentId, "S2", "download uses THIS fetch's id");
        assert.equal(root.descriptor.mimeType, "application/pdf", "type from Gmail");
      }
      // Regular and nested parts in a multipart message whose ids all changed.
      served = SECOND;
      for (const d of classifyGmailMessage("m-1", { id: "m-1", payload: FIRST }).attachments) {
        const r = await fetchGmailAttachmentDescriptor({ accessToken: "t", messageId: "m-1", attachmentId: d.attachmentId, partId: d.partId, filename: d.filename, sizeBytes: d.sizeBytes });
        assert.ok(r.ok && r.descriptor.matchedBy === "part_id" && r.descriptor.filename === d.filename, String(d.partId));
      }
      // An old client that never sends partId: exactly #1009's refusal.
      served = single("S2");
      assert.deepEqual(
        await fetchGmailAttachmentDescriptor({ accessToken: "t", messageId: "m", attachmentId: "S1", filename: "scan-0001.pdf", sizeBytes: 333_000 }),
        { ok: false, reason: "ATTACHMENT_NOT_IN_MESSAGE", detail: "no_part_id" }
      );
      // "root" sent for a multipart message (e.g. a forged request) never picks a nested file.
      served = SECOND;
      assert.deepEqual(
        await fetchGmailAttachmentDescriptor({ accessToken: "t", messageId: "m-1", attachmentId: "x", partId: "root", filename: "invoice.pdf", sizeBytes: 200_000 }),
        { ok: false, reason: "ATTACHMENT_NOT_IN_MESSAGE", detail: "part_not_found" }
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await check("D7 old clients / rollback: no new dependency on the client side", () => {
    // The screen sends partId back verbatim and the import route accepts any string there.
    const pageSrc = read("app/(shell)/documents/email/page.tsx");
    assert.match(pageSrc, /partId: attachment\.partId \?\? null,/);
    const imp = read("app/api/integrations/gmail/import/route.ts");
    assert.match(imp, /partId: safeNullableString\(\(json as \{ partId\?: unknown \}\)\.partId\),/);
    // The modules the browser bundle gains are pure (no imports at all).
    assert.equal(/^\s*import\s/m.test(read("lib/services/email-import/attachment-key.ts")), false);
    assert.equal(/^\s*import\s/m.test(read("lib/services/email-import/scan-window.ts")), false);
    // The screen never calls the new route.
    assert.equal(pageSrc.includes("/api/integrations/gmail/scan"), false);
  });

  // ================================================================ E. rate limit (page ceilings)
  await check("E1 GMAIL_SCAN: fail-closed; 3/min + 60/h per user, 6/min + 120/h per business", async () => {
    const b = BUCKETS.GMAIL_SCAN;
    assert.equal(b.failMode, "closed");
    assert.deepEqual(b.rules, [
      { scope: "user", limit: 3, windowSeconds: 60 },
      { scope: "user", limit: 60, windowSeconds: 3600 },
      { scope: "business", limit: 6, windowSeconds: 60 },
      { scope: "business", limit: 120, windowSeconds: 3600 },
    ]);
    resetMemoryBackendForTests();
    for (let i = 0; i < 3; i += 1) assert.equal((await checkRateLimit({ bucket: "GMAIL_SCAN", user: 1, business: 9 })).allowed, true);
    const denied = await checkRateLimit({ bucket: "GMAIL_SCAN", user: 1, business: 9 });
    assert.equal(denied.allowed, false);
    assert.equal(denied.scope, "user");
  });

  await check("E2 a business cannot get past its ceiling with more users; other businesses unaffected", async () => {
    resetMemoryBackendForTests();
    for (let u = 0; u < 6; u += 1) {
      assert.equal((await checkRateLimit({ bucket: "GMAIL_SCAN", user: 100 + u, business: 9 })).allowed, true, `user ${u}`);
    }
    const seventh = await checkRateLimit({ bucket: "GMAIL_SCAN", user: 999, business: 9 });
    assert.equal(seventh.allowed, false, "a fresh user of the same business is still refused");
    assert.equal(seventh.scope, "business");
    assert.equal((await checkRateLimit({ bucket: "GMAIL_SCAN", user: 1, business: 38 })).allowed, true);
  });

  const downBackend: RateLimitBackend = {
    name: "redis",
    async evaluate() { throw new RateLimiterBackendError("simulated outage"); },
    async reserveAttempt() { throw new RateLimiterBackendError("simulated outage"); },
    async clearAttempts() { throw new RateLimiterBackendError("simulated outage"); },
    async lockAttempts() { throw new RateLimiterBackendError("simulated outage"); },
  };

  await check("E3 limiter down: the extended scan is refused (no local count); other buckets keep their posture", async () => {
    const errors = console.error;
    console.error = () => {};
    try {
      configureRateLimiterForTests({ backend: downBackend });
      const d = await checkRateLimit({ bucket: "GMAIL_SCAN", user: 7, business: 77 });
      assert.equal(d.allowed, false);
      assert.equal(d.outcome, "backend_unavailable");
      assert.equal((await checkRateLimit({ bucket: "DOCUMENTS_API", user: 7, business: 77 })).allowed, true, "open stays open");
      assert.equal((await checkRateLimit({ bucket: "UPLOAD_ACCEPT", user: 7, business: 77 })).outcome, "backend_unavailable");
    } finally {
      configureRateLimiterForTests({ backend: null });
      console.error = errors;
    }
    // The route turns that into the clear Hebrew "temporarily unavailable" answer, B3 only.
    const route = read("app/api/integrations/gmail/scan/route.ts");
    assert.match(route, /if \(decision\.outcome === "backend_unavailable"\) return scanUnavailable\("limiter_unavailable"\);/);
    assert.ok(route.includes("סריקת Gmail המורחבת אינה זמינה זמנית"));
  });

  await check("E4 every existing bucket keeps its fail mode; no local fallback mode exists", () => {
    const expected: Record<string, string> = {
      UPLOAD_ACCEPT: "closed", DOCUMENT_PROCESSING: "closed", ACQUISITION_INTAKE: "open", ACQUISITION_WEB_PUBLIC: "open",
      ACCOUNTANT_LINK_PUBLIC: "closed", ACCOUNTANT_LINK_FILE: "closed", ACCOUNTANT_LINK_CODE: "closed",
      ACCOUNTANT_LINK_VERIFY: "closed", ACCOUNTANT_SEND: "closed", PUBLIC_BOOKING_SUBMIT: "closed",
      PUBLIC_BOOKING_SUBMIT_BUSINESS: "closed", PUBLIC_BOOKING_READ: "closed", PUBLIC_BOOKING_MANAGE: "closed",
      GMAIL_SCAN: "closed", DOCUMENTS_API: "open", WHATSAPP_INTAKE: "open", CRM_ATTACHMENT_UPLOAD: "closed",
      DATA_TRANSFER_IMPORT_EXECUTE: "closed", DATA_TRANSFER_DOCUMENTS_IMPORT: "closed", LANDING_COMPOSE: "closed",
    };
    const actual = Object.fromEntries(Object.entries(BUCKETS).map(([k, v]) => [k, v.failMode]));
    assert.deepEqual(actual, expected);
    assert.equal(read("lib/security/rate-limiter/types.ts").includes('"local"'), false);
    assert.equal(/failMode === "local"|localFallback\.evaluate\(prefixForRule/.test(read("lib/security/rate-limiter/index.ts")), false);
  });

  // ================================================================ G. Gmail quota-unit budget
  await check("G1 a page can never spend more than the units reserved for it (retries, failures, throttling)", async () => {
    assert.equal(GMAIL_UNITS_LIST, 5);
    assert.equal(GMAIL_UNITS_GET_FULL, 60);
    assert.equal(gmailPageWorstCaseUnits(25), 5 + 29 * 60);
    let scenarios = 0;
    const behaviours: Array<(id: string, n: number) => { status: number; retryAfter?: string } | "throw"> = [
      () => ({ status: 200 }),
      () => ({ status: 429, retryAfter: "0" }),
      () => ({ status: 503, retryAfter: "1" }),
      () => ({ status: 500 }),
      () => "throw",
      (id, n) => (n === 0 ? { status: 429, retryAfter: "0" } : { status: 200 }),
      (id) => (id.endsWith("3") ? { status: 503, retryAfter: "0" } : { status: 200 }),
      (id) => (id.endsWith("1") ? { status: 404 } : { status: 429, retryAfter: "0" }),
    ];
    for (const message of behaviours) {
      for (const listStatus of [[200], [429, 200], [503, 200]]) {
        for (const size of [1, 7, 25]) {
          const g = fakeGmail({ ids: ids(size), message, listStatus: [...listStatus] });
          const r = await page(g.deps, { pageSize: size });
          const spent = gmailUnitsSpent(r);
          const billed = g.calls.reduce((s, c) => s + (c.url.pathname.endsWith("/messages") ? 5 : 60), 0);
          assert.equal(spent, billed, "every call Gmail saw is counted");
          assert.ok(spent <= gmailPageWorstCaseUnits(size), `spent ${spent} > reserved ${gmailPageWorstCaseUnits(size)}`);
          scenarios += 1;
        }
      }
    }
    // A failed list carries its own call count for settling.
    const lf = fakeGmail({ ids: ids(3), listStatus: [429, 429] });
    await assert.rejects(page(lf.deps), (e: unknown) => e instanceof GmailScanListError && e.listCalls === 2);
    assert.ok(scenarios >= 72);
  });

  const NOW = Date.UTC(2026, 10, 9, 12, 0, 30); // 30s into a minute
  await check("G2 mailbox budget: two worst-case pages a minute per Gmail account; refunds give unused room back", async () => {
    configureGmailBudgetStoreForTests(memoryBudgetStore());
    try {
      const ids1 = { connectionId: 1, businessId: 9 };
      const a = await reserveGmailScanBudget(ids1, 25, NOW);
      const b = await reserveGmailScanBudget(ids1, 25, NOW);
      assert.ok(a.ok && b.ok);
      const c = await reserveGmailScanBudget(ids1, 25, NOW);
      assert.deepEqual(c, { ok: false, reason: "exhausted", scope: "mailbox" });
      // Another mailbox of the same business still has its own room.
      assert.equal((await reserveGmailScanBudget({ connectionId: 2, businessId: 9 }, 25, NOW)).ok, true);
      // Page A really spent a typical 1 list + 25 reads: the rest comes back.
      if (a.ok) assert.equal(await settleGmailScanBudget(a, 5 + 25 * 60), 4 * 60);
      // 3,250 used: no third worst case, not even a 1-message page (its retry budget makes it 305).
      assert.equal((await reserveGmailScanBudget(ids1, 25, NOW)).ok, false);
      assert.equal((await reserveGmailScanBudget(ids1, 1, NOW)).ok, false);
      // Page B settles too (3,010 used, 490 free): now a 1-message page fits — a refund is real room.
      if (b.ok) assert.equal(await settleGmailScanBudget(b, 5 + 25 * 60), 4 * 60);
      assert.equal((await reserveGmailScanBudget(ids1, 1, NOW)).ok, true);
    } finally {
      configureGmailBudgetStoreForTests(null);
    }
  });

  await check("G3 business budget: more mailboxes or users cannot get one business past 7,000 units a minute", async () => {
    configureGmailBudgetStoreForTests(memoryBudgetStore());
    try {
      const results: string[] = [];
      for (const connectionId of [1, 1, 2, 2, 3, 4, 5]) {
        const r = await reserveGmailScanBudget({ connectionId, businessId: 9 }, 25, NOW);
        results.push(r.ok ? "ok" : r.reason === "exhausted" ? r.scope : "unavailable");
      }
      assert.deepEqual(results, ["ok", "ok", "ok", "ok", "business", "business", "business"]);
      // Business 38 is untouched by business 9.
      assert.equal((await reserveGmailScanBudget({ connectionId: 77, businessId: 38 }, 25, NOW)).ok, true);
    } finally {
      configureGmailBudgetStoreForTests(null);
    }
  });

  /** A stand-in Redis: one shared map, scripts executed atomically (one JS turn), like Redis EVAL. */
  function fakeRedis() {
    const map = new Map<string, number>();
    const scripts: string[] = [];
    const client: EvalClient = {
      async eval(script, keys, args) {
        scripts.push(script);
        await new Promise((r) => setTimeout(r, Math.random() * 2)); // network jitter BEFORE the atomic step
        if (script === RESERVE_LUA) {
          const amount = Number(args[0]);
          const n = keys.length / 2;
          for (let i = 0; i < n; i += 1) {
            const cur = map.get(keys[2 * i]) ?? 0;
            const prev = map.get(keys[2 * i + 1]) ?? 0;
            if (prev * Number(args[2 + 3 * i]) + cur + amount > Number(args[1 + 3 * i])) return i + 1;
          }
          for (let i = 0; i < n; i += 1) map.set(keys[2 * i], (map.get(keys[2 * i]) ?? 0) + amount);
          return 0;
        }
        if (script === REFUND_LUA) {
          for (const k of keys) map.set(k, (map.get(k) ?? 0) - Math.min(map.get(k) ?? 0, Number(args[0])));
          return 0;
        }
        throw new Error("unknown script");
      },
    };
    return { client, map, scripts };
  }

  await check("G4 global budget holds across instances under a parallel burst (no overshoot)", async () => {
    const redis = fakeRedis();
    const instanceA = redisBudgetStore(() => redis.client);
    const instanceB = redisBudgetStore(() => redis.client);
    const per = gmailPageWorstCaseUnits(25);
    const fits = Math.floor(GMAIL_SCAN_BUDGETS.global_minute.limit / per); // 343
    // 500 pages at once from 500 different businesses, alternating between two instances.
    const shared: GmailBudgetStore = {
      reserve: (lines, amount) => (Math.random() < 0.5 ? instanceA : instanceB).reserve(lines, amount),
      refund: (keys, amount) => instanceA.refund(keys, amount),
    };
    configureGmailBudgetStoreForTests(shared);
    let granted = 0;
    let globalRefusals = 0;
    try {
      await Promise.all(Array.from({ length: 500 }, async (_, i) => {
        const r = await reserveGmailScanBudget({ connectionId: 10_000 + i, businessId: 10_000 + i }, 25, NOW);
        if (r.ok) granted += 1;
        else if (r.reason === "exhausted" && r.scope === "global_minute") globalRefusals += 1;
      }));
    } finally {
      configureGmailBudgetStoreForTests(null);
    }
    assert.equal(granted, fits, "exactly what fits");
    assert.equal(granted + globalRefusals, 500);
    const globalKey = [...redis.map.keys()].find((k) => k.includes(":global_minute:all:"));
    assert.ok(globalKey && (redis.map.get(globalKey) ?? 0) <= GMAIL_SCAN_BUDGETS.global_minute.limit);
    assert.ok(redis.scripts.every((s) => s === RESERVE_LUA), "one atomic script per reservation");
  });

  await check("G5 the budget lines and the Lua script: check every line first, charge only if all fit", () => {
    const lines = budgetLines({ connectionId: 3, businessId: 9 }, NOW);
    assert.deepEqual(lines.map((l) => [l.name, l.limit]), [
      ["mailbox", 3_500], ["business_minute", 7_000], ["business_hour", 105_000], ["global_minute", 600_000], ["global_day", 20_000_000],
    ]);
    for (const l of lines) {
      assert.ok(l.curKey.startsWith("gq:{gmail-scan}:"), "one hash tag -> one slot -> one atomic script");
      assert.ok(l.prevWeight > 0 && l.prevWeight <= 1);
      assert.notEqual(l.curKey, l.prevKey);
    }
    assert.equal(lines[0].prevWeight, 0.5, "30s into the minute: half of the previous minute still counts");
    const checkAt = RESERVE_LUA.indexOf("return i + 1");
    const chargeAt = RESERVE_LUA.indexOf("INCRBY");
    assert.ok(checkAt > 0 && chargeAt > checkAt, "all checks precede any charge");
    // Redis does not roll back a half-run script: a non-integer counter must stop it before any write.
    const guardAt = RESERVE_LUA.indexOf("cur ~= math.floor(cur) or prev ~= math.floor(prev) then return -1");
    assert.ok(guardAt > 0 && guardAt < chargeAt, "counters validated before the first INCRBY");
    assert.ok(REFUND_LUA.includes("math.min(v, amount)"), "refund never below zero");
    // Planned under the stricter published table, with headroom.
    assert.ok(GMAIL_SCAN_BUDGETS.mailbox.limit <= 6_000 * 0.6);
    assert.ok(GMAIL_SCAN_BUDGETS.global_minute.limit <= 1_200_000 * 0.5);
    assert.ok(GMAIL_SCAN_BUDGETS.business_minute.limit * 50 < GMAIL_SCAN_BUDGETS.global_minute.limit, "no business near the global budget");
  });

  await check("G6 sliding window: the end of last minute still counts at the start of this one", async () => {
    configureGmailBudgetStoreForTests(memoryBudgetStore());
    try {
      const endOfMinute = Date.UTC(2026, 10, 9, 12, 0, 59, 900);
      const ids1 = { connectionId: 5, businessId: 9 };
      assert.ok((await reserveGmailScanBudget(ids1, 25, endOfMinute)).ok);
      assert.ok((await reserveGmailScanBudget(ids1, 25, endOfMinute)).ok);
      // 200ms later, a new fixed window — but the sliding count still sees ~3,490.
      assert.equal((await reserveGmailScanBudget(ids1, 25, endOfMinute + 200)).ok, false);
    } finally {
      configureGmailBudgetStoreForTests(null);
    }
  });

  await check("G7 store unreachable or unconfigured -> fail closed (never throws, never scans)", async () => {
    const broken: GmailBudgetStore = {
      async reserve() { throw new RateLimiterBackendError("down"); },
      async refund() { throw new RateLimiterBackendError("down"); },
    };
    configureGmailBudgetStoreForTests(broken);
    try {
      assert.deepEqual(await reserveGmailScanBudget({ connectionId: 1, businessId: 9 }, 25, NOW), { ok: false, reason: "unavailable" });
      // A failed refund is harmless (stays conservative) and does not throw.
      assert.equal(await settleGmailScanBudget({ reserved: 1745, curKeys: ["x"] }, 100), 0);
    } finally {
      configureGmailBudgetStoreForTests(null);
    }
    // Production-like selection with no Upstash configured: closed, not a silent memory fallback.
    const saved = { b: process.env.RATE_LIMIT_BACKEND, u: process.env.UPSTASH_REDIS_REST_URL, t: process.env.UPSTASH_REDIS_REST_TOKEN };
    process.env.RATE_LIMIT_BACKEND = "redis";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      assert.deepEqual(await reserveGmailScanBudget({ connectionId: 1, businessId: 9 }, 25, NOW), { ok: false, reason: "unavailable" });
    } finally {
      process.env.RATE_LIMIT_BACKEND = saved.b;
      if (saved.u !== undefined) process.env.UPSTASH_REDIS_REST_URL = saved.u;
      if (saved.t !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = saved.t;
    }
    // Settling never refunds more than was reserved.
    configureGmailBudgetStoreForTests(memoryBudgetStore());
    try {
      assert.equal(await settleGmailScanBudget({ reserved: 1745, curKeys: ["k"] }, 99_999), 0);
      assert.equal(await settleGmailScanBudget({ reserved: 1745, curKeys: ["k"] }, -5), 1745);
    } finally {
      configureGmailBudgetStoreForTests(null);
    }
  });

  await check("G8 route: reserve after the account is known and BEFORE Gmail; settle on every path; a refusal skips nothing", () => {
    const route = read("app/api/integrations/gmail/scan/route.ts");
    const at = (s: string) => {
      const i = route.indexOf(s);
      assert.ok(i >= 0, s);
      return i;
    };
    assert.ok(at("loadGmailAccess({") < at("reserveGmailScanBudget(") && at("reserveGmailScanBudget(") < at("scanGmailPage({"));
    assert.ok(route.includes("await settleGmailScanBudget(budget, gmailUnitsSpent({ listCalls: error.listCalls, getCalls: 0 }));"));
    assert.match(route, /const unitsSpent = gmailUnitsSpent\(page\);\n\s+await settleGmailScanBudget\(budget, unitsSpent\);/);
    // Budget refused / unavailable: the SAME page, same count, same attempt (not an attempt).
    assert.ok(route.includes("const sameCursor = cursorFor(pageToken, scannedBefore, attempt);"));
    assert.ok(route.includes('if (budget.reason === "unavailable") return scanUnavailable("budget_unavailable", sameCursor);'));
    assert.match(route, /status: "budget_exhausted",[\s\S]{0,200}retryCursor: sameCursor,/);
    assert.ok(route.includes("הגענו למכסת הסריקה הזמנית מול Gmail"));
    assert.ok(route.includes("ייבוא מסמכים שכבר נמצאו ממשיך לעבוד כרגיל"));
  });

  await check("G9 import, /sync and connect never touch the scan budget or the GMAIL_SCAN bucket", () => {
    for (const p of [
      "app/api/integrations/gmail/import/route.ts",
      "app/api/integrations/gmail/sync/route.ts",
      "app/api/integrations/gmail/connect/route.ts",
      "app/api/integrations/gmail/callback/route.ts",
      "lib/services/integrations/gmail/gmail-discovery.service.ts",
      "lib/services/integrations/gmail/gmail-attachment-metadata.service.ts",
      "lib/services/integrations/gmail/gmail-attachment-fetch.service.ts",
    ]) {
      const src = read(p);
      assert.equal(/gmail-quota-budget|GMAIL_SCAN\b|checkRateLimit/.test(src), false, p);
    }
  });

  // ================================================================ F. old paths + route
  await check("F1 the legacy scan, /sync and import keep their behaviour", () => {
    const sync = read("app/api/integrations/gmail/sync/route.ts");
    assert.equal(/scan-cursor|scan-window|scanGmailPage|GMAIL_SCAN/.test(sync), false, "/sync is not on the new path");
    assert.match(sync, /discoverGmailAttachments\(\{\n\s+businessId: user\.businessId,\n\s+connectionId,\n\s+maxMessages,\n\s+\}\)/);
    const disc = read("lib/services/integrations/gmail/gmail-discovery.service.ts");
    assert.ok(disc.includes('const q = params.query || "has:attachment newer_than:30d";'));
    assert.ok(disc.includes("const maxMessages = Math.min(Math.max(params.maxMessages ?? 30, 1), 100);"));
    const legacy = disc.slice(disc.indexOf("export async function discoverGmailAttachments"));
    assert.equal(/Promise\.all|pageToken|retry/i.test(legacy), false, "legacy scan stays sequential, one page, no retries");
    const imp = read("app/api/integrations/gmail/import/route.ts");
    assert.equal(/scan-cursor|scan-window|GMAIL_SCAN|attachment-key/.test(imp), false, "import route not modified for B3-a");
    assert.match(imp, /lookup\.descriptor\.attachmentId/);
  });

  await check("F2 new route: auth → rate limit → window → cursor → ownership → Gmail; no free-text query", () => {
    const route = read("app/api/integrations/gmail/scan/route.ts");
    const at = (s: string) => {
      const i = route.indexOf(s);
      assert.ok(i >= 0, s);
      return i;
    };
    const order = [
      at("await getCurrentUser(req)"),
      at('checkRateLimit({ bucket: "GMAIL_SCAN", user: user.id, business: user.businessId })'),
      at('parseGmailScanWindow(req.nextUrl.searchParams.get("window"))'),
      at("verifyGmailScanCursor(cursorRaw"),
      at("isGmailConnectionOwnedByBusiness("),
      at("loadGmailAccess({"),
      at("scanGmailPage({"),
    ];
    assert.deepEqual([...order].sort((a, b) => a - b), order, "steps in this order");
    const params = [...route.matchAll(/searchParams\.get\("([^"]+)"\)/g)].map((m) => m[1]).sort();
    assert.deepEqual(params, ["connectionId", "cursor", "window"], "nothing else is read from the request");
    assert.match(route, /expectConnectionId,/);
    assert.match(route, /businessId: user\.businessId,\n\s+userId: user\.id,\n\s+window,\n\s+connectionId,/);
    // An incomplete page: retry cursor for the same page token and count.
    assert.ok(route.includes("const retryCursor = plan.retrySamePage ? cursorFor(pageToken, scannedBefore, attempt + 1) : null;"));
    assert.ok(route.includes("const nextCursor = plan.advanceTo !== null ? cursorFor(plan.advanceTo, plan.scannedTotal, 0) : null;"));
    // Gmail's token never leaves in the clear.
    assert.equal(/nextPageToken:|pageToken: page|"pageToken"/.test(route.slice(route.indexOf("return NextResponse.json({\n      success"))), false);
  });

  await check("F3 the connection guard runs before any token decrypt / refresh / Google call", () => {
    const disc = read("lib/services/integrations/gmail/gmail-discovery.service.ts");
    const fn = disc.slice(disc.indexOf("export async function loadGmailAccess"), disc.indexOf("export async function discoverGmailAttachments"));
    const guard = fn.indexOf("throw new GmailScanConnectionMismatchError()");
    assert.ok(guard > 0);
    assert.ok(guard < fn.indexOf("decryptToken("));
    assert.ok(guard < fn.indexOf("refreshGoogleAccessToken("));
  });

  await check("F4 logs: numbers and fixed codes only", () => {
    const route = read("app/api/integrations/gmail/scan/route.ts");
    const calls = route.match(/console\.(info|warn|error|log)\([\s\S]*?\);/g) ?? [];
    assert.equal(calls.length, 7);
    const info = calls.find((c) => c.includes("GMAIL_SCAN_PAGE:"));
    assert.ok(info);
    const keys = [...info!.matchAll(/^\s+(\w+)(?::|,)/gm)].map((m) => m[1]);
    for (const k of keys) {
      assert.equal(/email|from|subject|file|name|token|cursor|id$/i.test(k), false, `log key ${k}`);
    }
    for (const c of calls.filter((c) => c !== info)) {
      assert.match(c, /console\.\w+\("GMAIL_SCAN_[A-Z_]+:", (reason|budget\.scope|error\.kind|error\.reason|error instanceof Error \? error\.name : "unknown")\);/, c);
    }
    const engine = read("lib/services/integrations/gmail/gmail-scan-page.service.ts");
    assert.equal(/console\./.test(engine), false, "the engine logs nothing (no body, no id)");
  });

  await check("F5 no background work: the new code schedules nothing", () => {
    for (const p of ["app/api/integrations/gmail/scan/route.ts", "lib/services/integrations/gmail/gmail-scan-page.service.ts", "lib/services/integrations/gmail/gmail-scan-cursor.ts"]) {
      const src = read(p);
      assert.equal(/\bafter\(|setInterval|waitUntil|runTenantJob|cron/i.test(src), false, p);
    }
    const vercel = fs.existsSync("vercel.json") ? read("vercel.json") : "";
    assert.equal(vercel.includes("gmail"), false, "no Gmail cron");
  });

  await check("F6 a partial page is never a success; retries are counted; a complete page resets the count", () => {
    const route = read("app/api/integrations/gmail/scan/route.ts");
    assert.match(route, /success: page\.complete,\n\s+status,/);
    assert.match(route, /const status = page\.complete \? "complete" : plan\.stoppedUnfinished \? "stopped_unfinished" : "incomplete";/);
    assert.equal(/success: true/.test(route), false, "no unconditional success anywhere");
    assert.match(route, /cursorFor\(plan\.advanceTo, plan\.scannedTotal, 0\)/);
    assert.match(route, /plan\.retrySamePage \? cursorFor\(pageToken, scannedBefore, attempt \+ 1\) : null/);
    // A failed list counts against the same limit and also ends without a cursor.
    assert.match(route, /const failedPlan = planAfterPage\(\{ complete: false, listedMessages: 0, nextPageToken: null, scannedBefore, attempt \}\);/);
    assert.match(route, /retryCursor: failedPlan\.retrySamePage \? cursorFor\(pageToken, scannedBefore, attempt \+ 1\) : null,/);
    assert.match(route, /success: false,\n\s+status: failedPlan\.stoppedUnfinished \? "stopped_unfinished" : "incomplete",/);
  });

  console.log(`GMAIL SCAN B3-A VERIFY PASS — ${passed} checks green.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
