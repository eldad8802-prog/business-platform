/**
 * sec(C) M-3 — DATABASE layer: a tenant cannot create a relation to another
 * tenant's entity, even with the application check removed.
 *
 * Fresh lab (prisma migrate deploy + grant scripts), runtime = NEW LOGIN role,
 * NOSUPERUSER NOBYPASSRLS non-owner, member of app_runtime, tenant GUC set.
 * Raw SQL on purpose: this proves the constraint, not the app check.
 */
import { newLab, dropLab, q } from "../lab.mjs";
import { ok, section, client, asTenant, sqlError, fingerprint, makeTenant, prodLikeRuntimeGrants, type Tenant } from "../common";

type Target = "customerId" | "leadId" | "suggestionId" | "conversationId" | "messageId";
type Rel = { table: string; col: string; target: Target; constraint: string; base: (t: Tenant) => Record<string, string | number> };

const REL: Rel[] = [
  { table: "Conversation", col: "customerId", target: "customerId", constraint: "Conversation_customerId_tenant_fkey", base: () => ({ channel: "'WHATSAPP'" }) },
  { table: "Conversation", col: "leadId", target: "leadId", constraint: "Conversation_leadId_tenant_fkey", base: () => ({ channel: "'WHATSAPP'" }) },
  { table: "Message", col: "customerId", target: "customerId", constraint: "Message_customerId_tenant_fkey",
    base: (t) => ({ conversationId: t.conversationId, channel: "'WHATSAPP'", direction: "'INBOUND'", senderType: "'CUSTOMER'" }) },
  { table: "Message", col: "generatedFromSuggestionId", target: "suggestionId", constraint: "Message_generatedFromSuggestionId_tenant_fkey",
    base: (t) => ({ conversationId: t.conversationId, channel: "'WHATSAPP'", direction: "'OUTBOUND'", senderType: "'BUSINESS_USER'" }) },
  { table: "Lead", col: "customerId", target: "customerId", constraint: "Lead_customerId_tenant_fkey", base: () => ({}) },
  { table: "Appointment", col: "customerId", target: "customerId", constraint: "Appointment_customerId_tenant_fkey",
    base: (t) => ({ createdByActor: "'OWNER'", sourceChannel: "'INBOX_WEB'", createdByUserId: t.userId }) },
  { table: "Appointment", col: "leadId", target: "leadId", constraint: "Appointment_leadId_tenant_fkey",
    base: (t) => ({ createdByActor: "'OWNER'", sourceChannel: "'INBOX_WEB'", createdByUserId: t.userId }) },
  { table: "Appointment", col: "sourceConversationId", target: "conversationId", constraint: "Appointment_sourceConversationId_tenant_fkey",
    base: (t) => ({ createdByActor: "'OWNER'", sourceChannel: "'INBOX_WEB'", createdByUserId: t.userId }) },
  { table: "Appointment", col: "sourceMessageId", target: "messageId", constraint: "Appointment_sourceMessageId_tenant_fkey",
    base: (t) => ({ createdByActor: "'OWNER'", sourceChannel: "'INBOX_WEB'", createdByUserId: t.userId }) },
];

function insertSql(rel: Rel, a: Tenant, fkValue: number): string {
  const cols: Record<string, string | number> = { businessId: a.businessId, ...rel.base(a), [rel.col]: fkValue, ...(rel.table === "Message" ? {} : { updatedAt: "now()" }) };
  const names = Object.keys(cols).map((c) => `"${c}"`).join(", ");
  return `INSERT INTO "${rel.table}" (${names}) VALUES (${Object.values(cols).join(", ")}) RETURNING id`;
}

const FP_TABLES = ["Conversation", "Message", "Lead", "Appointment", "Customer", "ReplySuggestion"];

async function bFingerprint(owner: ReturnType<typeof client>, b: Tenant) {
  const out: Record<string, string> = {};
  for (const t of FP_TABLES) out[t] = await fingerprint(owner, t, b.businessId);
  return JSON.stringify(out);
}

void section("m3-db", async () => {
  // ── CONTROL: the gap exists without the sec(C) migration ────────────────────
  {
    const lab = await newLab("m3ctl", { secC: false });
    const owner = client(lab.ownerUrl);
    await prodLikeRuntimeGrants(owner);
    const a = await makeTenant(owner, "ctlA");
    const b = await makeTenant(owner, "ctlB");
    const rt = client(lab.rtUrl);
    const err = await sqlError(asTenant(rt, a.businessId, insertSql(REL[0], a, b.customerId)));
    ok("CONTROL m3-db: without the migration a cross-tenant Conversation.customerId is ACCEPTED (the gap is real)", err === null, err);
    await rt.$disconnect(); await owner.$disconnect(); dropLab(lab);
  }

  // ── the migration closes it ─────────────────────────────────────────────────
  const lab = await newLab("m3db");
  const owner = client(lab.ownerUrl);
  await prodLikeRuntimeGrants(owner);
  const posture = q(lab.rtUrl, `SELECT rolsuper::text || ',' || rolbypassrls::text FROM pg_roles WHERE rolname = current_user`);
  ok("m3-db runtime posture is NOSUPERUSER NOBYPASSRLS", posture === "false,false", posture);
  ok("m3-db runtime is not the table owner", q(lab.ownerUrl, `SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname='Conversation'`) !== lab.roles.rt);

  const a = await makeTenant(owner, "tenantA");
  const b = await makeTenant(owner, "tenantB");
  const before = await bFingerprint(owner, b);
  const rt = client(lab.rtUrl);
  const missing = 2_000_000_000;

  for (const rel of REL) {
    const tag = `${rel.table}.${rel.col}`;
    const own = await sqlError(asTenant(rt, a.businessId, insertSql(rel, a, a[rel.target])));
    ok(`M3-DB ${tag} A->A own reference accepted`, own === null, own);

    const foreign = await sqlError(asTenant(rt, a.businessId, insertSql(rel, a, b[rel.target])));
    ok(`M3-DB ${tag} A->B rejected 23503 on ${rel.constraint}`,
      foreign?.code === "23503" && foreign.message.includes(rel.constraint), foreign);

    const none = await sqlError(asTenant(rt, a.businessId, insertSql(rel, a, missing)));
    ok(`M3-DB ${tag} nonexistent rejected with the same SQLSTATE 23503`, none?.code === "23503", none);
  }

  // UPDATE path: re-pointing an existing own row at a foreign parent.
  for (const [table, col, target, constraint, id] of [
    ["Conversation", "customerId", "customerId", "Conversation_customerId_tenant_fkey", a.conversationId],
    ["Message", "customerId", "customerId", "Message_customerId_tenant_fkey", a.messageId],
    ["Lead", "customerId", "customerId", "Lead_customerId_tenant_fkey", a.leadId],
  ] as const) {
    const upd = await sqlError(asTenant(rt, a.businessId, `UPDATE "${table}" SET "${col}" = ${b[target]} WHERE id = ${id}`));
    ok(`M3-DB ${table}.${col} UPDATE A->B rejected 23503 on ${constraint}`, upd?.code === "23503" && upd.message.includes(constraint), upd);
  }

  ok("M3-DB tenant B rows byte-unchanged", (await bFingerprint(owner, b)) === before);

  // Delete semantics unchanged: deleting a parent nulls ONLY the reference.
  await owner.$executeRawUnsafe(`DELETE FROM "Appointment" WHERE "businessId" = ${a.businessId}`);
  await owner.$executeRawUnsafe(`UPDATE "Message" SET "customerId" = NULL WHERE "businessId" = ${a.businessId}`);
  await owner.$executeRawUnsafe(`DELETE FROM "Customer" WHERE id = ${a.customerId}`);
  const conv = await owner.$queryRawUnsafe<{ c: number | null; b: number }[]>(`SELECT "customerId" AS c, "businessId" AS b FROM "Conversation" WHERE id = ${a.conversationId}`);
  ok("M3-DB parent delete nulls only the FK column (businessId kept)", conv[0]?.c === null && conv[0]?.b === a.businessId, conv);

  const valid = q(lab.ownerUrl, `SELECT count(*) FROM pg_constraint WHERE conname LIKE '%\\_tenant\\_fkey' AND convalidated`);
  ok("M3-DB all nine composite tenant FKs VALIDATED on a clean database", valid === "9", valid);

  await rt.$disconnect(); await owner.$disconnect(); dropLab(lab);

  // ── legacy cross-tenant rows: the migration must not fail the release ───────
  {
    let legacy: { a: Tenant; b: Tenant } | null = null;
    const lab2 = await newLab("m3legacy", {
      beforeSecC: async (ownerUrl: string) => {
        const o = client(ownerUrl);
        const la = await makeTenant(o, "legA");
        const lb = await makeTenant(o, "legB");
        await o.conversation.create({ data: { businessId: la.businessId, channel: "WHATSAPP", customerId: lb.customerId } });
        legacy = { a: la, b: lb };
        await o.$disconnect();
      },
    });
    const o2 = client(lab2.ownerUrl);
    await prodLikeRuntimeGrants(o2);
    const states = q(lab2.ownerUrl, `SELECT string_agg(conname || '=' || convalidated, ',' ORDER BY conname) FROM pg_constraint WHERE conname LIKE '%\\_tenant\\_fkey'`);
    ok("M3-DB legacy violation: migration completed, that ONE constraint left NOT VALID",
      states.includes("Conversation_customerId_tenant_fkey=false") && (states.match(/=true/g) ?? []).length === 8, states);
    const L = legacy as unknown as { a: Tenant; b: Tenant };
    const rt2 = client(lab2.rtUrl);
    const still = await sqlError(asTenant(rt2, L.a.businessId, insertSql(REL[0], L.a, L.b.customerId)));
    ok("M3-DB legacy: NOT VALID constraint still refuses NEW cross-tenant writes (23503)",
      still?.code === "23503" && still.message.includes("Conversation_customerId_tenant_fkey"), still);
    await rt2.$disconnect(); await o2.$disconnect(); dropLab(lab2);
  }
});
