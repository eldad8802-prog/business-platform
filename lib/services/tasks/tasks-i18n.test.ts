/**
 * Daily Tasks — the server-built agenda text in the interface language (i18n B-4, area `system`).
 *
 *   Hebrew is byte-identical to the text before i18n: a rich agenda (every bucket, tag, queue, repair and
 *   source name) and every cadence shape are compared, as a SHA-256 of their JSON, with the output the
 *   pre-i18n code produced for the same input (the hashes below were taken from that code).
 *   The default (no translator) is Hebrew, and an explicit Hebrew translator gives the same output.
 *   English carries no Hebrew letters in any of the server-built strings.
 *   The adapters' fixed templates (sources.ts) say exactly what the old template literals said.
 *
 * Run: npx tsx lib/services/tasks/tasks-i18n.test.ts
 */
import { createHash } from "node:crypto";

import { getMessages } from "@/lib/i18n/messages";
import { createTranslator } from "@/lib/i18n/translate";

import { SOURCE_KINDS, buildAgenda, overdueLabel, queueTitle, type AgendaInput, type SourceItem, type SourceKind } from "./agenda-core";
import { cadenceLabel, type SeriesRule } from "./task-core";

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  checks += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, extra ?? "");
  }
}
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const TODAY = "2026-10-14";
const NOW = new Date("2026-10-14T09:00:00Z");

function item(kind: SourceKind, n: number, over: Partial<SourceItem> = {}): SourceItem {
  return {
    sourceKind: kind,
    dedupeKey: `${kind}:${n}`,
    cycleKey: `c${n}`,
    evidenceVersion: "v1",
    placement: "TODAY",
    dueOn: null,
    severity: "NORMAL",
    title: `item ${n}`,
    fact: `fact ${n}`,
    factAt: `2026-10-${String(10 + (n % 4)).padStart(2, "0")}T08:00:00.000Z`,
    action: { label: "go", href: `/x/${n}` },
    snooze: "STATE",
    ...over,
  };
}

function fixture(): AgendaInput {
  return {
    today: TODAY,
    now: NOW,
    doneToday: 2,
    syncFailed: true,
    tasks: [
      { id: 1, title: "t1", note: null, dueOn: "2026-10-13", pinned: true, version: 1, seriesId: null, sequence: null, cadence: null, link: null, createdAt: "2026-10-01T00:00:00.000Z" },
      { id: 2, title: "t2", note: null, dueOn: "2026-10-12", pinned: false, version: 1, seriesId: 5, sequence: 2, cadence: "כל יום שלישי", link: null, createdAt: "2026-10-01T00:00:00.000Z" },
      { id: 3, title: "t3", note: null, dueOn: "2026-10-04", pinned: false, version: 1, seriesId: null, sequence: null, cadence: null, link: null, createdAt: "2026-10-01T00:00:00.000Z" },
      { id: 4, title: "t4", note: null, dueOn: null, pinned: false, version: 1, seriesId: null, sequence: null, cadence: null, link: null, createdAt: "2026-10-01T00:00:00.000Z" },
      { id: 5, title: "t5", note: null, dueOn: "2026-10-17", pinned: false, version: 1, seriesId: null, sequence: null, cadence: null, link: null, createdAt: "2026-10-01T00:00:00.000Z" },
    ],
    repairs: [{ seriesId: 9, title: "r", dueOn: TODAY, cadence: "כל יום" }],
    results: [
      {
        kind: "supplier_payment", status: "OK", items: [
          item("supplier_payment", 1, { placement: "BY_DATE", dueOn: TODAY, reminderPostponed: { until: "2026-10-15" }, snooze: "PAYMENT", orderHint: 0 }),
          item("supplier_payment", 2, { placement: "BY_DATE", dueOn: "2026-10-11", reminderPostponed: { until: "2026-10-20" }, snooze: "PAYMENT", orderHint: 1 }),
        ],
      },
      { kind: "conversation", status: "OK", items: [1, 2, 3, 4, 5].map((n) => item("conversation", n, { severity: "HIGH" })) },
      { kind: "stock", status: "CAPPED", items: [1, 2, 3, 4].map((n) => item("stock", n, { placement: "NO_DATE" })) },
      { kind: "customer_debt", status: "OK", items: [1, 2, 3, 4].map((n) => item("customer_debt", n)) },
      { kind: "invoice_review", status: "OK", items: [1, 2, 3, 4].map((n) => item("invoice_review", n, { placement: "NO_DATE", factAt: null })) },
      { kind: "documents_queue", status: "FAILED", items: [] },
      { kind: "lead", status: "OK", items: [item("lead", 1, { placement: "BY_DATE", dueOn: "2026-10-16", snooze: "LEAD" })] },
    ],
    states: [
      // customer_debt 1..2 handled today on the same evidence → the queue comes back with "חדשים: N".
      ...[1, 2].map((n) => ({ dedupeKey: `customer_debt:${n}`, cycleKey: `c${n}`, evidenceVersion: "v1", acknowledgedOn: TODAY, ackEvidenceVersion: "v1", snoozedUntil: null, pinnedAt: null, dismissedAt: null })),
      { dedupeKey: "conversation:5", cycleKey: "c5", evidenceVersion: "v1", acknowledgedOn: null, ackEvidenceVersion: null, snoozedUntil: null, pinnedAt: "2026-10-13T00:00:00.000Z", dismissedAt: null },
    ],
  };
}

const RULES: SeriesRule[] = [
  { kind: "DAILY" },
  { kind: "WEEKDAYS", weekdays: [2] },
  { kind: "WEEKDAYS", weekdays: [4, 0] },
  { kind: "WEEKDAYS", weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...[0, 1, 3, 5, 6].map((d) => ({ kind: "WEEKDAYS" as const, weekdays: [d] })),
  { kind: "MONTH_DAY", monthDay: 15 },
  { kind: "MONTH_DAY", monthDay: 31 },
  { kind: "EVERY_N_DAYS", intervalDays: 3 },
];

const he = createTranslator(getMessages("he"));
const en = createTranslator(getMessages("en"));

/** Taken from the pre-i18n agenda-core.ts / task-core.ts for exactly these inputs. */
const LEGACY_AGENDA_SHA = "3fe6eea5250e5df6bb144739f7659a01c93f51bada724d22c6a7ef4bc0ec11d0";
/** Every queue title (n = 1 and 7) and the three overdue shapes, from the pre-i18n agenda-core.ts. */
const LEGACY_LABELS_SHA = "13611a26a86271e2e33c1f42dac322d4ad6f94eb4c23694f64b49c0df780d5f9";
const labels = (t?: typeof he) => [
  ...SOURCE_KINDS.flatMap((k) => [1, 7].map((n) => queueTitle(k, n, t))),
  ...["2026-10-13", "2026-10-12", "2026-09-14"].map((d) => overdueLabel(d, "2026-10-14", t)),
];
const LEGACY_CADENCE_SHA = "32bfd270dbc41cfc7f49329006910cfe393f147cf26d9ca3b8742dc141c5cadf";


console.log("Hebrew is byte-identical to the pre-i18n output");
{
  const agenda = buildAgenda(fixture());
  const cadences = RULES.map((r) => cadenceLabel(r));
  if (process.env.PRINT_LEGACY) console.log(JSON.stringify({ agenda: sha(agenda), cadence: sha(cadences) }));
  ok("agenda (default translator) = legacy", sha(agenda) === LEGACY_AGENDA_SHA, sha(agenda));
  ok("cadence (default translator) = legacy", sha(cadences) === LEGACY_CADENCE_SHA, sha(cadences));
  ok("queue titles + overdue labels (default) = legacy", sha(labels()) === LEGACY_LABELS_SHA, sha(labels()));
  ok("queue titles + overdue labels (explicit Hebrew) = legacy", sha(labels(he)) === LEGACY_LABELS_SHA);
  ok("agenda (explicit Hebrew) = legacy", sha(buildAgenda({ ...fixture(), t: he })) === LEGACY_AGENDA_SHA);
  ok("cadence (explicit Hebrew) = legacy", sha(RULES.map((r) => cadenceLabel(r, he))) === LEGACY_CADENCE_SHA);
}

console.log("English");
{
  const agenda = buildAgenda({ ...fixture(), t: en });
  const texts: string[] = [];
  for (const b of agenda.buckets) {
    texts.push(b.title);
    for (const r of b.rows) {
      for (const tag of r.tags) if (tag.tone !== "rep") texts.push(tag.text);
      if (r.type === "QUEUE") texts.push(r.title, r.fact, r.action.label);
    }
  }
  texts.push(...agenda.sources.map((s) => s.name));
  ok("every server-built agenda string is English", texts.length > 20 && texts.every((s) => !/[֐-׿]/.test(s)), texts.filter((s) => /[֐-׿]/.test(s)));
  ok("bucket titles", agenda.buckets.map((b) => b.title).join("|") === "Overdue|Today|No date|Later this week");
  const queue = agenda.buckets.flatMap((b) => b.rows).find((r) => r.type === "QUEUE" && r.sourceKind === "conversation");
  ok("queue title", queue?.type === "QUEUE" && queue.title === "4 conversations waiting for a reply", queue);
  const cadences = RULES.map((r) => cadenceLabel(r, en));
  ok("cadences are English", cadences.every((s) => !/[֐-׿]/.test(s)), cadences);
  ok("labels are English", labels(en).every((x) => !/[֐-׿]/.test(x)), labels(en));
  ok("cadence: one weekday", cadences[1] === "Every Tuesday", cadences[1]);
}

console.log("adapter templates (sources.ts) say what the old literals said");
{
  const cases: [string, string][] = [
    [he("system.tasks.supplier.wasDue", { date: "13.10" }), "היה אמור לצאת ב־13.10"],
    [he("system.tasks.supplier.notPaid"), "עדיין לא שולם"],
    [he("system.tasks.supplier.dueToday"), "לתשלום היום"],
    [he("system.tasks.supplier.dueOn", { date: "13.10" }), "לתשלום ב־13.10"],
    [he("system.tasks.supplier.remaining", { amount: "₪1,200" }), "נותרו ₪1,200"],
    [he("system.tasks.supplier.action"), "לתשלום"],
    [he("system.tasks.debt.title", { name: "דנה" }), "גבייה: דנה"],
    [he("system.tasks.debt.customerFallback"), "לקוח"],
    [he("system.tasks.debt.oneInvoice"), "חשבונית פתוחה אחת"],
    [he("system.tasks.debt.invoices", { n: 3 }), "3 חשבוניות פתוחות"],
    [he("system.tasks.debt.afterDue", { days: he("system.tasks.debt.oneDay") }), "יום אחד אחרי המועד"],
    [he("system.tasks.debt.afterDue", { days: he("system.tasks.debt.days", { n: 12 }) }), "12 יום אחרי המועד"],
    [he("system.tasks.debt.action"), "לתזכורת"],
    [he("system.tasks.invoiceReview.title", { number: "INV-7" }).replace(/\s+/g, " "), "חשבונית INV-7 ממתינה לבדיקה"],
    [he("system.tasks.invoiceReview.title", { number: "" }).replace(/\s+/g, " "), "חשבונית ממתינה לבדיקה"],
    [he("system.tasks.invoiceReview.created", { date: "13.10" }), "נוצרה 13.10"],
    [he("system.tasks.invoiceReview.action"), "לחשבונית"],
    [he("system.tasks.lead.unnamed"), "ליד ללא שם"],
    [he("system.tasks.lead.newMessage", { name: "דנה" }), "הודעה חדשה מדנה"],
    [he("system.tasks.lead.followUp", { name: "דנה" }), "מעקב: דנה"],
    [he("system.tasks.lead.newLead", { name: "דנה" }), "ליד חדש: דנה"],
    [he("system.tasks.lead.lastMessage", { when: "מאתמול" }), "הודעה אחרונה מאתמול"],
    [he("system.tasks.lead.plannedFor", { date: "13.10" }), "מעקב מתוכנן ל־13.10"],
    [he("system.tasks.lead.entered", { when: "לפני שעה" }), "נכנס לפני שעה"],
    [he("system.tasks.lead.toConversation"), "לשיחה"],
    [he("system.tasks.lead.toLead"), "לליד"],
    [he("system.tasks.conversation.waiting", { name: "דנה" }), "דנה מחכה לתשובה"],
    [he("system.tasks.conversation.channel.email"), "מייל"],
    [he("system.tasks.conversation.channel.phone"), "טלפון"],
    [he("system.tasks.conversation.channel.other"), "שיחה"],
    [he("system.tasks.conversation.fact", { channel: "WhatsApp", when: "ממש עכשיו" }), "WhatsApp · הודעה אחרונה ממש עכשיו"],
    [he("system.tasks.documents.one"), "מסמך אחד מחכה לבדיקה"],
    [he("system.tasks.documents.many", { n: 7 }), "7 מסמכים מחכים לבדיקה"],
    [he("system.tasks.documents.oldestToday"), "הוותיק הגיע היום"],
    [he("system.tasks.documents.oldestYesterday"), "הוותיק הגיע אתמול"],
    [he("system.tasks.documents.oldestDays", { n: 4 }), "הוותיק הגיע לפני 4 ימים"],
    [he("system.tasks.documents.action"), "לתור"],
    [he("system.tasks.stock.title", { name: "קמח", level: he("system.tasks.stock.critical") }), "קמח — מלאי קריטי"],
    [he("system.tasks.stock.title", { name: he("system.tasks.stock.itemFallback"), level: he("system.tasks.stock.low") }), "פריט — מלאי נמוך"],
    [he("system.tasks.stock.belowCritical"), "המלאי מתחת לסף הקריטי"],
    [he("system.tasks.stock.belowReorder"), "המלאי מתחת לסף ההזמנה"],
    [he("system.tasks.stock.action"), "להזמנה"],
    [he("system.tasks.relative.justNow"), "ממש עכשיו"],
    [he("system.tasks.relative.minutes", { n: 5 }), "לפני 5 דקות"],
    [he("system.tasks.relative.hour"), "לפני שעה"],
    [he("system.tasks.relative.hours", { n: 3 }), "לפני 3 שעות"],
    [he("system.tasks.relative.yesterday"), "מאתמול"],
    [he("system.tasks.relative.since", { date: "13.10" }), "מ־13.10"],
    [he("system.tasks.links.leadFallback"), "ליד"],
    [he("system.tasks.links.document", { id: 42 }), "מסמך 42"],
  ];
  for (const [actual, legacy] of cases) ok(`he: ${legacy}`, actual === legacy, actual);
}

console.log(`\n${checks - failed}/${checks} passed`);
if (failed) process.exit(1);
