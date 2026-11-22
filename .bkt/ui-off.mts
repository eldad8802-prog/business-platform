/**
 * "מעבר לעוסק מורשה" with BUSINESS_KIND_TRANSITION_ENABLED unset (the Production default), against `next dev` on the
 * lab database: the business screen is exactly as before (no entry), the flow page says it is not available, and every
 * API route answers 404 even to a signed-in owner with a valid session — including a direct POST.
 *
 *   F1  /business: the screen sends NO request to the transition API (the layout passes the server flag); no entry row,
 *       no "שם או מספר שגוי?" line
 *   F2  the flow page: "האפשרות לא זמינה כרגע"
 *   F3  GET / preview / reauth password / reauth Google / confirm → 404 (valid session token): a stale or forged client
 *       that calls the API anyway is still refused on the server
 *   F4  the database: nothing written
 *
 * env: E2E_BASE, OWNER_URL, AUTH_TOKEN_SECRET.
 */
import { createHash, randomBytes } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { chromium } from "playwright";

import { signAuthToken } from "../lib/auth-token";

const BASE = process.env.E2E_BASE ?? "http://localhost:3797";
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
type Rows = Record<string, unknown>[];
let pass = 0;
const failures: string[] = [];
const ok = (n: string, c: boolean, d = "") => { if (c) { pass++; console.log(`  [PASS] ${n}`); } else { failures.push(n); console.log(`  [FAIL] ${n} ${d}`); } };

(async () => {
  const u = (await owner.$queryRawUnsafe(
    `SELECT u.id, u."businessId" b FROM "User" u JOIN "BusinessProfile" p ON p."businessId" = u."businessId"
      WHERE p."billingBusinessKind" = 'EXEMPT_DEALER' AND (SELECT count(*) FROM "User" x WHERE x."businessId" = u."businessId") = 1
      ORDER BY u.id DESC LIMIT 1`)) as Rows;
  const uid = Number(u[0].id);
  const bid = Number(u[0].b);
  const s = (await owner.$queryRawUnsafe(
    `INSERT INTO "AuthSession" ("userId","secretHash","tokenVersionAtIssue","createdAt","lastUsedAt","idleExpiresAt","absoluteExpiresAt")
     VALUES ($1,$2,0,now(),now(),now()+interval '1 day',now()+interval '30 days') RETURNING id`, uid, createHash("sha256").update(randomBytes(32)).digest("hex"))) as Rows;
  const token = signAuthToken(uid, 0, String(s[0].id));
  const before = JSON.stringify(await owner.$queryRawUnsafe(`SELECT * FROM "BusinessKindTransition" WHERE "businessId" = $1`, bid));

  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(([t]) => localStorage.setItem("token", t as string), [token]);
  const p = await ctx.newPage();
  // Count every request to the transition API while the business screen loads. The screen is loaded once its own
  // profile call answered and the network went quiet; then a few seconds more, so "no request" cannot mean "not yet".
  const ktCalls: string[] = [];
  p.on("request", (r) => { if (r.url().includes("/api/business/legal-identity/kind-transition")) ktCalls.push(`${r.method()} ${r.url()}`); });
  const profile = p.waitForResponse((r) => r.url().includes("/api/billing/invoice-profile") && r.request().method() === "GET", { timeout: 120_000 });
  await p.goto(`${BASE}/business`);
  const profileStatus = (await profile).status();
  await p.waitForLoadState("networkidle").catch(() => undefined);
  await p.waitForTimeout(4000);
  ok("F1 /business (flag off): the screen loaded and sent NO request to the transition API; no entry row, no help line",
    profileStatus === 200 && ktCalls.length === 0 && (await p.getByTestId("kt-entry").count()) === 0 && (await p.getByText("שם או מספר שגוי?").count()) === 0,
    `profile=${profileStatus} calls=${ktCalls.join(" | ")}`);
  await p.goto(`${BASE}/business/legal-identity/kind-transition`);
  ok("F2 the flow page says it is not available", await p.getByText("האפשרות לא זמינה כרגע").waitFor({ timeout: 60_000 }).then(() => true).catch(() => false));
  await br.close();

  const api = `${BASE}/api/business/legal-identity/kind-transition`;
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const body = JSON.stringify({ confirmTaxId: "000000018", vatNumber: "000000018", statusEffectiveDate: "2026-11-01", acknowledged: [], statementSha256: "0".repeat(64) });
  const codes = [
    (await fetch(api, { headers: h })).status,
    (await fetch(`${api}/preview`, { method: "POST", headers: h, body })).status,
    (await fetch(`${api}/reauth/password`, { method: "POST", headers: h, body: JSON.stringify({ password: "x" }) })).status,
    (await fetch(`${api}/reauth/google`, { method: "POST", headers: h, body: "{}" })).status,
    (await fetch(api, { method: "POST", headers: h, body })).status,
  ];
  ok("F3 every API route answers 404 to a signed-in owner (incl. a direct POST)", codes.every((c) => c === 404), codes.join(","));
  const after = JSON.stringify(await owner.$queryRawUnsafe(`SELECT * FROM "BusinessKindTransition" WHERE "businessId" = $1`, bid));
  ok("F4 nothing written", before === after);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  await owner.$disconnect();
})();
