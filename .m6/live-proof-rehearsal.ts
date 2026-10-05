/**
 * M6 — rehearsal of the Website LIVE PROOF on PostgreSQL 17 (Production RLS, NOBYPASSRLS runtime),
 * so ops/evidence/m6-website-live-proof-evidence.sql is proven BEFORE it is ever run in Production.
 *
 *   npx tsx .m6/live-proof-rehearsal.ts enable   one business X gets acquisition_web_forms (the owner-run
 *                                                platform override); Y exists and stays OFF; X's owner
 *                                                connects the site through the real owner API
 *   npx tsx .m6/live-proof-rehearsal.ts submit   one enquiry through the real website route as a plain
 *                                                HTML form (browser mode, the site's own origin), then the
 *                                                SAME enquiry resubmitted (back + resubmit)
 *   npx tsx .m6/live-proof-rehearsal.ts widen    Y is enabled too — the "one business only" check must fail
 *
 * Synthetic lab data only. Never pointed at Production.
 * env: DATABASE_URL / DIRECT_URL = runtime, OWNER_URL = owner, AUTH_TOKEN_SECRET.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { signAuthToken } from "../lib/auth-token";
import { POST as webPOST } from "../app/api/intake/acquisition/web/[publicId]/route";
import { POST as ownerPOST } from "../app/api/integrations/acquisition/route";

const STATE = "/tmp/m6-live-proof-rehearsal.json";
const o = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const fail = (m: string): never => {
  console.error(`REHEARSAL FAIL: ${m}`);
  process.exit(1);
};

async function enable() {
  const X = await o.business.create({ data: { name: "rehearsal-clinic-x" } });
  const Y = await o.business.create({ data: { name: "rehearsal-shop-y" } });
  const owner = await o.user.create({ data: { email: "owner-x@rehearsal.test", password: "x", businessId: X.id, role: "USER" } });
  // The platform-admin feature override, for X only (in Production: the owner-run admin action).
  await o.businessFeatureAccess.create({ data: { businessId: X.id, featureKey: "acquisition_web_forms", state: "ENABLED" } });
  const res = await ownerPOST(new NextRequest("http://lab.local/api/integrations/acquisition", {
    method: "POST",
    headers: { authorization: `Bearer ${signAuthToken(owner.id)}`, "content-type": "application/json" },
    body: JSON.stringify({ sourceKey: "web.form", allowedOrigins: ["https://clinic-x.example"] }),
  }));
  const body = (await res.json()) as { connection?: { publicId?: string; endpointUrl?: string } };
  if (res.status !== 201 || !body.connection?.publicId) fail(`owner connect → ${res.status}`);
  writeFileSync(STATE, JSON.stringify({ X: X.id, Y: Y.id, publicId: body.connection!.publicId }));
  console.log(`enabled: X only; connected through the owner API (endpoint ${String(body.connection!.endpointUrl).replace(/[^/]+$/, "<id>")})`);
}

async function submit() {
  if (!existsSync(STATE)) fail("run `enable` first");
  const { publicId } = JSON.parse(readFileSync(STATE, "utf8")) as { publicId: string };
  const form = {
    name: "Rehearsal Visitor",
    phone: "052-000-1111",
    email: "visitor@rehearsal.test",
    message: "Is there an appointment this week?",
    _hp: "",
    page_url: "https://www.clinic-x.example/contact?utm_source=google&utm_medium=cpc&utm_campaign=autumn",
  };
  const post = () =>
    webPOST(new NextRequest(`http://lab.local/api/intake/acquisition/web/${publicId}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
        origin: "https://www.clinic-x.example",
        referer: "https://www.clinic-x.example/contact",
        "x-forwarded-for": "198.51.100.23",
      },
      body: new URLSearchParams(form).toString(),
    }), { params: Promise.resolve({ publicId }) });
  const first = await post();
  const again = await post(); // the visitor goes back and submits the same enquiry again
  if (first.status !== 200 || again.status !== 200) fail(`form posts → ${first.status}, ${again.status}`);
  console.log("submitted: one enquiry + the same enquiry again (plain HTML form, the site's www origin)");
}

async function widen() {
  if (!existsSync(STATE)) fail("run `enable` first");
  const { Y } = JSON.parse(readFileSync(STATE, "utf8")) as { Y: number };
  await o.businessFeatureAccess.create({ data: { businessId: Y, featureKey: "acquisition_web_forms", state: "ENABLED" } });
  console.log("widened: a second business is enabled");
}

const phase = process.argv[2];
const run = phase === "enable" ? enable : phase === "submit" ? submit : phase === "widen" ? widen : null;
if (!run) fail("phase must be enable | submit | widen");
run!().catch((e) => fail(e instanceof Error ? e.message : String(e))).finally(() => o.$disconnect());
