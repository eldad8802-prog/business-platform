/**
 * Transactional email — the pure half: configuration, registry, WELCOME rendering, the provider
 * adapter (fake fetch), retry / expiry policy, delivery and sweep while OFF, the sweep route's
 * authority, and the static scope of who may enqueue and who may deliver.
 * No database, no network.   Run: npx tsx lib/email/transactional/transactional-email.test.ts
 *
 * The database half (real roles, the real signup transaction, concurrent claims, the tenant
 * DELETE) is .te/app-battery.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

import { isValidSender, normalizeAppBaseUrl, readTransactionalEmailConfig } from "./config";
import { decideFinalization, deliverTransactionalEmail, MAX_ATTEMPTS, RETRY_DELAYS_MS, retryDelayMs, CLAIM_LEASE_MS } from "./delivery";
import { classifyHttpStatus, idempotencyKeyFor, parseRetryAfter, type EmailProvider } from "./provider";
import { EMAIL_KINDS, PROVIDER_IDEMPOTENCY_WINDOW_MS, WELCOME_TTL_MS, isEmailKind, renderStored, welcomeDedupeKey } from "./registry";
import { createResendProvider, RESEND_ENDPOINT, RESEND_TIMEOUT_MS } from "./resend";
import { runTransactionalEmailSweep } from "./sweep";
import {
  WELCOME_CTA_LABEL,
  WELCOME_LINES,
  WELCOME_SUBJECT,
  firstNameOf,
  parseWelcomePayload,
  renderWelcome,
} from "./templates/welcome";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok  - ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  - ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const ON = {
  TRANSACTIONAL_EMAIL_ENABLED: "true",
  RESEND_API_KEY: "re_synthetic_test_key",
  TRANSACTIONAL_EMAIL_FROM: "Dubiz <hello@mail.example.test>",
  TRANSACTIONAL_EMAIL_REPLY_TO: "support@example.test",
  APP_BASE_URL: "https://app.example.test",
};

/** A database that fails the test if anything touches it. */
const untouchableDb = new Proxy({}, {
  get() {
    throw new Error("the database was touched");
  },
}) as never;

/** A provider that records every call. */
function recordingProvider(result: Awaited<ReturnType<EmailProvider["send"]>> = { outcome: "sent", providerMessageId: "m1" }) {
  const calls: Parameters<EmailProvider["send"]>[0][] = [];
  const provider: EmailProvider = {
    name: "fake",
    async send(m) {
      calls.push(m);
      return result;
    },
  };
  return { provider, calls };
}

async function main() {
  // ── 1. configuration: OFF by default, fail closed ─────────────────────────────
  {
    ok("config: unset → OFF", readTransactionalEmailConfig({}).enabled === false);
    ok("config: \"false\" → OFF", readTransactionalEmailConfig({ TRANSACTIONAL_EMAIL_ENABLED: "false" }).enabled === false);
    for (const v of ["TRUE", "1", "yes", "on", "true "]) {
      const s = readTransactionalEmailConfig({ ...ON, TRANSACTIONAL_EMAIL_ENABLED: v });
      const trimmedTrue = v.trim() === "true";
      ok(`config: ${JSON.stringify(v)} → ${trimmedTrue ? "ON (trimmed)" : "OFF + reported"}`,
        trimmedTrue ? s.enabled === true : s.enabled === false && s.error === "invalid_enabled_value");
    }
    const missing = readTransactionalEmailConfig({ TRANSACTIONAL_EMAIL_ENABLED: "true" });
    ok("config: ON without settings → not configured, names every missing variable",
      missing.enabled === true && !("config" in missing) && JSON.stringify((missing as { missing: string[] }).missing) === JSON.stringify(["RESEND_API_KEY", "TRANSACTIONAL_EMAIL_FROM", "APP_BASE_URL"]));
    const full = readTransactionalEmailConfig(ON);
    ok("config: ON + complete → the configured values, none hard-coded",
      full.enabled === true && "config" in full && full.config.from === ON.TRANSACTIONAL_EMAIL_FROM && full.config.replyTo === ON.TRANSACTIONAL_EMAIL_REPLY_TO && full.config.appBaseUrl === "https://app.example.test");
    const noReply = readTransactionalEmailConfig({ ...ON, TRANSACTIONAL_EMAIL_REPLY_TO: "" });
    ok("config: reply-to is optional", noReply.enabled === true && "config" in noReply && noReply.config.replyTo === null);
    ok("config: a sender with a line break is refused (header injection)", !isValidSender("Dubiz <a@b.co>\r\nBcc: x@y.z"));
    ok("config: `Name <address>` and a bare address are accepted", isValidSender("Dubiz <hello@promax.example>") && isValidSender("hello@promax.example"));
    ok("config: APP_BASE_URL must be an https origin",
      normalizeAppBaseUrl("http://app.example.test") === null && normalizeAppBaseUrl("https://app.example.test/x") === null &&
      normalizeAppBaseUrl("https://u:p@app.example.test") === null && normalizeAppBaseUrl("https://app.example.test/") === "https://app.example.test");
    ok("config: http allowed only for localhost", normalizeAppBaseUrl("http://localhost:3000") === "http://localhost:3000");
  }

  // ── 2. registry ──────────────────────────────────────────────────────────────
  {
    ok("registry: WELCOME is the only kind", JSON.stringify(Object.keys(EMAIL_KINDS)) === JSON.stringify(["WELCOME"]));
    ok("registry: WELCOME TTL is 24h", WELCOME_TTL_MS === 24 * 3600_000 && EMAIL_KINDS.WELCOME.ttlMs === WELCOME_TTL_MS);
    ok("registry: no kind outlives the provider's 24h idempotency window",
      Object.values(EMAIL_KINDS).every((k) => k.ttlMs <= PROVIDER_IDEMPOTENCY_WINDOW_MS));
    ok("registry: every kind name satisfies the table's CHECK", Object.keys(EMAIL_KINDS).every((k) => /^[A-Z][A-Z0-9_]{1,63}$/.test(k)));
    ok("registry: the WELCOME dedupe key names the user, stably", welcomeDedupeKey(42) === "welcome:user:42" && welcomeDedupeKey(42) === welcomeDedupeKey(42));
    ok("registry: unknown kinds are not kinds", !isEmailKind("PASSWORD_RESET") && !isEmailKind("toString"));
    ok("registry: an unknown kind renders nothing", renderStored("NOPE", {}, { appBaseUrl: "https://a.test" }) === null);
  }

  // ── 3. WELCOME rendering ─────────────────────────────────────────────────────
  {
    const r = renderWelcome({ firstName: "דנה" }, { appBaseUrl: "https://app.example.test" });
    ok("welcome: the approved subject", r.subject === "ברוכים הבאים ל־Dubiz 👋" && r.subject === WELCOME_SUBJECT);
    ok("welcome: HTML is Hebrew RTL", /<html lang="he" dir="rtl">/.test(r.html) && /<body[^>]*dir="rtl"/.test(r.html));
    ok("welcome: HTML is responsive (viewport, max-width single column)", /name="viewport"/.test(r.html) && /max-width:560px/.test(r.html));
    ok("welcome: greeting by first name", r.html.includes("היי דנה,") && r.text.startsWith("היי דנה,"));
    ok("welcome: every approved line is in BOTH parts",
      [WELCOME_LINES.thanks, WELCOME_LINES.value, WELCOME_LINES.noSetup, WELCOME_LINES.signature].every((l) => r.text.includes(l) && r.html.includes(l)));
    ok("welcome: the CTA label and link (APP_BASE_URL + /login) in both parts",
      r.html.includes(`href="https://app.example.test/login"`) && r.html.includes(WELCOME_CTA_LABEL) && r.text.includes(`${WELCOME_CTA_LABEL}: https://app.example.test/login`));
    const evil = renderWelcome({ firstName: firstNameOf(`<script>x</script> "a"`) }, { appBaseUrl: "https://a.test" });
    ok("welcome: the name is escaped — no markup gets through", !/<script>/i.test(evil.html) && !evil.html.includes('"a"'));
    const anon = renderWelcome({ firstName: null }, { appBaseUrl: "https://a.test" });
    ok("welcome: no name → a greeting without one", anon.text.startsWith("היי,") && anon.html.includes("היי,"));
    ok("welcome: first name = the first word of the signup name, bounded", firstNameOf("  דנה   כהן ") === "דנה" && firstNameOf("") === null && (firstNameOf("x".repeat(200)) ?? "").length === 60);
    ok("welcome: payload contract — only firstName, a string or null",
      parseWelcomePayload({ firstName: "a" })?.firstName === "a" && parseWelcomePayload({}) !== null && parseWelcomePayload({ firstName: 3 }) === null &&
      parseWelcomePayload({ firstName: "a", invoice: 1 }) === null && parseWelcomePayload([]) === null && parseWelcomePayload("x") === null);
    ok("welcome: a stored payload that breaks the contract renders nothing (→ permanent failure)",
      renderStored("WELCOME", { firstName: "a", amount: 100 }, { appBaseUrl: "https://a.test" }) === null);
  }

  // ── 4. classification ────────────────────────────────────────────────────────
  {
    ok("classify: 2xx is success", classifyHttpStatus(200, null, null) === null);
    ok("classify: 429 retryable", classifyHttpStatus(429, "rate_limit_exceeded", 3000)?.outcome === "retryable");
    ok("classify: 429 keeps Retry-After", (classifyHttpStatus(429, null, 3000) as { retryAfterMs: number }).retryAfterMs === 3000);
    for (const s of [500, 502, 503, 504]) ok(`classify: ${s} retryable`, classifyHttpStatus(s, null, null)?.outcome === "retryable");
    for (const s of [400, 404, 405, 413, 422]) ok(`classify: ${s} permanent`, classifyHttpStatus(s, "validation_error", null)?.outcome === "permanent");
    ok("classify: 409 same key still in flight → retryable", classifyHttpStatus(409, "concurrent_idempotent_requests", null)?.outcome === "retryable");
    ok("classify: 409 same key, different payload → permanent", classifyHttpStatus(409, "invalid_idempotent_request", null)?.outcome === "permanent");
    ok("classify: 401/403 (credential) → retryable configuration error",
      classifyHttpStatus(401, null, null)?.outcome === "retryable" && classifyHttpStatus(403, null, null)?.outcome === "retryable");
    const now = new Date("2026-10-07T10:00:00Z");
    ok("classify: Retry-After seconds / date / bounded", parseRetryAfter("5", now) === 5000 &&
      parseRetryAfter("Wed, 07 Oct 2026 10:00:10 GMT", now) === 10_000 && parseRetryAfter("99999", now) === 3600_000 && parseRetryAfter("soon", now) === null);
  }

  // ── 5. the Resend adapter (fake fetch) ───────────────────────────────────────
  {
    const seen: { url: string; init: RequestInit }[] = [];
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify(body), { status, headers });
      };
    const msg = {
      idempotencyKey: idempotencyKeyFor(77),
      from: ON.TRANSACTIONAL_EMAIL_FROM,
      replyTo: ON.TRANSACTIONAL_EMAIL_REPLY_TO,
      to: "owner@example.test",
      subject: "s",
      html: "<p>h</p>",
      text: "t",
    };
    const p = createResendProvider({ apiKey: "re_k", fetchImpl: respond(200, { id: "re_msg_1" }) });
    const r = await p.send(msg);
    const h = seen[0].init.headers as Record<string, string>;
    const body = JSON.parse(String(seen[0].init.body));
    ok("resend: POST to the REST endpoint over fetch", seen[0].url === RESEND_ENDPOINT && seen[0].init.method === "POST");
    ok("resend: Idempotency-Key = te:<row id>", h["Idempotency-Key"] === "te:77");
    ok("resend: Bearer credential", h.Authorization === "Bearer re_k");
    ok("resend: from / to / reply_to / subject / html / text",
      body.from === msg.from && JSON.stringify(body.to) === JSON.stringify([msg.to]) && body.reply_to === msg.replyTo && body.subject === "s" && body.html === "<p>h</p>" && body.text === "t");
    ok("resend: bounded by a timeout signal", seen[0].init.signal instanceof AbortSignal && RESEND_TIMEOUT_MS < CLAIM_LEASE_MS);
    ok("resend: 200 → sent, with the provider id", r.outcome === "sent" && r.providerMessageId === "re_msg_1");
    await p.send(msg);
    ok("resend: the same row sends the same key on every attempt", (seen[1].init.headers as Record<string, string>)["Idempotency-Key"] === "te:77");

    const r429 = await createResendProvider({ apiKey: "k", fetchImpl: respond(429, { name: "rate_limit_exceeded" }, { "retry-after": "2" }) }).send(msg);
    ok("resend: 429 → retryable rate_limited with Retry-After", r429.outcome === "retryable" && r429.code === "rate_limited" && r429.retryAfterMs === 2000);
    const r503 = await createResendProvider({ apiKey: "k", fetchImpl: respond(503, {}) }).send(msg);
    ok("resend: 503 → retryable", r503.outcome === "retryable" && r503.code === "provider_503");
    const r422 = await createResendProvider({ apiKey: "k", fetchImpl: respond(422, { name: "validation_error", message: "owner@example.test is invalid" }) }).send(msg);
    ok("resend: 422 → permanent, and the provider message (which quotes the address) is not kept",
      r422.outcome === "permanent" && r422.code === "rejected_422" && !JSON.stringify(r422).includes("owner@"));
    const rNet = await createResendProvider({ apiKey: "k", fetchImpl: async () => { throw new TypeError("fetch failed"); } }).send(msg);
    ok("resend: network failure → retryable", rNet.outcome === "retryable" && rNet.code === "network");
    const rTimeout = await createResendProvider({
      apiKey: "k",
      fetchImpl: async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; },
    }).send(msg);
    ok("resend: timeout → retryable", rTimeout.outcome === "retryable" && rTimeout.code === "timeout");
    const rNoReply = createResendProvider({ apiKey: "k", fetchImpl: respond(200, { id: "x" }) });
    seen.length = 0;
    await rNoReply.send({ ...msg, replyTo: null });
    ok("resend: no reply-to configured → none sent", !("reply_to" in JSON.parse(String(seen[0].init.body))));
  }

  // ── 6. retry / expiry policy ─────────────────────────────────────────────────
  {
    const now = new Date("2026-10-07T10:00:00Z");
    const row = (attempts: number, hoursLeft = 23) => ({ attempts, expiresAt: new Date(now.getTime() + hoursLeft * 3600_000) });
    const retry = { outcome: "retryable" as const, code: "provider_503", retryAfterMs: null };
    ok("policy: sent → SENT", decideFinalization({ outcome: "sent", providerMessageId: "m" }, row(1), now).status === "SENT");
    ok("policy: permanent → FAILED, never retried", decideFinalization({ outcome: "permanent", code: "rejected_422" }, row(1), now).status === "FAILED");
    const f1 = decideFinalization(retry, row(1), now);
    ok("policy: 1st retryable failure → PENDING in 1 minute", f1.status === "PENDING" && f1.nextAttemptAt.getTime() - now.getTime() === 60_000);
    ok("policy: backoff grows 1m, 5m, 15m, 1h, 3h, 6h", JSON.stringify([1, 2, 3, 4, 5, 6].map((a) => retryDelayMs(a, null))) === JSON.stringify([...RETRY_DELAYS_MS]));
    ok("policy: Retry-After longer than the backoff wins", retryDelayMs(1, 10 * 60_000) === 10 * 60_000 && retryDelayMs(1, 1000) === 60_000);
    ok(`policy: the ${MAX_ATTEMPTS}th attempt failing → FAILED`, decideFinalization(retry, row(MAX_ATTEMPTS), now).status === "FAILED");
    const exp = decideFinalization(retry, row(5, 2), now);
    ok("policy: a retry that would land after the row's lifetime → EXPIRED instead", exp.status === "EXPIRED");
    ok("policy: the worst-case schedule fits inside the 24h lifetime",
      RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + MAX_ATTEMPTS * CLAIM_LEASE_MS < WELCOME_TTL_MS);
  }

  // ── 7. OFF: no database, no outbound request ─────────────────────────────────
  {
    const { provider, calls } = recordingProvider();
    const out = await deliverTransactionalEmail(1, { env: {}, db: untouchableDb, provider });
    ok("off: delivery → disabled, no DB, no provider call", out === "disabled" && calls.length === 0);
    const out2 = await deliverTransactionalEmail(1, { env: { TRANSACTIONAL_EMAIL_ENABLED: "yes" }, db: untouchableDb, provider });
    ok("off: an invalid flag value behaves as OFF", out2 === "disabled" && calls.length === 0);
    const sweep = await runTransactionalEmailSweep({ env: {}, db: untouchableDb, provider });
    ok("off: sweep → { enabled: false }, no DB, no provider call", sweep.enabled === false && calls.length === 0);
    const nc = await deliverTransactionalEmail(1, { env: { TRANSACTIONAL_EMAIL_ENABLED: "true" }, db: untouchableDb, provider });
    ok("on but unconfigured: nothing claimed, nothing sent", nc === "not_configured" && calls.length === 0);
    const lp = await deliverTransactionalEmail(1, { env: ON, db: untouchableDb, provider, authPlaneActive: () => false });
    ok("on but legacy auth plane: nothing claimed, nothing sent", lp === "auth_plane_inactive" && calls.length === 0);
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => { fetched += 1; return new Response("{}"); }) as typeof fetch;
    try {
      await deliverTransactionalEmail(1, { env: {}, db: untouchableDb });
      await runTransactionalEmailSweep({ env: {}, db: untouchableDb });
    } finally {
      globalThis.fetch = realFetch;
    }
    ok("off: the real provider path makes zero outbound requests", fetched === 0);
  }

  // ── 8. logs carry ids, statuses and codes only ───────────────────────────────
  {
    const rows = new Map<number, Record<string, unknown>>([[5, {
      id: 5, kind: "WELCOME", toEmail: "secret-owner@example.test", payload: { firstName: "סודי" },
      attempts: 0, expiresAt: new Date(Date.now() + 3600_000), status: "PENDING", nextAttemptAt: null,
    }]]);
    const db = {
      transactionalEmail: {
        async updateMany({ where, data }: { where: { id: number; status?: string; attempts?: number }; data: Record<string, unknown> }) {
          const r = rows.get(where.id);
          if (!r) return { count: 0 };
          if (data.status === "SENDING") {
            if (r.status !== "PENDING") return { count: 0 };
            r.status = "SENDING";
            r.attempts = (r.attempts as number) + 1;
            return { count: 1 };
          }
          if (r.status !== where.status || r.attempts !== where.attempts) return { count: 0 };
          Object.assign(r, data);
          return { count: 1 };
        },
        async findUnique({ where }: { where: { id: number } }) {
          return rows.get(where.id) ?? null;
        },
      },
    } as never;
    const logged: string[] = [];
    const orig = { info: console.info, error: console.error, warn: console.warn, log: console.log };
    const capture = (...a: unknown[]) => logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    console.info = capture; console.error = capture; console.warn = capture;
    const { provider } = recordingProvider({ outcome: "permanent", code: "rejected_422" });
    let out: string;
    try {
      out = await deliverTransactionalEmail(5, { env: ON, db, provider, authPlaneActive: () => true });
    } finally {
      Object.assign(console, orig);
    }
    const all = logged.join("\n");
    ok("logs: the delivery outcome is logged", out! === "failed" && /\[transactional-email\] delivery/.test(all) && all.includes("rejected_422"));
    ok("logs: no address, no name, no body", !all.includes("secret-owner") && !all.includes("סודי") && !all.includes("<html"));
  }

  // ── 9. the sweep route's authority ───────────────────────────────────────────
  {
    const route = await import("../../../app/api/transactional-email/sweep/route");
    const url = "https://app.example.test/api/transactional-email/sweep";
    const saved = { ...process.env };
    try {
      delete process.env.CRON_SECRET;
      const r1 = await route.POST(new NextRequest(url, { method: "POST", headers: { authorization: "Bearer x" } }));
      ok("route: no CRON_SECRET configured → 503, fails closed", r1.status === 503);
      process.env.CRON_SECRET = "s".repeat(48);
      const r2 = await route.POST(new NextRequest(url, { method: "POST" }));
      ok("route: no bearer → 401", r2.status === 401);
      const r3 = await route.POST(new NextRequest(url, { method: "POST", headers: { authorization: `Bearer ${"t".repeat(48)}` } }));
      ok("route: wrong bearer → 401", r3.status === 401);
      delete process.env.TRANSACTIONAL_EMAIL_ENABLED;
      const r4 = await route.POST(new NextRequest(url, { method: "POST", headers: { authorization: `Bearer ${"s".repeat(48)}` } }));
      const b4 = await r4.json();
      ok("route: authorised, flag OFF → 200 { enabled: false } (no database)", r4.status === 200 && b4.report?.enabled === false);
      process.env.TRANSACTIONAL_EMAIL_ENABLED = "true";
      delete process.env.RESEND_API_KEY;
      const r5 = await route.POST(new NextRequest(url, { method: "POST", headers: { authorization: `Bearer ${"s".repeat(48)}` } }));
      ok("route: flag ON but unconfigured → 500 (the scheduler goes red)", r5.status === 500);
      ok("route: no GET (the scheduler POSTs; nothing else may trigger it)", !("GET" in route));
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  }

  // ── 10. scope, statically: who enqueues, who delivers, who imports the auth client ─────────
  {
    const root = process.cwd();
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
        const rel = path.posix.join(d, e.name);
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(rel);
      }
    };
    walk("app");
    walk("lib");
    const code = (f: string) => fs.readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const enqueuers = files.filter((f) => /enqueue(Welcome|Transactional)Email\(/.test(code(f)) && !f.startsWith("lib/email/transactional/")).sort();
    ok("scope: only signup enqueues — login, setup, refresh and every other flow do not",
      JSON.stringify(enqueuers) === JSON.stringify(["lib/auth/signup.ts"]), JSON.stringify(enqueuers));
    const deliverers = files.filter((f) => /deliverTransactionalEmail\(|runTransactionalEmailSweep\(/.test(code(f)) && !f.startsWith("lib/email/transactional/")).sort();
    ok("scope: delivery is reached only from the register route (after the response) and the sweep route",
      JSON.stringify(deliverers) === JSON.stringify(["app/api/auth/register/route.ts", "app/api/transactional-email/sweep/route.ts"]), JSON.stringify(deliverers));
    const authImporters = files.filter((f) => f.startsWith("lib/email/") && /@\/lib\/prisma-auth/.test(code(f))).sort();
    ok("scope: in lib/email only delivery and sweep hold the auth client",
      JSON.stringify(authImporters) === JSON.stringify(["lib/email/transactional/delivery.ts", "lib/email/transactional/sweep.ts"]), JSON.stringify(authImporters));
    const tenantClient = files.filter((f) => f.startsWith("lib/email/") && /from "@\/lib\/prisma"/.test(code(f)));
    ok("scope: nothing in lib/email uses the tenant runtime client", tenantClient.length === 0, JSON.stringify(tenantClient));
    const signup = code("lib/auth/signup.ts");
    const txStart = signup.indexOf("$transaction(");
    const enq = signup.indexOf("enqueueWelcomeEmail(tx");
    const txEnd = signup.indexOf("} catch (error)");
    ok("scope: the WELCOME is enqueued INSIDE the account transaction, on its tx", txStart > 0 && enq > txStart && enq < txEnd);
    // Raw text: the comment stripper above would eat the `//` of the URL itself.
    const raw = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
    const providerHosts = files.filter((f) => /api\.resend\.com/.test(raw(f)));
    ok("scope: the provider endpoint lives in the adapter only", JSON.stringify(providerHosts) === JSON.stringify(["lib/email/transactional/resend.ts"]));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    ok("scope: no provider SDK dependency (fetch only)", !Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => /resend|nodemailer|sendgrid|mailgun|postmark/i.test(d)));
    const hardcoded = files.filter((f) => f.startsWith("lib/email/") && /promaxgroup|@promax|hello@/.test(code(f)));
    ok("scope: no sender address or domain is hard-coded", hardcoded.length === 0, JSON.stringify(hardcoded));
  }

  console.log(`\n[transactional-email] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
