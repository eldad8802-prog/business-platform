/**
 * UX review tour — extra synthetic states on top of .sdui/seed.mts (the lab's own database; nothing else).
 *   x2 T1 OPEN, no intake yet                       → the intake screen before anything is recorded
 *   x3 T3 at the customer, walked as far as it goes → the field-visit states (WORK_DONE: "close the call")
 *   x4 T1 CANCELLED                                 → a cancelled case
 *   x5 T6 remote support, OPEN                      → "start the treatment"
 *   x6 T1 CHECKED_IN                                → received, diagnosis not started
 *   bizD: service desk ON, activity chosen, NO case → the empty list
 * env: OWNER_URL, SEED_OUT (read + extended).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
async function own(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}

async function main() {
  const seed = JSON.parse(readFileSync(process.env.SEED_OUT!, "utf8"));
  const { signAuthToken } = await import("@/lib/auth-token");
  const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
  const { openCase, recordIntake, runCaseAction } = await import("@/lib/services/service-desk/service-case.service");
  const key = () => uuidV7(new Date());
  const bizA = seed.bizA as number;
  const p = { businessId: bizA, userId: seed.userA };
  const version = async (id: number) => Number((await own(bizA, `SELECT version FROM "ServiceCase" WHERE id = $1`, id))[0].version);
  const status = async (id: number) => String((await own(bizA, `SELECT status::text s FROM "ServiceCase" WHERE id = $1`, id))[0].s);
  const act = async (id: number, action: Record<string, unknown>) => {
    try { await runCaseAction(p as never, id, { action, expectedVersion: await version(id) }, { idempotencyKey: key() }); }
    catch (e) { console.log(`  (case ${id}: ${String(action.type)} refused — ${(e as Error).message.slice(0, 120)})`); }
  };
  const customer = async (name: string, phone: string | null = null) =>
    Number((await own(bizA, `INSERT INTO "Customer" ("businessId", name, phone, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, bizA, name, phone))[0].id);
  const open = async (customerId: number, input: Record<string, unknown>) =>
    (await openCase(p as never, { customerId, ...input } as never, { idempotencyKey: key() })).case.id;

  const noa = await customer("נועה שפירא", "0521234567");
  const x2 = await open(noa, { track: "T1", problemDescription: "המחשב נכבה לבד אחרי כמה דקות", subject: { displayName: "Lenovo ThinkPad" } });

  const hotel = await customer("מלון הים", "036001234");
  const x3 = await open(hotel, { track: "T3", problemDescription: "דוד מים חמים לא מחמם", siteAddress: "הירקון 50, תל אביב", subject: { kind: "SYSTEM", displayName: "דוד שמש" } });
  for (const a of [{ type: "CHECK_IN" }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "FINISH_REPAIR", outcome: "REPAIRED" }]) await act(x3, a);

  const x4 = await open(noa, { track: "T1", problemDescription: "הלקוחה החליטה לא לתקן", subject: { displayName: "Kindle" } });
  await act(x4, { type: "CANCEL", reason: "הלקוחה ביטלה" });

  const ido = await customer("עידו ברק");
  const x5 = await open(ido, { track: "T6", problemDescription: "לא מצליח להתחבר לתיבת המייל בטלפון" });

  const x6 = await open(ido, { track: "T1", problemDescription: "הרמקול צורם", subject: { displayName: "JBL Flip 6" } });
  await recordIntake(p as never, x6, { conditionNote: "תקין חיצונית", accessoriesNote: "כבל טעינה", conditionRecorded: true, accessoriesRecorded: true, expectedVersion: await version(x6) }, { idempotencyKey: key() });
  await act(x6, { type: "CHECK_IN", intakeConfirmed: true });

  // bizD — open, activity chosen, no case at all
  const t = Date.now();
  const bizD = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ('עסק חדש — בדיקה', now()) RETURNING id`))[0].id);
  const userD = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdux-d-${t}@lab.invalid`, bizD))[0].id);
  await owner.businessFeatureAccess.create({ data: { businessId: bizD, featureKey: "service_desk", state: "ENABLED", reason: "lab: UX review tour (empty list)" } });
  await own(bizD, `INSERT INTO "ServiceSettings" ("businessId", version, "updatedAt", "serviceProfileKey") VALUES ($1, 1, now(), 'device_lab') RETURNING "businessId"`, bizD);

  const out = { ...seed, x2, x3, x4, x5, x6, bizD, tokenD: signAuthToken(userD, 0) };
  writeFileSync(process.env.SEED_OUT!, JSON.stringify(out, null, 2));
  console.log(`extra: x2 ${x2} ${await status(x2)}, x3 ${x3} ${await status(x3)}, x4 ${x4} ${await status(x4)}, x5 ${x5} ${await status(x5)}, x6 ${x6} ${await status(x6)}; D ${bizD} (no case)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => owner.$disconnect());
