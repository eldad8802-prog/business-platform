/**
 * D2 / ACCOUNT-DELETION — J-0. The Production RLS contract, as data.
 *
 * WHY THIS FILE EXISTS
 *
 * The AD-2A battery used to build its own laboratory policies inline, and they
 * were not the policies Production runs. Every policy it created was written as
 *
 *   CREATE POLICY ad2a_tenant ON "<t>" USING (...) WITH CHECK (...)
 *
 * with no FOR clause. PostgreSQL reads a missing FOR clause as FOR ALL, and
 * FOR ALL includes DELETE. Production's five pilot tables carry three SEPARATE
 * policies — SELECT, INSERT and UPDATE — and deliberately no DELETE policy at
 * all. So the battery granted, through the shape of its own fixture, a
 * capability the product does not have, and the one runtime DELETE against
 * those tables passed in the laboratory and matches zero rows in Production.
 *
 * The fixture also omitted five tables outright. Four of them hold the
 * integration credentials the erasure claims to destroy and one is the table
 * the erasure evidence is written to. All five are FORCE-RLS'd in Production
 * and none of them was under RLS in the laboratory, so the two stages that run
 * without a tenant context could not fail there and cannot succeed here.
 *
 * WHAT THIS FILE IS
 *
 * The contract is DATA, not prose, and the battery applies it verbatim. Each
 * entry names the migration it was copied from, so the claim "this is what
 * Production does" is checkable by opening one file rather than by trusting a
 * comment. `renderFidelityTable()` prints the same data as the Production →
 * rehearsal comparison the J-0 report has to carry.
 *
 * SOURCE OF TRUTH: prisma/migrations. Production only ever sees repository
 * migrations, so the migrations ARE the Production contract. No live database
 * was read to build this, and none needs to be.
 */

/** The canonical tenant predicate. Identical text in every tenant policy in the repo. */
const TENANT =
  `"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int`;

/**
 * OAuthToken owns through its parent instead of carrying a businessId, so its
 * predicate is an EXISTS over EmailConnection. Reproduced exactly, because the
 * erasure reaches this table through a Prisma relation filter and a simplified
 * predicate would not exercise the same plan.
 */
const OAUTH_VIA_PARENT =
  `EXISTS (SELECT 1 FROM "EmailConnection" p WHERE p."id" = "OAuthToken"."connectionId" ` +
  `AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`;

/**
 * `MessageAnalysis` owns through `Message` for the same reason and is reproduced
 * the same way. It matters here because the erasure reaches it with a Prisma
 * RELATION filter, and a simplified tenant predicate would let that statement
 * succeed in the lab for a reason Production does not share.
 */
/**
 * `PurchaseOrderLine` owns through `PurchaseOrder` for the same reason and is
 * reproduced the same way. It matters here because stage 2 reaches it with a Prisma
 * RELATION filter, and a simplified tenant predicate would let that statement
 * succeed in the lab for a reason Production does not share.
 */
const LINE_VIA_PURCHASE_ORDER =
  `EXISTS (SELECT 1 FROM "PurchaseOrder" p WHERE p."id" = "PurchaseOrderLine"."purchaseOrderId" ` +
  `AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`;

const ANALYSIS_VIA_MESSAGE =
  `EXISTS (SELECT 1 FROM "Message" p WHERE p."id" = "MessageAnalysis"."messageId" ` +
  `AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`;

/**
 * The platform-admin read path. `TO app_admin`, `USING (true)`: it never applies to
 * the tenant runtime, and the lab creates `app_admin` (NOLOGIN, no privileges) only
 * so the policy can exist exactly as it does in Production.
 */
const ADMIN_READ = { name: "p7adm_read", command: "SELECT", roles: ["app_admin"], using: "true" };

/**
 * @typedef {{name: string, command: 'SELECT'|'INSERT'|'UPDATE'|'ALL', roles?: string[], using?: string, check?: string}} PolicySpec
 * @typedef {{table: string, policies: PolicySpec[], migration: string, why: string}} TableSpec
 */

/**
 * Every RLS-protected table the account-deletion flow actually touches.
 *
 * FORCE is on all of them — that is the point of the D2 contract, and without it
 * the table owner would bypass the policies and the proof would mean nothing.
 *
 * @type {TableSpec[]}
 */
export const PRODUCTION_RLS_CONTRACT = [
  // ── The five pilots. Split per command. NO DELETE POLICY. ────────────────
  // This is the shape the old fixture got wrong, and Conversation is the table
  // where getting it wrong mattered.
  {
    table: "Conversation",
    migration: "20260902120000_d2_cutover2b_pilot_tenant_rls",
    why: "erasure calls conversation.deleteMany; no DELETE policy exists, so it must match zero rows",
    policies: [
      { name: "p7pilot_tenant_read", command: "SELECT", using: TENANT },
      { name: "p7pilot_tenant_insert", command: "INSERT", check: TENANT },
      { name: "p7pilot_tenant_update", command: "UPDATE", using: TENANT, check: TENANT },
      // Migration 20260825090000. Scoped TO app_admin, so it never applies to the
      // runtime role — but it IS on the table in Production, and a contract that
      // leaves out a policy it has decided is irrelevant is a contract nobody can
      // check. Declared, applied, and compared like every other.
      ADMIN_READ,
    ],
  },
  {
    table: "Customer",
    migration: "20260902120000_d2_cutover2b_pilot_tenant_rls",
    why: "erasure anonymises customers with an UPDATE, which the pilot contract permits",
    policies: [
      { name: "p7pilot_tenant_read", command: "SELECT", using: TENANT },
      { name: "p7pilot_tenant_insert", command: "INSERT", check: TENANT },
      { name: "p7pilot_tenant_update", command: "UPDATE", using: TENANT, check: TENANT },
    ],
  },
  {
    table: "Appointment",
    migration: "20260902120000_d2_cutover2b_pilot_tenant_rls",
    why: "pilot table; erasure does not touch it and must be shown not to",
    policies: [
      { name: "p7pilot_tenant_read", command: "SELECT", using: TENANT },
      { name: "p7pilot_tenant_insert", command: "INSERT", check: TENANT },
      { name: "p7pilot_tenant_update", command: "UPDATE", using: TENANT, check: TENANT },
    ],
  },
  {
    table: "BillingDocument",
    migration: "20260902120000_d2_cutover2b_pilot_tenant_rls",
    why: "retained fiscal record; the absence of a DELETE policy is a compliance property",
    policies: [
      { name: "p7pilot_tenant_read", command: "SELECT", using: TENANT },
      { name: "p7pilot_tenant_insert", command: "INSERT", check: TENANT },
      { name: "p7pilot_tenant_update", command: "UPDATE", using: TENANT, check: TENANT },
      ADMIN_READ, // migration 20260825090000, as on Conversation
    ],
  },
  {
    table: "PaymentRequest",
    migration: "20260902120000_d2_cutover2b_pilot_tenant_rls",
    why: "retained payment record; same reason",
    policies: [
      { name: "p7pilot_tenant_read", command: "SELECT", using: TENANT },
      { name: "p7pilot_tenant_insert", command: "INSERT", check: TENANT },
      { name: "p7pilot_tenant_update", command: "UPDATE", using: TENANT, check: TENANT },
    ],
  },

  // ── The credential surfaces stage 1 claims to destroy. ────────────────────
  // FOR ALL here is not laziness: it is what the migrations actually create.
  // Modelling them at all is the correction — the old fixture left every one of
  // them without RLS, which is why a stage that carries no tenant context could
  // not fail there.
  {
    table: "EmailConnection",
    migration: "20260826200000_d2_p7_w4c_gmail_tenant_rls",
    why: "stage 1 revokes the Gmail connection with an UPDATE carrying no tenant context",
    policies: [
      { name: "p7w4c_tenant", command: "ALL", using: TENANT, check: TENANT },
      ADMIN_READ, // created by the same migration, TO app_admin
    ],
  },
  {
    table: "OAuthToken",
    migration: "20260826200000_d2_p7_w4c_gmail_tenant_rls",
    why: "stage 1 deletes the Gmail refresh token through a relation filter, carrying no tenant context",
    policies: [
      { name: "p7w4c_tenant", command: "ALL", using: OAUTH_VIA_PARENT, check: OAUTH_VIA_PARENT },
    ],
  },
  {
    table: "BillingAuthorityConnection",
    migration: "20260831120000_d2_p7_w4eb2_billing_tenant_rls",
    why: "stage 1 clears the SHAAM token ciphertext, carrying no tenant context",
    policies: [{ name: "p7w4eb2_tenant", command: "ALL", using: TENANT, check: TENANT }],
  },
  {
    table: "BusinessPaymentConnection",
    migration: "20260830120000_d2_p7_w4ea_payments_tenant_rls",
    why: "stage 1 clears the payment-provider credential, carrying no tenant context",
    policies: [{ name: "p7w4ea_tenant", command: "ALL", using: TENANT, check: TENANT }],
  },

  // ── The evidence surface stage 3 writes to. ───────────────────────────────
  {
    table: "LearningEvent",
    migration: "20260825150000_d2_p7_wave2_tenant_rls",
    why: "stage 3 inserts the ACCOUNT_DELETED evidence here, carrying no tenant context",
    policies: [{ name: "p7w2_tenant", command: "ALL", using: TENANT, check: TENANT }],
  },

  // ── Surfaces stage 2 reaches under a proven context. ──────────────────────
  // These were already modelled and are kept so the corrected battery still
  // proves what the original one legitimately proved.
  {
    table: "Message",
    migration: "20260826150000_d2_p7_w4b_whatsapp_tenant_rls",
    why: "cascades from Conversation; must be shown to survive when the parent delete matches nothing",
    policies: [{ name: "p7w4b_tenant", command: "ALL", using: TENANT, check: TENANT }],
  },
  {
    table: "ReplySuggestion",
    migration: "20260826150000_d2_p7_w4b_whatsapp_tenant_rls",
    why: "holds generated reply text, which the erasure anonymises in place",
    policies: [{ name: "p7w4b_tenant", command: "ALL", using: TENANT, check: TENANT }],
  },
  {
    table: "MessageAnalysis",
    migration: "20260826150000_d2_p7_w4b_whatsapp_tenant_rls",
    why:
      "derived analysis of message content. It carries NO businessId — ownership " +
      "is reached through Message — so the erasure can only touch it if the lab " +
      "reproduces that EXISTS predicate instead of a simpler tenant one.",
    policies: [
      { name: "p7w4b_tenant", command: "ALL", using: ANALYSIS_VIA_MESSAGE, check: ANALYSIS_VIA_MESSAGE },
    ],
  },
  {
    table: "CrmNote",
    migration: "20260824210000_d2_p7_wave1_tenant_rls",
    why: "erasure deletes these, and FOR ALL covers DELETE, so this one legitimately succeeds",
    policies: [{ name: "p7w1_tenant", command: "ALL", using: TENANT, check: TENANT }],
  },
  {
    table: "CrmAttachment",
    migration: "20260824210000_d2_p7_wave1_tenant_rls",
    why: "same",
    policies: [{ name: "p7w1_tenant", command: "ALL", using: TENANT, check: TENANT }],
  },
  {
    table: "BusinessProfile",
    migration: "20260824210000_d2_p7_wave1_tenant_rls",
    why: "erasure anonymises the profile under a proven context",
    policies: [{ name: "p7w1_tenant", command: "ALL", using: TENANT, check: TENANT }],
  },
  {
    table: "Lead",
    migration: "20260824210000_d2_p7_wave1_tenant_rls",
    why: "erasure anonymises leads under a proven context",
    policies: [{ name: "p7w1_tenant", command: "ALL", using: TENANT, check: TENANT }],
  },
  {
    table: "Notification",
    migration: "20260903200000_notification_persistence",
    why:
      "the notification title and summary are a denormalised COPY of counterparty " +
      "identity and of conversation content — the erasure anonymises them in place, " +
      "because the runtime holds SELECT/INSERT/UPDATE here and no DELETE",
    policies: [{ name: "notif_tenant", command: "ALL", using: TENANT, check: TENANT }],
  },
  {
    table: "NotificationDelivery",
    migration: "20260903200000_notification_persistence",
    why: "child of Notification; carries no personal text of its own, but must be under the same contract",
    policies: [{ name: "notif_delivery_tenant", command: "ALL", using: TENANT, check: TENANT }],
  },
  {
    table: "HistoricalFiscalDocument",
    migration: "20260907120000_i8a_historical_fiscal_documents",
    why: "retained fiscal history; SELECT and INSERT only, so neither UPDATE nor DELETE can reach it even under a correct context",
    policies: [
      { name: "i8a_hist_tenant_read", command: "SELECT", using: TENANT },
      { name: "i8a_hist_tenant_insert", command: "INSERT", check: TENANT },
    ],
  },

  // ── C12-E1. Stage 2 now clears one note on each of these. ────────────────
  //
  // Absent from this file until now, which matters more than it looks: a table the
  // fixture does not model is a table the lab leaves WITHOUT row-level security,
  // and an erasure proved against an unprotected table is proved against a database
  // Production does not have. That is Defect B's shape. Adding them is what lets
  // this increment claim a runtime proof at all.
  //
  // Copied from the migration, not invented: FORCE RLS, one FOR ALL policy each.
  {
    table: "ReceivingSession",
    migration: "20260825200000_d2_p7_wave3_tenant_rls",
    why: "stage 2 clears `note` here, under a direct businessId predicate",
    policies: [{ name: "p7w3_tenant", command: "ALL", using: TENANT, check: TENANT }],
  },
  {
    // Owns through its parent instead of carrying a businessId, exactly like
    // OAuthToken — and reproduced exactly for the same reason: the erasure reaches
    // this table through a Prisma RELATION filter, and a simplified predicate would
    // let the statement succeed in the lab for a reason Production does not share.
    table: "PurchaseOrderLine",
    migration: "20260825200000_d2_p7_wave3_tenant_rls",
    why: "stage 2 clears `remainingDecisionNote` through the PurchaseOrder relation",
    policies: [
      {
        name: "p7w3_tenant",
        command: "ALL",
        using: LINE_VIA_PURCHASE_ORDER,
        check: LINE_VIA_PURCHASE_ORDER,
      },
    ],
  },
  {
    // Not erased, and not optional either: it is the table PurchaseOrderLine's
    // predicate reads. Without it under the same contract, the EXISTS above proves
    // nothing about tenancy.
    table: "PurchaseOrder",
    migration: "20260825200000_d2_p7_wave3_tenant_rls",
    why: "the parent PurchaseOrderLine's tenant predicate joins to; nothing on it is erased",
    policies: [{ name: "p7w3_tenant", command: "ALL", using: TENANT, check: TENANT }],
  },

  // ── Lab isolation hardening. Found by the contract ↔ migration cross-check. ──
  //
  // Stage 2 has DELETED the inbound sender authorisation list since T1-ERASURE,
  // and both tables have been FORCE-RLS'd in Production since the migration that
  // created them. Neither was ever in this contract, so the laboratory ran that
  // delete against tables with NO row-level security. Nothing here was noticed by
  // reading; it was found by comparing this file with what the migrations do.
  {
    table: "InboundEmailAuthorizedSender",
    migration: "20260916090000_inbound_email_authorized_senders",
    why: "stage 2 deletes the sender authorisation list under a tenant context",
    policies: [{ name: "inbound_sender_tenant", command: "ALL", using: TENANT, check: TENANT }],
  },
  {
    table: "InboundEmailSenderChallenge",
    migration: "20260916090000_inbound_email_authorized_senders",
    why: "stage 2 deletes pending sender challenges under a tenant context",
    policies: [{ name: "inbound_challenge_tenant", command: "ALL", using: TENANT, check: TENANT }],
  },
];

/**
 * Tables the deletion flow touches that carry NO row-level security in
 * Production. Listed so their absence is a recorded decision rather than an
 * omission, and asserted by the battery — a table that silently acquired RLS
 * would change what stage 1 can do.
 */
export const PRODUCTION_NO_RLS = [
  { table: "Business", why: "login and signup run before a tenant id exists; boundary is column privilege" },
  { table: "User", why: "same" },
  { table: "WhatsAppConnection", why: "no migration has ever put it under RLS; stage 1 reaches it" },
  { table: "POSApiKey", why: "same; stage 1 deletes these rows successfully" },
];

/**
 * Apply the contract to a lab database, as the owner.
 *
 * Deliberately NOT idempotent-by-luck: every policy is dropped by name first,
 * so a rerun converges instead of layering permissive policies on top of each
 * other. Permissive policies OR together, and two of them would quietly restore
 * the very DELETE reachability this fixture exists to withhold.
 */
export async function applyProductionContract(owner) {
  for (const spec of PRODUCTION_RLS_CONTRACT) {
    await owner.$executeRawUnsafe(`ALTER TABLE "${spec.table}" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "${spec.table}" FORCE ROW LEVEL SECURITY`);
    // Remove the old laboratory policy wherever a previous run left one, and any
    // policy of ours, before recreating. Named drops only — never DROP ALL.
    await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS ad2a_tenant ON "${spec.table}"`);
    for (const p of spec.policies) {
      await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS ${p.name} ON "${spec.table}"`);
      const forClause = p.command === "ALL" ? "" : ` FOR ${p.command}`;
      const toClause = p.roles ? ` TO ${p.roles.join(", ")}` : "";
      const using = p.using ? ` USING (${p.using})` : "";
      const check = p.check ? ` WITH CHECK (${p.check})` : "";
      await owner.$executeRawUnsafe(
        `CREATE POLICY ${p.name} ON "${spec.table}"${forClause}${toClause}${using}${check}`
      );
    }
  }
  for (const spec of PRODUCTION_NO_RLS) {
    // Assert the absence rather than assume it: a previous run of the OLD
    // battery may have enabled RLS on tables Production leaves alone.
    await owner.$executeRawUnsafe(`ALTER TABLE "${spec.table}" NO FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "${spec.table}" DISABLE ROW LEVEL SECURITY`);
  }
}

/**
 * Read back what the database actually has, so fidelity is measured rather than
 * declared. Returns one row per table with its live policy commands.
 */
export async function readLiveContract(owner, tables) {
  const rows = await owner.$queryRawUnsafe(`
    SELECT c.relname::text            AS table,
           c.relrowsecurity           AS rls,
           c.relforcerowsecurity      AS force,
           COALESCE(
             (SELECT array_agg(p.polname::text || ':' || p.polcmd::text ORDER BY p.polname)
                FROM pg_policy p WHERE p.polrelid = c.oid),
             ARRAY[]::text[]
           )                          AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
  `, tables);
  return rows;
}

/** polcmd codes as PostgreSQL stores them. */
export const POLCMD = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", "*": "ALL" };

/**
 * The Production → rehearsal comparison the J-0 report must carry. Printed by
 * the battery so the report quotes measured output rather than restating this
 * file's intentions.
 */
export function renderFidelityTable(live) {
  const byTable = new Map(live.map((r) => [r.table, r]));
  const lines = [];
  lines.push(
    "table                      | RLS | FORCE | policy commands (live)      | DELETE reachable | migration"
  );
  lines.push(
    "---------------------------+-----+-------+-----------------------------+------------------+-----------------------------------------------"
  );
  for (const spec of PRODUCTION_RLS_CONTRACT) {
    const r = byTable.get(spec.table);
    const cmds = (r?.policies ?? [])
      .map((s) => POLCMD[s.split(":")[1]] ?? s.split(":")[1])
      .sort()
      .join(",");
    const deleteReachable = cmds.includes("ALL") || cmds.includes("DELETE");
    lines.push(
      [
        spec.table.padEnd(26),
        String(r?.rls ?? "?").padEnd(3),
        String(r?.force ?? "?").padEnd(5),
        cmds.padEnd(27),
        (deleteReachable ? "yes" : "NO").padEnd(16),
        spec.migration,
      ].join(" | ")
    );
  }
  for (const spec of PRODUCTION_NO_RLS) {
    const r = byTable.get(spec.table);
    lines.push(
      [
        spec.table.padEnd(26),
        String(r?.rls ?? "?").padEnd(3),
        String(r?.force ?? "?").padEnd(5),
        "(none — no RLS)".padEnd(27),
        "yes (grant only)".padEnd(16),
        "no migration enables RLS here",
      ].join(" | ")
    );
  }
  return lines.join("\n");
}

/** Every table named by the contract, for the read-back. */
export function contractTables() {
  return [
    ...PRODUCTION_RLS_CONTRACT.map((s) => s.table),
    ...PRODUCTION_NO_RLS.map((s) => s.table),
  ];
}

/**
 * LAB ISOLATION HARDENING — the runtime's table privileges, DECLARED.
 *
 * The battery grants these with imperative statements, and it used to be the only
 * record of them. So nothing could notice a GRANT that went missing (the lab kept the
 * one an earlier run had made) or one that should not be there. This is the
 * declaration those statements are checked against: after the contract is applied,
 * the runtime role's live privileges on EVERY table in the schema must equal this map
 * exactly — a table absent from it must carry no privilege at all.
 *
 * Each entry names its basis. `LAB` marks a grant the laboratory makes so the real
 * code path can run; it is a statement about the lab, not a claim about Production.
 * Production's own runtime grants come partly from per-environment scripts applied by
 * hand and partly from default privileges (see migration 20260922090000), and are NOT
 * derivable from the repository — so this map is never presented as Production truth.
 *
 * @type {Record<string, {verbs: string[], basis: string}>}
 */
const SIUD = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const SIU = ["SELECT", "INSERT", "UPDATE"];
const LAB_BROAD = "LAB: the erasure code path; Production holds DELETE here through historical broad grants";
export const EXPECTED_RUNTIME_TABLE_PRIVILEGES = {
  Conversation: { verbs: SIUD, basis: LAB_BROAD },
  Message: { verbs: SIUD, basis: LAB_BROAD },
  MessageAnalysis: { verbs: SIUD, basis: LAB_BROAD },
  ReplySuggestion: { verbs: SIUD, basis: LAB_BROAD },
  Customer: { verbs: SIUD, basis: LAB_BROAD },
  CrmNote: { verbs: SIUD, basis: LAB_BROAD },
  CrmAttachment: { verbs: SIUD, basis: LAB_BROAD },
  BusinessProfile: { verbs: SIUD, basis: LAB_BROAD },
  User: { verbs: SIUD, basis: LAB_BROAD },
  Business: { verbs: SIUD, basis: LAB_BROAD },
  Lead: { verbs: SIUD, basis: LAB_BROAD },
  POSApiKey: { verbs: SIUD, basis: LAB_BROAD },
  OAuthToken: { verbs: SIUD, basis: LAB_BROAD },
  EmailConnection: { verbs: SIUD, basis: LAB_BROAD },
  WhatsAppConnection: { verbs: SIUD, basis: LAB_BROAD },
  BusinessPaymentConnection: { verbs: SIUD, basis: LAB_BROAD },
  BillingAuthorityConnection: { verbs: SIUD, basis: LAB_BROAD },
  LearningEvent: { verbs: SIUD, basis: LAB_BROAD },
  Appointment: { verbs: SIUD, basis: LAB_BROAD },
  InboundEmailAuthorizedSender: { verbs: SIUD, basis: "migration 20260916090000 grants app_runtime all four" },
  InboundEmailSenderChallenge: { verbs: SIUD, basis: "migration 20260916090000 grants app_runtime all four" },
  HistoricalFiscalDocument: { verbs: ["SELECT", "INSERT"], basis: "I-8A: SELECT and INSERT only" },
  Notification: { verbs: SIU, basis: "scripts/security/notification-grants.sql — no DELETE" },
  NotificationDelivery: { verbs: SIU, basis: "scripts/security/notification-grants.sql — no DELETE" },
  ReceivingSession: { verbs: SIU, basis: "scripts/security/d2-p7-wave3-grants.sql — no DELETE" },
  PurchaseOrderLine: { verbs: SIU, basis: "scripts/security/d2-p7-wave3-grants.sql — no DELETE" },
  PurchaseOrder: { verbs: SIU, basis: "scripts/security/d2-p7-wave3-grants.sql — no DELETE" },
};

/** Every sequence in the schema: USAGE and SELECT, nothing else. */
export const EXPECTED_RUNTIME_SEQUENCE_PRIVILEGES = ["SELECT", "USAGE"];
