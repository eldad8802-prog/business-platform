/**
 * Auto-capture noise control — the product half of the enablement gate.
 *
 * Auto-capture can be technically perfect and still ruin the product: if every
 * inbound message becomes a fire, the owner stops trusting the screen that was
 * supposed to tell them what matters. This builds a MIXED set of situations in
 * one tenant and checks that the queue still discriminates between them, that
 * Attention holds one item per real thing, and that Home's count is exact.
 *
 * Runs against a QA runtime with auto-capture ON. Never Production.
 *
 *   NOISE_BASE=http://localhost:3311 node scripts/qa/leads-autocapture-noise.mjs
 */
const BASE = (process.env.NOISE_BASE || "").trim().replace(/\/+$/, "");
if (!BASE || /promaxgroup/i.test(BASE)) {
  console.error("REFUSING TO RUN — set NOISE_BASE to an isolated runtime, never Production.");
  process.exit(2);
}

const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const TAG = `QA-NOISE-${STAMP}`;
let passed = 0;
const failures = [];
const ok = (l) => { passed += 1; console.log(`  ok  ${l}`); };
const bad = (l, d) => { failures.push(`${l} — ${d}`); console.log(`  FAIL  ${l} — ${d}`); };
const check = (c, l, d = "") => (c ? ok(l) : bad(l, d));
const note = (l) => console.log(`  ..  ${l}`);

const ref = { token: null };
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(ref.token ? { Authorization: `Bearer ${ref.token}` } : {}),
      ...(init.headers || {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
};

const email = `qa-noise-${STAMP}@example.test`;
const password = `Qa!${STAMP}!n`;

const send = (conversationId, customerId, over = {}) =>
  api("/api/message", {
    method: "POST",
    body: JSON.stringify({
      conversationId, customerId, channel: "WHATSAPP", messageType: "TEXT",
      direction: "INBOUND", senderType: "CUSTOMER", contentText: "שלום, אשמח לפרטים",
      ...over,
    }),
  });

async function scenario(label, suffix, steps) {
  const c = await api("/api/customers", {
    method: "POST",
    body: JSON.stringify({ name: `${TAG} ${label}`, phone: `05${STAMP.slice(-7)}${suffix}` }),
  });
  const customerId = c.body?.customer?.id;
  const conv = await api("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ customerId, channel: "WHATSAPP" }),
  });
  const conversationId = conv.body?.conversation?.id;
  for (const step of steps) await send(conversationId, customerId, step);
  return { label, customerId, conversationId };
}

async function main() {
  console.log(`\nAuto-capture noise control\n  base: ${BASE}\n  tag:  ${TAG}\n`);

  const reg = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name: "QA Noise", businessName: TAG }),
  });
  if (![200, 201].includes(reg.status)) {
    console.error(`register failed: ${reg.status} ${JSON.stringify(reg.body).slice(0, 140)}`);
    process.exit(2);
  }
  const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  ref.token = login.body?.token ?? null;

  // A deliberately MIXED world — the situations an owner really has at once.
  const waiting = await scenario("ממתין", "1", [{}, { contentText: "עוד שאלה" }]);
  const answered = await scenario("נענה", "2", [
    {},
    { direction: "OUTBOUND", senderType: "BUSINESS_USER", contentText: "שלום! נשמח לעזור" },
  ]);
  const hot = await scenario("חם", "3", [
    { contentText: "כמה עולה? אני רוצה להזמין" },
    { direction: "OUTBOUND", senderType: "BUSINESS_USER", contentText: 'המחיר 450 ש"ח' },
    { contentText: "מעולה, בוא נתקדם" },
    { direction: "OUTBOUND", senderType: "BUSINESS_USER", contentText: "שולח פרטים" },
  ]);
  const quiet = await api("/api/leads", {
    method: "POST",
    body: JSON.stringify({ name: `${TAG} שקט`, phone: `05${STAMP.slice(-7)}4` }),
  });

  const leads = (await api("/api/leads?status=all")).body?.leads ?? [];
  check(leads.length === 4, "M1 four situations produced exactly four leads — no inflation", `got ${leads.length}`);

  const byName = (n) => leads.find((l) => (l.name ?? "").includes(n));
  const w = byName("ממתין"), a = byName("נענה"), h = byName("חם"), q = byName("שקט");

  check(w != null && a != null && h != null && q != null, "M2 each situation is exactly one lead");

  // Discrimination: the queue must not treat them all the same.
  check(
    (w?.priority?.score ?? 0) > (a?.priority?.score ?? 0),
    "M3 a waiting customer outranks one the owner already answered",
    `${w?.priority?.score} vs ${a?.priority?.score}`
  );
  check(
    (w?.priority?.score ?? 0) > (q?.priority?.score ?? 0),
    "M4 and outranks a quiet manual lead",
    `${w?.priority?.score} vs ${q?.priority?.score}`
  );
  check((q?.priority?.score ?? 0) === 0, "M5 the quiet lead asks for nothing (score 0)", `${q?.priority?.score}`);
  check(
    (a?.priority?.score ?? 0) < 70,
    "M6 an answered conversation is not an emergency",
    `${a?.priority?.score} (${a?.priority?.reason})`
  );
  note(`scores — waiting=${w?.priority?.score} answered=${a?.priority?.score} hot=${h?.priority?.score} quiet=${q?.priority?.score}`);
  note(`reasons — waiting=${w?.priority?.reason} answered=${a?.priority?.reason} hot=${h?.priority?.reason}`);

  // No double counting: one lead carries several contributing reasons but is
  // still ONE row with ONE score.
  const multi = leads.filter((l) => (l.priority?.contributing?.length ?? 0) > 1);
  check(
    multi.every((l) => typeof l.priority.score === "number" && l.priority.score <= 95),
    "M7 a lead with several reasons still has ONE bounded score, not a sum",
    JSON.stringify(multi.map((l) => [l.priority.score, l.priority.contributing]))
  );

  // Attention: one item per real thing.
  const attention = await api("/api/inbox/attention");
  check(attention.status === 200, "M8 the attention feed answers", `status=${attention.status}`);
  const items = attention.body?.items ?? attention.body?.attention ?? [];
  const ids = items.map((i) => i.itemId ?? i.id).filter(Boolean);
  check(new Set(ids).size === ids.length, "M9 no duplicate attention item", `${ids.length} items, ${new Set(ids).size} unique`);
  note(`attention items: ${ids.length}`);

  // Home: the count must match what Attention actually holds for leads.
  const home = await api("/api/home");
  const homeCount = home.body?.leadsAttention?.count ?? null;
  const needing = leads.filter((l) => l.needsAttention).length;
  check(home.status === 200, "M10 Home answers", `status=${home.status}`);
  check(
    homeCount === needing,
    "M11 the Home count equals the leads that actually need attention",
    `home=${homeCount} leads=${needing}`
  );

  const erase = await api("/api/account", { method: "DELETE" });
  check([200, 202, 204].includes(erase.status), "Z1 QA tenant erased", `status=${erase.status}`);

  console.log(
    failures.length === 0
      ? `\nNOISE CONTROL PASS — ${passed} checks green.\n`
      : `\nNOISE CONTROL FAIL — ${failures.length} failed of ${passed + failures.length}:\n` +
          failures.map((f) => `  - ${f}`).join("\n") + "\n"
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nHARNESS ERROR:", e?.message || e);
  process.exit(2);
});
