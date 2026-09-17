/**
 * T5 Gate 0 — while the feature is off, the management surface must not exist.
 *
 * # Why this is its own file
 *
 * The T4 suite reads source text. This one RUNS the exported route handlers,
 * which means importing Next route modules, and it does so with `DATABASE_URL`
 * removed from the environment on purpose: if any path reached a database, a
 * session or a rate limiter, it would throw instead of answering, and the throw
 * is the finding. Keeping that in a separate file keeps the T4 suite pure.
 *
 * # What was actually wrong
 *
 * T4's guard was reached only inside each action branch, and the POST routes
 * have to read the body before they know which branch to take. So a request
 * naming no known action fell through to a 400 while the feature was off.
 * Nothing was reachable — no query ran, no session was read — but 400 is still
 * an answer, and it separates a deployed-and-disabled surface from one that was
 * never shipped. Access was closed; existence was not.
 *
 *   npx tsx lib/services/inbound-email/inbound-email-feature-gate.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const ROUTES = [
  "app/api/inbound-email/settings/route.ts",
  "app/api/inbound-email/address/route.ts",
  "app/api/inbound-email/senders/route.ts",
];

let passed = 0;
let failed = 0;
const failures: string[] = [];
async function check(what: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${what}`);
  } catch (error) {
    failed += 1;
    failures.push(what);
    console.log(`  FAIL  ${what}`);
    console.log(`        ${(error as Error).message.split("\n")[0]}`);
  }
}

console.log("\nT5 Gate 0 — feature-off indistinguishability\n");

async function main() {
  // ── structural ────────────────────────────────────────────────────────────
  await check("the gate is the first thing every handler does", () => {
    for (const rel of ROUTES) {
      const s = src(rel);
      const m = s.match(/export async function (GET|POST)\([^)]*\)\s*\{/);
      assert.ok(m, `${rel} exports no handler`);
      const after = s.slice(s.indexOf(m![0]) + m![0].length);
      // Everything up to the first statement that is not a comment or blank.
      const first = after
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("//"))[0];
      assert.equal(
        first,
        "const off = inboundManagementDisabled();",
        `${rel} does something before the feature gate: ${first}`
      );
    }
  });

  await check("the gate does no I/O — it cannot, by its own signature", () => {
    const guard = src("lib/services/inbound-email/inbound-email-management-guard.ts");
    const start = guard.indexOf("export function inboundManagementDisabled(");
    assert.ok(start > -1, "the gate is gone");
    const body = guard.slice(start, guard.indexOf("\n}", start));
    // A parameterless, synchronous function cannot read a session, a body or a
    // database: there is nothing to read them from and no way to await them.
    assert.ok(/inboundManagementDisabled\(\): NextResponse \| null/.test(body), "the gate takes arguments or is async");
    for (const forbidden of ["await", "prisma", "getCurrentUser", "consumeRateLimit", "req"]) {
      assert.ok(!body.includes(forbidden), `the gate touches ${forbidden}`);
    }
  });

  await check("no route parses a body before the gate", () => {
    for (const rel of ROUTES) {
      const s = src(rel);
      const gate = s.indexOf("inboundManagementDisabled()");
      const parse = s.indexOf("req.json()");
      assert.ok(gate > -1, `${rel} never calls the gate`);
      if (parse > -1) assert.ok(gate < parse, `${rel} reads the body before the gate`);
    }
  });

  // ── executed ──────────────────────────────────────────────────────────────
  delete process.env.INBOUND_EMAIL_ENABLED;
  delete process.env.DATABASE_URL;
  delete process.env.DIRECT_URL;

  const settings = await import("@/app/api/inbound-email/settings/route");
  const address = await import("@/app/api/inbound-email/address/route");
  const senders = await import("@/app/api/inbound-email/senders/route");

  const url = "https://example.invalid/api/inbound-email/x";
  const post = (raw: string) =>
    new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });

  const shapes: Array<[string, () => Promise<Response>]> = [
    ["GET /settings", () => settings.GET(new Request(url))],
    ...(["initialize", "rotate", "revoke"] as const).map(
      (a) =>
        [`/address ${a}`, () => address.POST(post(JSON.stringify({ action: a, addressId: 1 })))] as [
          string,
          () => Promise<Response>,
        ]
    ),
    ...(["add", "revoke"] as const).map(
      (a) =>
        [
          `/senders ${a}`,
          () => senders.POST(post(JSON.stringify({ action: a, email: "a@b.invalid", senderId: 1 }))),
        ] as [string, () => Promise<Response>]
    ),
    ["/address unknown action", () => address.POST(post('{"action":"bogus"}'))],
    ["/senders unknown action", () => senders.POST(post('{"action":"bogus"}'))],
    ["/address empty object", () => address.POST(post("{}"))],
    ["/senders empty object", () => senders.POST(post("{}"))],
    ["/address not json", () => address.POST(post("<<<not json>>>"))],
    ["/senders null body", () => senders.POST(post("null"))],
    ["/address numeric action", () => address.POST(post('{"action":42}'))],
    ["/senders object action", () => senders.POST(post('{"action":{"x":1}}'))],
    ["/address 5KB action", () => address.POST(post(JSON.stringify({ action: "z".repeat(5000) })))],
    ["/senders add without email", () => senders.POST(post('{"action":"add"}'))],
    ["/address revoke without id", () => address.POST(post('{"action":"revoke"}'))],
  ];

  const answers = new Set<string>();
  const threw: string[] = [];
  for (const [label, run] of shapes) {
    try {
      const res = await run();
      answers.add(`${res.status} ${await res.text()}`);
    } catch (error) {
      threw.push(`${label}: ${(error as Error).message.slice(0, 60)}`);
    }
  }

  await check(`every request shape answers identically while off (${shapes.length} shapes)`, () => {
    assert.equal(threw.length, 0, `a handler threw, so it attempted I/O: ${threw[0]}`);
    assert.equal(answers.size, 1, `distinct answers: ${[...answers].join(" | ")}`);
    assert.ok([...answers][0].startsWith("404"), `the shared answer is not 404: ${[...answers][0]}`);
  });

  await check("nothing reached a database — there was none to reach", () => {
    // The assertion above already proves it: every handler answered, and none
    // threw, with DATABASE_URL absent. A path that queried would have failed to
    // construct a client. This check states the conclusion so it is not lost.
    assert.equal(process.env.DATABASE_URL, undefined, "the proof ran with a database configured");
    assert.equal(threw.length, 0, "a handler threw");
  });

  // ── the other direction: ON must be exactly as strict as before ───────────
  await check("turning the feature on does not weaken validation", async () => {
    process.env.INBOUND_EMAIL_ENABLED = "true";
    const unknown = await address.POST(post('{"action":"bogus"}'));
    assert.equal(unknown.status, 400, "an unknown action stopped being a 400 when enabled");
    const known = await address.POST(post('{"action":"rotate"}'));
    assert.equal(known.status, 401, "a known action stopped requiring a session");
    delete process.env.INBOUND_EMAIL_ENABLED;
  });

  await check('only the literal string "true" enables it', () => {
    const guard = src("lib/services/inbound-email/inbound-email-management-guard.ts");
    assert.ok(guard.includes("isInboundEmailEnabled()"), "the gate stopped consulting the flag");
    const flag = src("lib/inbound-email/inbound-email-flag.ts");
    assert.ok(
      /INBOUND_EMAIL_ENABLED === "true"/.test(flag),
      "the flag stopped requiring the exact string true"
    );
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) console.log(`  failing: ${failures.join(" | ")}`);
  console.log("");
  process.exit(failed === 0 ? 0 : 1);
}

void main();
