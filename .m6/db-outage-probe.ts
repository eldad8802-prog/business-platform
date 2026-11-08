/**
 * Leads L1.5-b · PR-8 — child of .m6/edge-battery.ts. Runs with DATABASE_URL / DIRECT_URL pointing at a port nothing
 * listens on (the database is "down") and calls every intake route once with a well-formed delivery. Prints the
 * statuses as one JSON line. Never run against a real database: it only ever needs an unreachable one.
 */
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as webPOST } from "../app/api/intake/acquisition/web/[publicId]/route";
import { POST as googlePOST } from "../app/api/intake/acquisition/google/[publicId]/route";
import { POST as metaPOST } from "../app/api/intake/acquisition/meta/route";
import { POST as wooPOST } from "../app/api/intake/commerce/woocommerce/[publicId]/route";
import { POST as wixPOST } from "../app/api/intake/commerce/wix/route";
import { POST as cloudtalkPOST } from "../app/api/intake/telephony/cloudtalk/[publicId]/route";
import { POST as voicenterPOST } from "../app/api/intake/telephony/voicenter/[publicId]/[key]/route";

const ID = "A".repeat(32);
// The web delivery can target a REAL lab endpoint (the parent's retry check); otherwise a well-formed unknown one.
const WEB_ID = process.env.PROBE_WEB_ID || ID;
const WEB_KEY = process.env.PROBE_WEB_KEY || "dwk_probe_key_probe_key_probe";
const WEB_SUBMISSION = process.env.PROBE_WEB_SUBMISSION || "x";
// Wix verifies its JWT before anything else: a lab key pair makes the delivery valid, so it reaches the database step.
const wixKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.WIX_APP_ID = "probe-wix-app-id";
process.env.WIX_APP_SECRET = "probe-wix-app-secret";
process.env.WIX_APP_PUBLIC_KEY = wixKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
const b64u = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function wixJwt(inner: Record<string, unknown>, instanceId: string) {
  const h = b64u({ alg: "RS256", typ: "JWT" });
  const p = b64u({ data: JSON.stringify({ eventType: "wix.ecom.v1.order_updated", instanceId, data: JSON.stringify(inner) }), iat: Math.floor(Date.now() / 1000) });
  return `${h}.${p}.${createSign("RSA-SHA256").update(`${h}.${p}`).sign(wixKeys.privateKey).toString("base64url")}`;
}
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });
const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function main() {
  const out: Record<string, number> = {};
  out.web = (await webPOST(json(`http://db.down/api/intake/acquisition/web/${WEB_ID}`, { submission_id: WEB_SUBMISSION, name: "N", phone: "054-000-0000" }, { authorization: `Bearer ${WEB_KEY}` }), params({ publicId: WEB_ID }))).status;
  out.google = (await googlePOST(json(`http://db.down/api/intake/acquisition/google/${ID}`, { lead_id: "x", google_key: "probe-key-0123456789", user_column_data: [] }), params({ publicId: ID }))).status;
  const metaBody = JSON.stringify({ object: "page", entry: [{ id: "1", time: 1, changes: [{ field: "leadgen", value: { leadgen_id: "9", page_id: "1" } }] }] });
  const sig = "sha256=" + createHmac("sha256", process.env.META_LEAD_ADS_APP_SECRET!).update(metaBody, "utf8").digest("hex");
  out.meta = (await metaPOST(new NextRequest("http://db.down/api/intake/acquisition/meta", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: metaBody }))).status;
  out.woocommerce = (await wooPOST(json(`http://db.down/api/intake/commerce/woocommerce/${ID}`, { id: 1 }, { "x-wc-webhook-signature": "c2ln", "x-wc-webhook-source": "https://shop.example/" }), params({ publicId: ID }))).status;
  out.wix = (await wixPOST(new NextRequest("http://db.down/api/intake/commerce/wix", { method: "POST", headers: { "content-type": "text/plain" }, body: wixJwt({ id: "evt-probe", entityFqdn: "wix.ecom.v1.order", slug: "created", entityEventSequence: 1, createdEvent: { entity: { id: "w-probe" } } }, "probe-instance") }))).status;
  out.cloudtalk = (await cloudtalkPOST(json(`http://db.down/api/intake/telephony/cloudtalk/${ID}`, { call_id: 1 }, { "svix-id": "msg_1", "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": "v1,c2ln" }), params({ publicId: ID }))).status;
  out.voicenter = (await voicenterPOST(json(`http://db.down/api/intake/telephony/voicenter/${ID}/${"k".repeat(43)}`, { ivruniqueid: "1" }), params({ publicId: ID, key: "k".repeat(43) }))).status;
  console.log("STATUSES " + JSON.stringify(out));
}
main().then(() => process.exit(0), (e) => { console.log("PROBE_CRASH " + (e instanceof Error ? e.name : "unknown")); process.exit(1); });
