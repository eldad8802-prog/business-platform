/**
 * Home history — the pure contract (no database):
 *   npx tsx lib/services/home/home-history-model.test.ts
 *
 * The SQL itself is proven against a real PostgreSQL in the auth-plane write
 * battery (.authfix/auth-plane-write-battery.ts, section 8).
 */
import { readFileSync } from "node:fs";

import {
  HOME_HISTORY_FLAGS,
  parseHomeHistory,
  showsFirstTime,
  whatsAppAction,
  whatsAppHomeState,
  type HomeHistory,
} from "./home-history-model";

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const none: HomeHistory = {
  income: false,
  expenses: false,
  obligations: false,
  collection: false,
  documents: false,
  leads: false,
  conversations: false,
  inventory: false,
  insights: false,
  identityDescription: false,
  whatsapp: "NEVER",
};
const all: HomeHistory = { ...none, ...Object.fromEntries(HOME_HISTORY_FLAGS.map((f) => [f, true])), whatsapp: "CONNECTED" };

// The decision rule: first-time only when history KNOWS there was nothing AND the card has nothing.
ok("no history + no rows → first-time", showsFirstTime(none, "leads", false) === true);
ok("history + 0 today → normal card (never first-time)", showsFirstTime(all, "income", false) === false);
ok("rows win over a stale 'no history' flag (cache lag)", showsFirstTime(none, "documents", true) === false);
ok("history unknown (loading/failed) → ordinary empty line", showsFirstTime(null, "collection", false) === false);

// WhatsApp: the action follows the connection's real semantics.
ok("no row → never connected", whatsAppHomeState(null) === "NEVER" && whatsAppAction("NEVER")?.label === "חיבור וואטסאפ");
ok("CONNECTED → no connection action", whatsAppHomeState("CONNECTED") === "CONNECTED" && whatsAppAction("CONNECTED") === null);
ok("DISCONNECTED → reconnect", whatsAppHomeState("DISCONNECTED") === "DISCONNECTED" && whatsAppAction("DISCONNECTED")?.label === "חיבור מחדש");
ok("REVOKED → reconnect", whatsAppHomeState("REVOKED") === "DISCONNECTED");
ok("REVOKED_BY_META → needs handling (inbound still arrives)", whatsAppHomeState("REVOKED_BY_META") === "ATTENTION" && whatsAppAction("ATTENTION")?.label === "טיפול בחיבור");
ok("ERROR → needs handling", whatsAppHomeState("ERROR") === "ATTENTION");
ok("an unknown future status is never called 'disconnected'", whatsAppHomeState("SOMETHING_NEW") === "ATTENTION");
ok("a connected-before business is never offered a first connection", whatsAppAction("DISCONNECTED")?.label !== "חיבור וואטסאפ" && whatsAppAction("ATTENTION")?.label !== "חיבור וואטסאפ");

// Wire parsing is strict: anything malformed is "unknown", never "no history".
ok("valid wire parses", JSON.stringify(parseHomeHistory(JSON.parse(JSON.stringify(all)))) === JSON.stringify(all));
ok("a missing flag → null", parseHomeHistory({ ...none, leads: undefined }) === null);
ok("a non-boolean flag → null", parseHomeHistory({ ...none, income: 0 }) === null);
ok("an unknown whatsapp state → null", parseHomeHistory({ ...none, whatsapp: "OFF" }) === null);
ok("null / array → null", parseHomeHistory(null) === null && parseHomeHistory([]) === null);

// The service: one statement, every predicate pinned to the business, semantic events only.
{
  const svc = readFileSync("lib/services/home/home-history.service.ts", "utf8");
  const sqlBody = svc.slice(svc.indexOf("Prisma.sql`"), svc.indexOf("`;", svc.indexOf("Prisma.sql`")));
  const froms = sqlBody.match(/FROM "[A-Za-z]+"/g) ?? [];
  const pinned = sqlBody.match(/"businessId" = \$\{b\}/g) ?? [];
  ok("every table read is pinned by an explicit businessId", froms.length > 0 && pinned.length === froms.length, `${pinned.length} pins for ${froms.length} reads`);
  ok("runs inside tenantTx (RLS stays a second guard)", /tenantTx\(businessId/.test(svc));
  ok("income counts settled money only (PAID, amount > 0)", /"status" = 'PAID' AND pt\."amount" > 0/.test(sqlBody));
  ok("expenses: RECORDED payments or approved expense records", /"Payment" WHERE "businessId" = \$\{b\} AND "status" = 'RECORDED'/.test(sqlBody) && /"direction" = 'expense'/.test(sqlBody));
  ok("collection counts a request in any status", /EXISTS \(SELECT 1 FROM "PaymentRequest" WHERE "businessId" = \$\{b\}\) AS "collection"/.test(sqlBody));
  ok("documents count only received ones (needs_review / approved)", /"status" IN \('needs_review', 'approved'\)/.test(sqlBody));
  ok("conversations are read on Message (indexed), not Conversation", /FROM "Message"/.test(sqlBody) && !/FROM "Conversation"/.test(sqlBody));
  ok("no flag is derived from an amount being 0", !/= 0\b/.test(sqlBody));
}

if (failed > 0) {
  console.error(`\nhome-history-model: ${failed} of ${checks} FAILED`);
  process.exit(1);
}
console.log(`\nhome-history-model: PASS (${checks} checks)`);
