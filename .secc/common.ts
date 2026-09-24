/**
 * sec(C) battery helpers. Every section prints `PASS: <label>` / `FAIL: <label>`
 * and exits 1 if any assertion failed. A crash BEFORE the assertions complete
 * exits 2 with `SETUP-CRASH`, which the mutation runner never accepts as an
 * intended red — a proof that cannot set itself up proves nothing.
 */
import { PrismaClient } from "@prisma/client";

let fails = 0;
let passes = 0;
export function ok(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { passes += 1; console.log(`PASS: ${label}`); }
  else { fails += 1; console.log(`FAIL: ${label}${detail === undefined ? "" : ` — ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300)}`}`); }
}

export async function section(name: string, body: () => Promise<void>): Promise<never> {
  console.log(`\n=== sec(C) section: ${name} ===`);
  try {
    await body();
  } catch (e) {
    console.log(`SETUP-CRASH: ${name}: ${String((e as Error)?.stack ?? e).split("\n").slice(0, 6).join(" | ")}`);
    process.exit(2);
  }
  console.log(`\n[${name}] PASS=${passes} FAIL=${fails}`);
  process.exit(fails > 0 ? 1 : 0);
}

export function client(url: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: url, log: [] });
}

/** Run `sql` as the connection's role inside a transaction with the tenant GUC set. */
export async function asTenant(db: PrismaClient, businessId: number | null, sql: string, ...params: unknown[]) {
  return db.$transaction(async (tx) => {
    if (businessId !== null) await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
    return tx.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);
  });
}

/** SQLSTATE + message of a failed raw query, or null if it succeeded. */
export async function sqlError(p: Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const err = e as { meta?: { code?: string; message?: string }; code?: string; message?: string };
    return { code: err.meta?.code ?? err.code ?? "?", message: String(err.meta?.message ?? err.message ?? "") };
  }
}

/** Byte fingerprint of one tenant's rows in a table (owner connection; bypasses nothing it shouldn't — owner sees all). */
export async function fingerprint(owner: PrismaClient, table: string, businessId: number): Promise<string> {
  const r = await owner.$queryRawUnsafe<{ h: string | null; n: number }[]>(
    `SELECT md5(string_agg(row_to_json(t)::text, '|' ORDER BY t.id)) AS h, count(*)::int AS n FROM "${table}" t WHERE t."businessId" = $1`,
    businessId
  );
  return `${r[0]?.n}:${r[0]?.h}`;
}

export type Tenant = {
  businessId: number;
  userId: number;
  customerId: number;
  leadId: number;
  conversationId: number;
  messageId: number;
  suggestionId: number;
};

/** Owner-side fixtures: one complete tenant graph. */
export async function makeTenant(owner: PrismaClient, name: string): Promise<Tenant> {
  const b = await owner.business.create({ data: { name } });
  const u = await owner.user.create({ data: { email: `${name}-${b.id}@secc.invalid`, password: "x", businessId: b.id } });
  const c = await owner.customer.create({ data: { businessId: b.id, name: `${name} customer` } });
  const l = await owner.lead.create({ data: { businessId: b.id, customerId: c.id } });
  const conv = await owner.conversation.create({ data: { businessId: b.id, channel: "WHATSAPP", customerId: c.id, leadId: l.id } });
  const m = await owner.message.create({
    data: { businessId: b.id, conversationId: conv.id, channel: "WHATSAPP", direction: "INBOUND", senderType: "CUSTOMER", contentText: "hi" },
  });
  const s = await owner.replySuggestion.create({
    data: { businessId: b.id, conversationId: conv.id, suggestionType: "REPLY", text: "hello" },
  });
  return { businessId: b.id, userId: u.id, customerId: c.id, leadId: l.id, conversationId: conv.id, messageId: m.id, suggestionId: s.id };
}

/** The grants Production's out-of-repo default privileges give the runtime today,
 * minus the tables whose narrowing IS in the repo (User/Business/Auth*). Used only by
 * sections that drive real application code paths touching many tables. */
export async function prodLikeRuntimeGrants(owner: PrismaClient): Promise<void> {
  await owner.$executeRawUnsafe(`
    DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind = 'r'
                 AND c.relname NOT IN ('User','Business','AuthSession','AuthSessionSecret','_prisma_migrations',
                                       'CollectionAction','HistoricalFiscalDocument','ProductUsageEvent')
      LOOP EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_runtime', r.relname); END LOOP;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
      GRANT INSERT ON "ProductUsageEvent" TO app_runtime;
    END $$;`);
}
