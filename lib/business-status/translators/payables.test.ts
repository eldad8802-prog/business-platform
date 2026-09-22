/**
 * M1 — payables L0 facts. Run:
 *   npx tsx lib/business-status/translators/payables.test.ts
 *
 * These are FACTS, not learning: no history, no baseline, no minimum support. The contract this guards
 * is therefore about honesty rather than inference — a partially-paid installment must not be presented
 * as though nothing had been paid, a payment that is not yet due must not be dressed as an action the
 * owner has failed to take, and severity must not pretend to know that an amount is "large" when no
 * baseline for this business exists yet.
 *
 * Also a static guard: the loaders may never reach a tenant table through the global Prisma client.
 * That defect was live in this very file's loaders — inventory alerts, leads and supplier drafts were
 * all read without the tenant GUC, so under the restricted runtime the owner's Attention list silently
 * dropped three domains behind a green 200.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { translatePayablesDueSoon, translatePayablesOverdue } from "./payables";
import { finalizeBusinessStatusItem } from "../priority";
import type { PayableInstallmentRaw } from "../loaders";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const NOW = new Date("2026-09-22T10:00:00Z");
const dec = (n: number) => n as unknown as PayableInstallmentRaw["scheduledAmount"];

const row = (over: Partial<PayableInstallmentRaw> = {}): PayableInstallmentRaw => ({
  id: 1,
  dueAt: new Date("2026-09-01T00:00:00Z"),
  scheduledAmount: dec(5000),
  currency: "ILS",
  commitmentId: 7,
  commitmentTitle: "שכירות",
  payeeName: "בעל הנכס",
  allocatedAmount: 0,
  ...over,
});

// ── Overdue ────────────────────────────────────────────────────────────────
{
  const [item] = translatePayablesOverdue([row()], NOW);
  ok("overdue is ACTION_REQUIRED", item.semanticCategory === "ACTION_REQUIRED");
  ok("overdue is blocking", item.blocking === true);
  ok("overdue names the payee", item.summary!.includes("בעל הנכס"));
  ok("overdue states how late it is", /באיחור 21 ימים/.test(item.summary!));
  ok("entity is the installment, not the commitment", item.entityRef.type === "installment");
  ok("the commitment is carried as a related ref", item.relatedRefs?.[0]?.type === "commitment");
  ok(
    "priority is anchored on the due date, not on when the row was written",
    item.priorityReferenceDate.toISOString() === "2026-09-01T00:00:00.000Z",
  );
}

// Severity climbs with lateness only.
{
  const s = (days: number) =>
    translatePayablesOverdue(
      [row({ dueAt: new Date(NOW.getTime() - days * 86_400_000) })],
      NOW,
    )[0].severity;
  ok("1 day late is MEDIUM", s(1) === "MEDIUM");
  ok("7 days late is HIGH", s(7) === "HIGH");
  ok("30 days late is CRITICAL", s(30) === "CRITICAL");
}

// The amount must NOT move severity: "large" is meaningless without a per-business baseline, and
// inventing one from the number alone would be the first cross-business judgement in the system.
{
  const small = translatePayablesOverdue([row({ scheduledAmount: dec(10) })], NOW)[0].severity;
  const huge = translatePayablesOverdue([row({ scheduledAmount: dec(9_000_000) })], NOW)[0].severity;
  ok("severity ignores the amount (no baseline exists yet)", small === huge, { small, huge });
}

// ── Partial payment is stated, never collapsed ─────────────────────────────
{
  const [item] = translatePayablesOverdue([row({ allocatedAmount: 3000 })], NOW);
  ok("a partly-paid installment states BOTH numbers", /שולם .* מתוך /.test(item.summary!), item.summary);
  ok("…and does not claim the full amount is outstanding", !/^סכום: 5,000/.test(item.summary!));
}

// ── Due soon ───────────────────────────────────────────────────────────────
{
  const soon = row({ dueAt: new Date("2026-09-24T00:00:00Z") });
  const [item] = translatePayablesDueSoon([soon], NOW);
  ok("a payment that is not due is NOT ACTION_REQUIRED", item.semanticCategory === "WARNING");
  ok("…and is not blocking", item.blocking === false);
  ok("…and never reaches CRITICAL", item.severity !== "CRITICAL");
  ok("due-soon says when", /בעוד 2 ימים/.test(item.summary!));
}

{
  const far = translatePayablesDueSoon([row({ dueAt: new Date("2026-10-04T00:00:00Z") })], NOW)[0];
  const near = translatePayablesDueSoon([row({ dueAt: new Date("2026-09-24T00:00:00Z") })], NOW)[0];
  ok("nearer payments outrank further ones", near.severity === "MEDIUM" && far.severity === "LOW");
}

// ── Item ids are stable and distinct ───────────────────────────────────────
{
  const a = translatePayablesOverdue([row({ id: 9 })], NOW)[0];
  const b = translatePayablesDueSoon([row({ id: 9 })], NOW)[0];
  ok("the two facts never collide on itemId", a.itemId !== b.itemId, { a: a.itemId, b: b.itemId });
  ok("itemId is derived from the installment", a.itemId === "payables:overdue:9");
}

// ── Finalization produces a usable item ────────────────────────────────────
{
  const item = finalizeBusinessStatusItem(translatePayablesOverdue([row()], NOW)[0]);
  ok("finalized item carries a numeric priority", Number.isFinite(item.priorityScore));
  ok("finalized item keeps the payables domain", item.domain === "payables");
}

// ── STATIC: no loader may reach a tenant table through the global client ───
{
  const src = readFileSync(join(__dirname, "..", "loaders.ts"), "utf8");
  const globalReads = src.match(/(?:await |return )prisma\.[a-zA-Z]+\.(findMany|findFirst|findUnique|count)/g) ?? [];
  ok(
    "loaders never read a tenant table through the global prisma client",
    globalReads.length === 0,
    globalReads,
  );
  ok(
    "the loaders' dbStep still FAILS LOUD without a tenant context",
    /getTenantContext\(\) === undefined/.test(src) && /throw new Error/.test(src),
  );
}

console.log(failed === 0 ? "\nM1 payables L0 facts: all contracts hold. ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
