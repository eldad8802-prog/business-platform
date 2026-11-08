/**
 * Leads L1.5-b · PR-8 — edge cases not covered by the other batteries.
 *
 *   DB outage: with the database unreachable, every intake route of the seven sources (web, Google, Meta, WooCommerce,
 *   Wix, CloudTalk, Voicenter) answers 503 — a retryable, visible failure — and never a silent 2xx. (Whether the
 *   provider retries is the provider's: see the readiness table. A browser form shows the visitor an error, never a
 *   false "sent".) Run in a child process whose DATABASE_URL points at a port nothing listens on; the lab database is
 *   never touched by it.
 *
 *   503 then retry: a delivery refused during the outage left nothing behind; the provider's retry once the database
 *   is back is recorded once, and a second retry of the same delivery is a duplicate — never a second receipt.
 *
 * The rest of the edge matrix lives where it is exercised for real: signatures / duplicates / retry / worker crash /
 * pause / resume / emergency / RLS / entitlement in the M6, M7-A, M7-B/C batteries; loads and racing sweepers in the
 * fair-queue, release and capacity batteries; owner visibility and notifications (no payload, no duplicates) in the
 * owner-status and notifications batteries; expiry in the expiry battery.
 */
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { runWithTenantContext } from "../lib/tenant/context";
import { createKeyedConnection } from "../lib/intake/acquisition/connection.service";
import { POST as webPOST } from "../app/api/intake/acquisition/web/[publicId]/route";

const SOURCES = ["web", "google", "meta", "woocommerce", "wix", "cloudtalk", "voicenter"] as const;
const RUN = `edge-${Date.now()}`;
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const o = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

function probe(extra: Record<string, string> = {}) {
  const down = "postgresql://app_runtime:x@127.0.0.1:1/none?connect_timeout=2";
  const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", ".m6/db-outage-probe.ts"], {
    env: { ...process.env, ...extra, DATABASE_URL: down, DIRECT_URL: down },
    encoding: "utf8",
    timeout: 240_000,
    shell: process.platform === "win32",
  });
  const line = `${r.stdout}`.split("\n").find((l) => l.startsWith("STATUSES "));
  return { statuses: line ? (JSON.parse(line.slice("STATUSES ".length)) as Record<string, number>) : null, tail: `${r.stdout}`.slice(-400) + `${r.stderr}`.slice(-400) };
}

async function main() {
  // A real lab web endpoint: the outage delivery targets it, then the retries run against the live lab database.
  const B = await o.business.create({ data: { name: `${RUN}-retry` } });
  await o.businessFeatureAccess.create({ data: { businessId: B.id, featureKey: "acquisition_web_forms", state: "ENABLED" } });
  const w = await runWithTenantContext({ businessId: B.id }, () => createKeyedConnection({ businessId: B.id, userId: null, sourceKey: "web.form", allowedOrigins: [] }));
  const submission = `${RUN}-s1`;

  console.log("\n-- DB outage: every intake route of the seven sources answers 503, never a silent 2xx --");
  const { statuses, tail } = probe({ PROBE_WEB_ID: w.connection.publicId, PROBE_WEB_KEY: w.key, PROBE_WEB_SUBMISSION: submission });
  ok("the probe ran against an unreachable database", !!statuses, tail);
  for (const source of SOURCES) {
    ok(`DB outage: ${source} → 503 (retryable, nothing claimed as received)`, statuses?.[source] === 503, JSON.stringify(statuses));
  }

  console.log("\n-- 503 then retry: recorded once --");
  const receipts = () => o.intakeEvent.count({ where: { businessId: B.id } });
  ok("the refused delivery left nothing behind", (await receipts()) === 0);
  const send = () => webPOST(new NextRequest(`http://edge.local/api/intake/acquisition/web/${w.connection.publicId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${w.key}`, "x-forwarded-for": "203.0.113.77" },
    body: JSON.stringify({ submission_id: submission, name: "Edge Retry", phone: "054-600-9001" }),
  }), { params: Promise.resolve({ publicId: w.connection.publicId }) });
  const first = await send();
  ok(`the retry once the database is back is accepted (${first.status})`, first.status >= 200 && first.status < 300);
  ok("…and recorded exactly once", (await receipts()) === 1);
  const second = await send();
  ok(`a second retry of the same delivery is acknowledged (${second.status}) without a second receipt`, second.status >= 200 && second.status < 300 && (await receipts()) === 1);

  console.log(`\nL1.5-b edge battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await o.$disconnect(); });
