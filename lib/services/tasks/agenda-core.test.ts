/**
 * Daily Tasks — the agenda's pure rules (Daily Tasks spec 7, 8.2, 8.5, 8.7). No DB, no network, no clock.
 *
 *   Buckets (7.1): overdue / today / no date / the next 7 days; only overdue + today are counted.
 *   Grouping (4.4): more than 3 items of one source in one bucket become one queue row — never supplier payments
 *     or leads; a pinned item stays its own row; queue members are counted one by one.
 *   Cap (7.4): at most 12 rows shown per counted bucket, the count stays complete.
 *   Display state (8.5): "handled for today" holds today and only while the evidence is the same; a display snooze
 *     holds until its day; a new cycle never inherits state.
 *   Mute (8.2): a conversation is muted when a lead row shows the same customer.
 *   Integrity (8.7): COMPLETE only with every source OK and no pending repair; the empty state only then.
 *   A postponed supplier-payment reminder stays visible AND counted, at the end of its bucket (3.5).
 *
 * Run: npx tsx lib/services/tasks/agenda-core.test.ts
 */
import {
  applyDisplayState,
  bucketFor,
  buildAgenda,
  muteDuplicates,
  overdueLabel,
  type AgendaInput,
  type ManualTask,
  type SourceItem,
  type SourceKind,
  type SourceResult,
  type StoredState,
} from "./agenda-core";

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

const TODAY = "2026-10-13";
const NOW = new Date("2026-10-13T09:00:00.000Z");

let seq = 0;
function item(kind: SourceKind, over: Partial<SourceItem> = {}): SourceItem {
  seq += 1;
  return {
    sourceKind: kind,
    dedupeKey: `${kind}:${seq}`,
    cycleKey: `c${seq}`,
    evidenceVersion: "v1",
    placement: "BY_DATE",
    dueOn: TODAY,
    severity: "NORMAL",
    title: `${kind} ${seq}`,
    fact: "",
    factAt: `2026-10-0${(seq % 9) + 1}T08:00:00.000Z`,
    action: { label: "פתח", href: "/x" },
    snooze: "STATE",
    ...over,
  };
}
function task(over: Partial<ManualTask> = {}): ManualTask {
  seq += 1;
  return { id: seq, title: `t${seq}`, note: null, dueOn: TODAY, pinned: false, version: 1, seriesId: null, sequence: null, cadence: null, link: null, createdAt: NOW.toISOString(), ...over };
}
const ok_ = (kind: SourceKind, items: SourceItem[]): SourceResult => ({ kind, status: "OK", items });
function input(over: Partial<AgendaInput> = {}): AgendaInput {
  return { today: TODAY, now: NOW, tasks: [], repairs: [], results: [], states: [], doneToday: 0, syncFailed: false, ...over };
}
const bucket = (a: ReturnType<typeof buildAgenda>, b: string) => a.buckets.find((x) => x.bucket === b)!;

console.log("buckets");
ok("an overdue day → OVERDUE", bucketFor("BY_DATE", "2026-10-10", TODAY) === "OVERDUE");
ok("today → TODAY", bucketFor("BY_DATE", TODAY, TODAY) === "TODAY");
ok("no date → NO_DATE", bucketFor("BY_DATE", null, TODAY) === "NO_DATE");
ok("in 7 days → UPCOMING", bucketFor("BY_DATE", "2026-10-20", TODAY) === "UPCOMING");
ok("in 8 days → not shown", bucketFor("BY_DATE", "2026-10-21", TODAY) === null);
ok("placement TODAY without a day → TODAY", bucketFor("TODAY", null, TODAY) === "TODAY");
ok("placement NO_DATE ignores the day", bucketFor("NO_DATE", "2026-10-01", TODAY) === "NO_DATE");
ok("overdue labels: יום / יומיים / N ימים", [overdueLabel("2026-10-12", TODAY), overdueLabel("2026-10-11", TODAY), overdueLabel("2026-10-10", TODAY)].join("|") === "באיחור יום|באיחור יומיים|באיחור 3 ימים");

console.log("counting");
{
  const a = buildAgenda(input({
    tasks: [task({ dueOn: "2026-10-11" }), task(), task({ dueOn: null }), task({ dueOn: "2026-10-15" })],
  }));
  ok("only overdue + today are counted", a.count === 2, a.count);
  ok("each bucket holds its own", ["OVERDUE", "TODAY", "NO_DATE", "UPCOMING"].map((b) => bucket(a, b).items).join(",") === "1,1,1,1");
}

console.log("grouping");
{
  const convs = [1, 2, 3, 4, 5].map(() => item("conversation", { placement: "TODAY", dueOn: null }));
  const pays = [1, 2, 3, 4, 5].map(() => item("supplier_payment"));
  const leads = [1, 2, 3, 4].map(() => item("lead"));
  const a = buildAgenda(input({ results: [ok_("conversation", convs), ok_("supplier_payment", pays), ok_("lead", leads)] }));
  const today = bucket(a, "TODAY");
  ok("5 conversations → one queue row", today.rows.filter((r) => r.type === "QUEUE").length === 1);
  ok("supplier payments are never grouped", today.rows.filter((r) => r.type === "SOURCE" && r.item.sourceKind === "supplier_payment").length === 5);
  ok("leads are never grouped", today.rows.filter((r) => r.type === "SOURCE" && r.item.sourceKind === "lead").length === 4);
  ok("queue members are counted one by one", a.count === 14, a.count);
  const three = buildAgenda(input({ results: [ok_("stock", [1, 2, 3].map(() => item("stock", { placement: "NO_DATE", dueOn: null })))] }));
  ok("3 of a source stay separate rows", bucket(three, "NO_DATE").rows.every((r) => r.type === "SOURCE"));
  const pinnedConv = convs[0];
  const pinned = buildAgenda(input({
    results: [ok_("conversation", convs)],
    states: [{ dedupeKey: pinnedConv.dedupeKey, cycleKey: pinnedConv.cycleKey, evidenceVersion: "v1", acknowledgedOn: null, ackEvidenceVersion: null, snoozedUntil: null, pinnedAt: NOW.toISOString(), dismissedAt: null }],
  }));
  const pt = bucket(pinned, "TODAY").rows;
  ok("a pinned item stays its own row, first", pt[0].type === "SOURCE" && pt[0].key === pinnedConv.dedupeKey && pt[0].pinned);
  ok("…and the other 4 still group", pt.filter((r) => r.type === "QUEUE").length === 1);
}

console.log("cap");
{
  const many = Array.from({ length: 20 }, () => task());
  const a = buildAgenda(input({ tasks: many }));
  const t = bucket(a, "TODAY");
  ok("12 rows shown, all 20 sent", t.shown === 12 && t.total === 20 && t.rows.length === 20);
  ok("the count is complete (20)", a.count === 20);
}

console.log("display state");
{
  const it = item("conversation", { placement: "TODAY", dueOn: null, evidenceVersion: "m1" });
  const ack: StoredState = { dedupeKey: it.dedupeKey, cycleKey: it.cycleKey, evidenceVersion: "m1", acknowledgedOn: TODAY, ackEvidenceVersion: "m1", snoozedUntil: null, pinnedAt: null, dismissedAt: null };
  ok("handled for today, same evidence → hidden", applyDisplayState([it], [ack], TODAY, NOW).length === 0);
  ok("T-C1: new evidence → back at once", applyDisplayState([{ ...it, evidenceVersion: "m2" }], [ack], TODAY, NOW).length === 1);
  ok("handled yesterday → back today", applyDisplayState([it], [{ ...ack, acknowledgedOn: "2026-10-12" }], TODAY, NOW).length === 1);
  ok("a new cycle never inherits the state", applyDisplayState([{ ...it, cycleKey: "other" }], [ack], TODAY, NOW).length === 1);
  const sn: StoredState = { ...ack, acknowledgedOn: null, ackEvidenceVersion: null, snoozedUntil: "2026-10-15T00:00:00.000Z" };
  ok("a display snooze hides until its day", applyDisplayState([it], [sn], TODAY, NOW).length === 0);
  ok("…and not after it", applyDisplayState([it], [sn], TODAY, new Date("2026-10-15T06:00:00.000Z")).length === 1);
  ok("a domain-slot item ignores a display snooze", applyDisplayState([{ ...it, snooze: "LEAD" }], [sn], TODAY, NOW).length === 1);
}

console.log("mute");
{
  const lead = item("lead", { customerId: 7 });
  const conv = item("conversation", { customerId: 7, placement: "TODAY", dueOn: null });
  const other = item("conversation", { customerId: 8, placement: "TODAY", dueOn: null });
  const out = muteDuplicates([lead, conv, other].map((i) => ({ item: i, pinned: false })));
  ok("S16 muted when S14 shows the same customer", out.length === 2 && !out.some((v) => v.item === conv));
}

console.log("postponed payment reminder");
{
  const due = item("supplier_payment", { dueOn: "2026-10-10", reminderPostponed: { until: "2026-10-14" } });
  const other = item("supplier_payment", { dueOn: "2026-10-12" });
  const a = buildAgenda(input({ results: [ok_("supplier_payment", [due, other])] }));
  const rows = bucket(a, "OVERDUE").rows;
  ok("still visible and counted", a.count === 2);
  ok("at the end of its bucket, dimmed", rows[rows.length - 1].key === due.dedupeKey && rows[rows.length - 1].type === "SOURCE");
  const tags = rows[rows.length - 1].type === "SOURCE" ? (rows[rows.length - 1] as { tags: { text: string }[] }).tags.map((t) => t.text) : [];
  ok("tagged 'התזכורת נדחתה למחר · עדיין לא שולם'", tags.includes("התזכורת נדחתה למחר · עדיין לא שולם"), tags);
}

console.log("integrity");
{
  const complete = buildAgenda(input({ results: [ok_("stock", [])] }));
  ok("all OK, nothing pending → COMPLETE, empty allowed", complete.integrity.join() === "COMPLETE" && complete.emptyAllowed);
  const failedSrc = buildAgenda(input({ results: [{ kind: "stock", status: "FAILED", items: [] }] }));
  ok("a failed source → PARTIAL, count partial, no empty state", failedSrc.integrity.includes("PARTIAL") && failedSrc.countPartial && !failedSrc.emptyAllowed);
  const capped = buildAgenda(input({ results: [{ kind: "lead", status: "CAPPED", items: [] }] }));
  ok("a capped source → PARTIAL", capped.integrity.includes("PARTIAL") && !capped.emptyAllowed);
  const repair = buildAgenda(input({ repairs: [{ seriesId: 1, title: "x", dueOn: TODAY, cadence: "כל יום" }] }));
  ok("T-Y1: a missing occurrence → REPAIR_PENDING, counted, marked 'מתעדכנת…'", repair.integrity.join() === "REPAIR_PENDING" && repair.count === 1 && bucket(repair, "TODAY").rows[0].type === "REPAIR");
  const both = buildAgenda(input({ syncFailed: true, repairs: [{ seriesId: 1, title: "x", dueOn: TODAY, cadence: null }], results: [{ kind: "stock", status: "FAILED", items: [] }] }));
  ok("T-Y8: every applicable state at once, empty blocked", ["REPAIR_PENDING", "PARTIAL", "SYNC_FAILED"].every((i) => both.integrity.includes(i as never)) && !both.emptyAllowed);
  const disabled = buildAgenda(input({ results: [{ kind: "stock", status: "DISABLED", items: [] }] }));
  ok("a source the owner switched off is not a failure", disabled.integrity.join() === "COMPLETE");
}

console.log(`\nagenda core: ${checks - failed}/${checks} checks hold.`);
if (failed > 0) {
  console.error(`${failed} FAILED`);
  process.exit(1);
}
