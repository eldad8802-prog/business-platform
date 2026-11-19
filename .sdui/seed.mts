/**
 * Service Desk UI 1.3 end to end — the fixtures, on the M1 lab (.sd3p4/lab.sh + --deploy-only + .sdm1/chain.sh).
 * Synthetic only. Business A has service_desk ENABLED by a per-business override (the lab's own database; nothing
 * outside it); business B has none (the default: OFF). Every case is made through the real service, as the owner.
 *
 *   c1  T1 repair at the business, intake recorded, OPEN            → the UI walks it to CLOSED
 *   c2  T3 repair at the customer, a quote SENT (QUOTE_PENDING)      → the UI records the customer's approval
 *   c3  T1 READY (QA turned off by the owner, decision 4)            → the list's "ready, not collected" row
 *   c4  T1 IN_REPAIR on hold for parts                               → a list row with its reason
 * A's profile is device_lab with T1 QA OFF (decision 4: the owner may turn QA off), so a repair finishes to READY.
 *
 * env: OWNER_URL, AUTH_TOKEN_SECRET, SEED_OUT, STORAGE_PROVIDER=local, LOCAL_STORAGE_ROOT.
 */
import { writeFileSync } from "node:fs";
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
  const { signAuthToken } = await import("@/lib/auth-token");
  const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
  const { openCase, recordIntake, runCaseAction } = await import("@/lib/services/service-desk/service-case.service");
  const { sendQuote } = await import("@/lib/services/service-desk/quote.service");
  const { getStorageService } = await import("@/lib/storage");
  const key = () => uuidV7(new Date());
  const t = Date.now();

  const bizA = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ('מעבדת בדיקה — שירות', now()) RETURNING id`))[0].id);
  const bizB = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdui-B-${t}`))[0].id);
  const userA = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdui-a-${t}@lab.invalid`, bizA))[0].id);
  const userB = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdui-b-${t}@lab.invalid`, bizB))[0].id);
  await owner.businessFeatureAccess.create({ data: { businessId: bizA, featureKey: "service_desk", state: "ENABLED", reason: "lab: service desk UI e2e" } });
  await own(bizA, `INSERT INTO "ServiceSettings" ("businessId", version, "updatedAt", "serviceProfileKey", "profileOverrides") VALUES ($1, 1, now(), 'device_lab', $2::jsonb) RETURNING "businessId"`,
    bizA, JSON.stringify({ requirements: { T1: { qaMode: "OFF" } } }));
  const customer = async (name: string) => Number((await own(bizA, `INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, bizA, name))[0].id);
  const dana = await customer("דנה כהן");
  const gal = await customer("משרד גל ושות׳");
  const michal = await customer("מיכל אברהם");
  const avi = await customer("אבי מזרחי");

  const p = { businessId: bizA, userId: userA };
  const version = async (id: number) => Number((await own(bizA, `SELECT version FROM "ServiceCase" WHERE id = $1`, id))[0].version);
  const act = async (id: number, action: Record<string, unknown>) => runCaseAction(p as never, id, { action, expectedVersion: await version(id) }, { idempotencyKey: key() });
  const intake = async (id: number) => recordIntake(p as never, id, { conditionNote: "שריטות קלות בגב", accessoriesNote: "ללא מטען", conditionRecorded: true, accessoriesRecorded: true, expectedVersion: await version(id) }, { idempotencyKey: key() });
  const open = async (customerId: number, input: Record<string, unknown>) =>
    (await openCase(p as never, { customerId, ...input } as never, { idempotencyKey: key() })).case.id;

  // c1 — T1, OPEN with the intake recorded (the UI confirms the check-in)
  const c1 = await open(dana, { track: "T1", problemDescription: "המסך סדוק בפינה הימנית העליונה אחרי נפילה. המגע עובד.", subject: { displayName: "iPhone 13" } });
  await intake(c1);

  // c2 — T3 at the customer, a quote SENT (the UI records the customer's answer)
  const c2 = await open(gal, { track: "T3", problemDescription: "מזגן מטפטף מים בחדר הישיבות", siteAddress: "הרצל 10, תל אביב", subject: { kind: "SYSTEM", displayName: "מזגן מיני מרכזי" } });
  await act(c2, { type: "CHECK_IN" });
  await act(c2, { type: "START_DIAGNOSIS" });
  const lines: [string, string, string][] = [["החלפת משאבת ניקוז", "1", "380.00"], ["עבודה", "1", "220.00"]];
  const sub = lines.reduce((s, [, n, u]) => s + Math.round(Number(n) * Number(u) * 100), 0);
  const vat = Math.round(sub * 0.18);
  const doc = Number((await own(bizA, `INSERT INTO "BillingDocument" ("businessId", "documentType", status, "customerId", "customerNameSnapshot", "validUntil",
      "subtotalAmount", "vatAmount", "totalAmount", currency, "updatedAt")
    VALUES ($1, 'QUOTE'::"BillingDocumentType", 'DRAFT', $2, 'משרד גל ושות׳', '2026-12-31', $3::numeric / 100, $4::numeric / 100, $5::numeric / 100, 'ILS', now()) RETURNING id`,
    bizA, gal, sub, vat, sub + vat))[0].id);
  let i = 0;
  for (const [desc, n, u] of lines) {
    const ls = Math.round(Number(n) * Number(u) * 100), lv = Math.round(ls * 0.18);
    await own(bizA, `INSERT INTO "BillingDocumentLine" ("billingDocumentId", "lineIndex", description, quantity, "unitPrice", "vatRatePercent", "lineSubtotal", "vatAmount", "lineTotal", "updatedAt")
      VALUES ($1, $2, $3, $4::numeric, $5::numeric, 18, $6::numeric / 100, $7::numeric / 100, $8::numeric / 100, now()) RETURNING id`, doc, i++, desc, n, u, ls, lv, ls + lv);
  }
  const stubRender = async (x: { businessId: number; billingDocumentId: number }) =>
    ({ buffer: Buffer.from(`%PDF-1.4\n% sdui synthetic quote ${x.businessId}/${x.billingDocumentId} ${Date.now()}\n%%EOF\n`, "latin1") });
  await sendQuote(p as never, c2, { billingDocumentId: doc, expectedVersion: await version(c2) }, { idempotencyKey: key() }, { render: stubRender as never, storage: getStorageService() });

  // c3 — T1 READY (QA off for T1 in this business)
  const c3 = await open(michal, { track: "T1", problemDescription: "לא נטען, נזק מים אפשרי", subject: { displayName: "Samsung Galaxy S23" } });
  await intake(c3);
  for (const a of [{ type: "CHECK_IN", intakeConfirmed: true }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "FINISH_REPAIR", outcome: "REPAIRED" }]) await act(c3, a);

  // c4 — T1 IN_REPAIR on hold for parts
  const c4 = await open(avi, { track: "T1", problemDescription: "מקלדת לא מגיבה", subject: { displayName: "MacBook Air M1" } });
  await intake(c4);
  for (const a of [{ type: "CHECK_IN", intakeConfirmed: true }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "SET_HOLD", reason: "PARTS" }]) await act(c4, a);

  const out = { tokenA: signAuthToken(userA, 0), tokenB: signAuthToken(userB, 0), bizA, bizB, userA, c1, c2, c3, c4 };
  writeFileSync(process.env.SEED_OUT!, JSON.stringify(out, null, 2));
  console.log(`seeded: A ${bizA} (service_desk ON, lab only) cases ${c1},${c2},${c3},${c4}; B ${bizB} (default OFF)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => owner.$disconnect());
