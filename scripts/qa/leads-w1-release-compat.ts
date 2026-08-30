/**
 * Leads W1 — post-migration application-compatibility smoke.
 *
 * Runs against a CLONE of Production that already has all three pending
 * migrations applied (`w4d_documents_tenant_rls`, `w4ea_payments_tenant_rls`,
 * `leads_w1_core`). Its job is to prove that the application head of PR #297
 * still serves the EXISTING domains — Documents, Payments, Customers, CRM,
 * Billing, Reports — against the future Production schema, not merely that the
 * migration SQL succeeded.
 *
 * Reads REAL cloned rows (82 documents, 24 financial records, ...) through the
 * real HTTP routes, so an RLS policy that accidentally hid production data
 * would show up as an empty list rather than as a silent pass.
 *
 * READ-ONLY against every pre-existing domain: it issues GETs only, and the one
 * write it performs (a lead) is created and then removed with its tenant.
 *
 *   LEADS_COMPAT_BASE=http://localhost:3210 npx tsx scripts/qa/leads-w1-release-compat.ts
 */
import { signAuthToken } from "@/lib/auth-token";

const BASE = process.env.LEADS_COMPAT_BASE || "http://localhost:3210";

/** Cloned-production identities, discovered from the clone itself. */
const DOCS_USER_ID = Number(process.env.COMPAT_DOCS_USER_ID || 3); // Cohen Consulting Ltd — 82 docs
const CRM_USER_ID = Number(process.env.COMPAT_CRM_USER_ID || 9); // הוביז — the customer + notes

let passed = 0;
const failures: string[] = [];

function ok(label: string) {
  passed += 1;
  console.log(`  ok  ${label}`);
}

function bad(label: string, detail: string) {
  failures.push(`${label} — ${detail}`);
  console.log(`  FAIL  ${label} — ${detail}`);
}

function check(cond: boolean, label: string, detail = "assertion failed") {
  if (cond) ok(label);
  else bad(label, detail);
}

async function get(path: string, token: string | null) {
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: body as Record<string, unknown> | null };
}

function count(body: unknown, ...keys: string[]): number {
  if (Array.isArray(body)) return body.length;
  const rec = body as Record<string, unknown> | null;
  if (!rec) return -1;
  for (const k of keys) {
    const v = rec[k];
    if (Array.isArray(v)) return v.length;
  }
  return -1;
}

async function main() {
  const docsToken = signAuthToken(DOCS_USER_ID);
  const crmToken = signAuthToken(CRM_USER_ID);

  console.log(`compat smoke against ${BASE}\n`);

  /* ------------------------------------------------------- auth / session -- */
  const unauth = await get("/api/home", null);
  check(unauth.status === 401, "AUTH unauthenticated /api/home is refused", `status=${unauth.status}`);

  const home = await get("/api/home", docsToken);
  check(home.status === 200, "AUTH a signed token still resolves a session", `status=${home.status}`);

  /* --------------------------------------------------------------- DOCUMENTS */
  // The whole point of W4D: 8 document tables became RLS-forced. If the runtime
  // lost access, these come back empty instead of erroring — so assert COUNTS.
  const inbox = await get("/api/documents/inbox", docsToken);
  const inboxCount = count(inbox.body, "documents", "items");
  check(inbox.status === 200, "DOCUMENTS /api/documents/inbox responds 200", `status=${inbox.status}`);
  check(
    inboxCount > 0,
    "DOCUMENTS the inbox still returns real cloned documents",
    `count=${inboxCount} (RLS would show 0)`
  );

  const search = await get("/api/search?limit=50", docsToken);
  const searchCount = count(search.body, "results");
  check(search.status === 200, "DOCUMENTS /api/search responds 200", `status=${search.status}`);
  check(
    searchCount > 0,
    "DOCUMENTS FinancialRecord search still returns rows",
    `count=${searchCount}`
  );

  const summary = await get("/api/reports/summary", docsToken);
  check(summary.status === 200, "DOCUMENTS /api/reports/summary responds 200", `status=${summary.status}`);

  /* ---------------------------------------------------------------- PAYMENTS */
  // W4EA made 4 payment tables RLS-forced.
  const providers = await get("/api/payments/providers", crmToken);
  check(providers.status === 200, "PAYMENTS /api/payments/providers responds 200", `status=${providers.status}`);

  const connections = await get("/api/payments/connections", crmToken);
  check(connections.status === 200, "PAYMENTS /api/payments/connections responds 200", `status=${connections.status}`);

  const requests = await get("/api/payments/requests", crmToken);
  check(requests.status === 200, "PAYMENTS /api/payments/requests responds 200", `status=${requests.status}`);

  const collection = await get("/api/billing/collection/awaiting", crmToken);
  check(
    collection.status === 200,
    "PAYMENTS /api/billing/collection/awaiting responds 200",
    `status=${collection.status}`
  );

  /* --------------------------------------------------------------- CUSTOMERS */
  const customers = await get("/api/customers?status=all", crmToken);
  const custCount = count(customers.body, "customers");
  check(customers.status === 200, "CUSTOMERS /api/customers responds 200", `status=${customers.status}`);
  check(custCount > 0, "CUSTOMERS the cloned customer is still visible", `count=${custCount}`);

  const custId = (customers.body?.customers as Array<{ id: number }> | undefined)?.[0]?.id;
  if (custId) {
    const card = await get(`/api/customers/${custId}`, crmToken);
    check(card.status === 200, "CUSTOMERS the customer card read-model still loads", `status=${card.status}`);

    const notes = await get(`/api/crm/subjects/CUSTOMER/${custId}/notes`, crmToken);
    const noteCount = count(notes.body, "notes");
    check(notes.status === 200, "CRM notes on a CUSTOMER still load", `status=${notes.status}`);
    check(noteCount > 0, "CRM the cloned CRM note is still there", `count=${noteCount}`);
  } else {
    bad("CUSTOMERS could not resolve a customer id", "list was empty");
  }

  /* ----------------------------------------------------------------- BILLING */
  const billing = await get("/api/billing/documents", crmToken);
  check(billing.status === 200, "BILLING /api/billing/documents responds 200", `status=${billing.status}`);

  /* ------------------------------------------------------------------- LEADS */
  const leads = await get("/api/leads", crmToken);
  check(leads.status === 200, "LEADS /api/leads responds 200 on the migrated schema", `status=${leads.status}`);
  check(count(leads.body, "leads") === 0, "LEADS production has no leads yet (expected empty)");

  const leadSubjectNotes = await get("/api/crm/subjects/LEAD/999999/notes", crmToken);
  check(
    leadSubjectNotes.status === 404,
    "LEADS LEAD is a recognised CRM subject (missing lead → 404, not 400)",
    `status=${leadSubjectNotes.status}`
  );

  console.log("");
  if (failures.length) {
    console.log(`COMPAT SMOKE FAIL — ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`COMPAT SMOKE PASS — ${passed} checks green.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
