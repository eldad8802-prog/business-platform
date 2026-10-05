/**
 * QStash lab — the scheduler's real behaviour against Upstash's official local QStash server
 * (`npx @upstash/qstash-cli dev`, published development credentials, in-memory). No database, no
 * Production, no real Upstash account.
 *
 *   1. CADENCE    a real schedule (`* * * * *`, the dev server's finest grain) delivers repeatedly; every
 *                 delivery's Upstash-Signature is verified by the SAME Receiver configuration Production
 *                 uses (explicit keys, devMode off, exact URL, raw body); the gaps are measured.
 *   2. RETRY      a destination that answers 500 twice, then 200, is retried until it succeeds.
 *   3. DLQ        a destination that always answers 500 lands in the dead-letter queue after its retries.
 *   4. BINDING    a real QStash-signed request to our actual /api/intake/sweep handler is REFUSED (401):
 *                 its signature names the lab URL, not the Production sweep URL.
 *
 * env: QSTASH_DEV_URL (default http://127.0.0.1:8080). Run: npx tsx .m6/qstash-lab.ts
 */
import http from "node:http";
import { Client, Receiver } from "@upstash/qstash";
import { NextRequest } from "next/server";

// Upstash's published development credentials (also shipped inside @upstash/qstash) — lab only.
const DEV = {
  token: "eyJVc2VySUQiOiJkZWZhdWx0VXNlciIsIlBhc3N3b3JkIjoiZGVmYXVsdFBhc3N3b3JkIn0=",
  current: "sig_7kYjw48mhY7kAjqNGcy6cr29RJ6r",
  next: "sig_5ZB6DVzB1wjE8S6rZ7eenA8Pdnhs",
};
process.env.QSTASH_CURRENT_SIGNING_KEY = DEV.current;
process.env.QSTASH_NEXT_SIGNING_KEY = DEV.next;

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const qstash = new Client({ baseUrl: process.env.QSTASH_DEV_URL ?? "http://127.0.0.1:8080", token: DEV.token });
const receiver = new Receiver({ currentSigningKey: DEV.current, nextSigningKey: DEV.next, devMode: false });

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${!cond && detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await sleep(500);
  return cond();
}

const ticks: { at: number; verified: boolean }[] = [];
let flakyAttempts = 0;
let deadAttempts = 0;
const sweepAnswers: { status: number; error?: string }[] = [];

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const signature = String(req.headers["upstash-signature"] ?? "");
  const path = (req.url ?? "").split("?")[0];
  if (path === "/lab/tick") {
    const verified = await receiver.verify({ signature, body, url: `${BASE}/lab/tick`, clockTolerance: 5 }).then(() => true, () => false);
    ticks.push({ at: Date.now(), verified });
    res.writeHead(verified ? 200 : 401).end();
  } else if (path === "/lab/flaky") {
    flakyAttempts++;
    res.writeHead(flakyAttempts <= 2 ? 500 : 200).end();
  } else if (path === "/lab/dead") {
    deadAttempts++;
    res.writeHead(500).end();
  } else if (path === "/api/intake/sweep") {
    // The REAL route handler, behind the lab URL: a genuine QStash signature for a different destination.
    const { POST } = await import("../app/api/intake/sweep/route");
    const r = await POST(new NextRequest(`${BASE}/api/intake/sweep`, { method: "POST", headers: { "upstash-signature": signature }, body }));
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    sweepAnswers.push({ status: r.status, error: j.error });
    res.writeHead(r.status).end();
  } else {
    res.writeHead(404).end();
  }
});

async function main() {
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

  console.log("\n-- 1. cadence: a real schedule, every delivery signature-verified --");
  const sched = await qstash.schedules.create({ destination: `${BASE}/lab/tick`, cron: "* * * * *", retries: 0 });
  await until(() => ticks.length >= 3, 200_000);
  await qstash.schedules.delete(sched.scheduleId);
  const gaps = ticks.slice(1).map((t, i) => Math.round((t.at - ticks[i].at) / 1000));
  ok("at least 3 scheduled deliveries arrived", ticks.length >= 3, String(ticks.length));
  ok("every delivery carried a signature the production Receiver configuration verifies", ticks.length > 0 && ticks.every((t) => t.verified));
  ok("the gaps match the cron (60 s, ±15 s)", gaps.length >= 2 && gaps.every((g) => g >= 45 && g <= 75), JSON.stringify(gaps));
  console.log(`    deliveries: ${ticks.length}, gaps (s): ${JSON.stringify(gaps)}`);

  console.log("\n-- 2. retry: non-2xx is retried until it succeeds --");
  await qstash.publish({ url: `${BASE}/lab/flaky`, body: "", retries: 3, retryDelay: "1000" });
  await until(() => flakyAttempts >= 3, 60_000);
  await sleep(3_000);
  ok("500, 500, then 200: delivered on the 3rd attempt and not retried after success", flakyAttempts === 3, String(flakyAttempts));

  console.log("\n-- 3. dead letter: retries exhausted → DLQ --");
  await qstash.publish({ url: `${BASE}/lab/dead`, body: "", retries: 2, retryDelay: "1000" });
  await until(() => deadAttempts >= 3, 60_000);
  let inDlq = false;
  for (let i = 0; i < 20 && !inDlq; i++) {
    const page = await qstash.dlq.listMessages();
    inDlq = (page.messages ?? []).some((m: { url?: string }) => m.url === `${BASE}/lab/dead`);
    if (!inDlq) await sleep(1_000);
  }
  ok("1 attempt + 2 retries, then the message is in the dead-letter queue", deadAttempts === 3 && inDlq, JSON.stringify({ deadAttempts, inDlq }));

  console.log("\n-- 4. binding: a real QStash-signed request for another URL is refused by the real sweep route --");
  await qstash.publish({ url: `${BASE}/api/intake/sweep`, body: "", retries: 0 });
  await until(() => sweepAnswers.length >= 1, 30_000);
  ok("the actual /api/intake/sweep handler answered 401 invalid_signature (signed for the lab URL, not Production)",
    sweepAnswers.length >= 1 && sweepAnswers.every((a) => a.status === 401 && a.error === "invalid_signature"), JSON.stringify(sweepAnswers));

  server.close();
  console.log(`\nQStash lab: ${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
