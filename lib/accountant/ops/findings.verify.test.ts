/**
 * Accountant package monitor — pure rules (run: npx tsx lib/accountant/ops/findings.verify.test.ts).
 *
 * Every finding fires on its fault and only on it; a healthy state fires nothing; thresholds sit where the
 * comments say; the alert email names codes, scopes and times — never an address, a link or a business name;
 * the digest key is stable for the same claims and different for different ones; counts stay counts.
 */

import { digestKey, renderDigest, scopeLabelHe } from "./alert-email";
import type { Claim } from "./alert-store";
import {
  businessFindings,
  FINDING_SPECS,
  PLATFORM_CODES,
  platformFindings,
  REMINDABLE_CODES,
  type BusinessFacts,
  type DeliveryFact,
  type PlatformFacts,
} from "./findings";
import { countsOnly, runSourceOf } from "./runs";

let failed = 0;
function ok(name: string, condition: boolean, detail = "") {
  if (!condition) {
    console.error("FAIL:", name, detail);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const H = 60 * 60 * 1000;
const NOW = new Date("2026-10-28T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const codes = (fs: { code: string; subjectKey: string }[]) => fs.map((f) => `${f.code}@${f.subjectKey}`).sort().join(",");

// ── platform ──
const plat = (over: Partial<PlatformFacts> = {}): PlatformFacts => ({
  now: NOW,
  sweepEnabled: true,
  sweepRuns: [{ kind: "SWEEP", startedAt: ago(30 * 60 * 1000), finishedAt: ago(29 * 60 * 1000), outcome: "OK" }],
  firstMonitorRunAt: ago(30 * 24 * H),
  businessesFailed: 0,
  budgetExhausted: false,
  ...over,
});
ok("platform: a recent good sweep → nothing", platformFindings(plat()).length === 0);
ok("platform: one late run (last start 2h ago) → nothing yet",
  platformFindings(plat({ sweepRuns: [{ kind: "SWEEP", startedAt: ago(2 * H), finishedAt: ago(2 * H - 60_000), outcome: "OK" }] })).length === 0);
ok("platform: no run for 2h15m → SWEEP_MISSED",
  codes(platformFindings(plat({ sweepRuns: [{ kind: "SWEEP", startedAt: ago(2 * H + 16 * 60_000), finishedAt: ago(2 * H), outcome: "OK" }] }))) === "SWEEP_MISSED@-");
ok("platform: never a run, monitor watching for 3h → SWEEP_MISSED (neverRecorded)",
  platformFindings(plat({ sweepRuns: [], firstMonitorRunAt: ago(3 * H) }))[0]?.detail.neverRecorded === true);
ok("platform: never a run, monitor just deployed → nothing (no false alarm on day one)",
  platformFindings(plat({ sweepRuns: [], firstMonitorRunAt: ago(10 * 60_000) })).length === 0 && platformFindings(plat({ sweepRuns: [], firstMonitorRunAt: null })).length === 0);
ok("platform: sweep switched off → no sweep finding at all",
  platformFindings(plat({ sweepEnabled: false, sweepRuns: [] })).length === 0);
const failedRuns = platformFindings(plat({
  sweepRuns: [
    { kind: "SWEEP", startedAt: ago(10 * 60_000), finishedAt: ago(9 * 60_000), outcome: "FAILED" },
    { kind: "SWEEP", startedAt: ago(70 * 60_000), finishedAt: ago(69 * 60_000), outcome: "FAILED" },
    { kind: "SWEEP", startedAt: ago(130 * 60_000), finishedAt: ago(129 * 60_000), outcome: "OK" },
  ],
}));
ok("platform: the latest run failed → SWEEP_FAILED, counting the failures in a row", codes(failedRuns) === "SWEEP_FAILED@-" && failedRuns[0].detail.failedInARow === 2);
ok("platform: a run RUNNING for 11 min (killed) → SWEEP_FAILED neverFinished",
  platformFindings(plat({ sweepRuns: [{ kind: "SWEEP", startedAt: ago(11 * 60_000), finishedAt: null, outcome: "RUNNING" }] }))[0]?.detail.neverFinished === true);
ok("platform: a run RUNNING for 2 min (in progress) → nothing",
  platformFindings(plat({ sweepRuns: [{ kind: "SWEEP", startedAt: ago(2 * 60_000), finishedAt: null, outcome: "RUNNING" }] })).length === 0);
ok("platform: a business could not be evaluated → MONITOR_INCOMPLETE", codes(platformFindings(plat({ businessesFailed: 1 }))) === "MONITOR_INCOMPLETE@-");
ok("platform: the time budget ran out → MONITOR_INCOMPLETE", codes(platformFindings(plat({ budgetExhausted: true }))) === "MONITOR_INCOMPLETE@-");

// ── per business ──
const delivery = (over: Partial<DeliveryFact>): DeliveryFact => ({
  id: 1,
  periodId: 10,
  status: "ACCEPTED",
  failureCode: null,
  approvedAt: ago(48 * H),
  nextAttemptAt: null,
  leaseUntil: null,
  acceptedAt: ago(47 * H),
  updatedAt: ago(47 * H),
  ...over,
});
const biz = (over: Partial<BusinessFacts> = {}): BusinessFacts => ({
  now: NOW,
  sweepEnabled: true,
  webhookConfigured: false,
  latestKey: "2026-09",
  periods: [{ id: 10, periodKey: "2026-09", status: "READY_FOR_REVIEW", evaluatedAt: ago(2 * H) }],
  buildingPackages: [],
  deliveries: [],
  complainedDeliveryIds: [],
  ...over,
});
ok("business: prepared, nothing sent → nothing", businessFindings(biz()).length === 0);
ok("business: a delivered send → nothing", businessFindings(biz({ periods: [{ id: 10, periodKey: "2026-09", status: "SENT", evaluatedAt: ago(H) }], deliveries: [delivery({ status: "DELIVERED" })] })).length === 0);
ok("business: no period after the 2nd 06:00 → PACKAGE_NOT_PREPARED", codes(businessFindings(biz({ periods: [] }))) === "PACKAGE_NOT_PREPARED@p:2026-09");
ok("business: still PREPARING after the deadline → PACKAGE_NOT_PREPARED",
  codes(businessFindings(biz({ periods: [{ id: 10, periodKey: "2026-09", status: "PREPARING", evaluatedAt: null }] }))) === "PACKAGE_NOT_PREPARED@p:2026-09");
ok("business: no period on the 1st (before the deadline) → nothing",
  businessFindings(biz({ periods: [], now: new Date("2026-10-01T10:00:00.000Z") })).length === 0);
ok("business: sweep off → no 'not prepared'", businessFindings(biz({ periods: [], sweepEnabled: false })).length === 0);
ok("business: PREPARATION_FAILED for 4h → PREPARATION_FAILED",
  codes(businessFindings(biz({ periods: [{ id: 10, periodKey: "2026-09", status: "PREPARATION_FAILED", evaluatedAt: ago(4 * H) }] }))) === "PREPARATION_FAILED@p:2026-09");
ok("business: PREPARATION_FAILED for 1h (one retry pending) → nothing",
  businessFindings(biz({ periods: [{ id: 10, periodKey: "2026-09", status: "PREPARATION_FAILED", evaluatedAt: ago(H) }] })).length === 0);
ok("business: a build BUILDING for 2h → PREPARATION_STUCK",
  codes(businessFindings(biz({ buildingPackages: [{ periodId: 10, createdAt: ago(2 * H) }] }))) === "PREPARATION_STUCK@p:2026-09");
ok("business: a build BUILDING for 5 min → nothing", businessFindings(biz({ buildingPackages: [{ periodId: 10, createdAt: ago(5 * 60_000) }] })).length === 0);
ok("business: an approved retry 3h late → RETRY_OVERDUE",
  codes(businessFindings(biz({ deliveries: [delivery({ id: 4, status: "APPROVED", nextAttemptAt: ago(3 * H), acceptedAt: null })] }))) === "RETRY_OVERDUE@d:4");
ok("business: an approved send due in the future → nothing",
  businessFindings(biz({ deliveries: [delivery({ id: 4, status: "APPROVED", nextAttemptAt: new Date(NOW.getTime() + H), acceptedAt: null })] })).length === 0);
ok("business: SENDING 1h past its lease → SEND_STUCK",
  codes(businessFindings(biz({ deliveries: [delivery({ id: 5, status: "SENDING", leaseUntil: ago(H), acceptedAt: null })] }))) === "SEND_STUCK@d:5");
ok("business: SENDING within its lease → nothing",
  businessFindings(biz({ deliveries: [delivery({ id: 5, status: "SENDING", leaseUntil: new Date(NOW.getTime() + 60_000), acceptedAt: null })] })).length === 0);
const failedPeriod = [{ id: 10, periodKey: "2026-09" as const, status: "SEND_FAILED", evaluatedAt: ago(H) }];
ok("business: the latest send timed out on every attempt → SEND_UNCERTAIN (not DELIVERY_FAILED)",
  codes(businessFindings(biz({ periods: failedPeriod, deliveries: [delivery({ id: 6, status: "FAILED", failureCode: "timeout_max_attempts", acceptedAt: null })] }))) === "SEND_UNCERTAIN@d:6");
ok("business: the latest send refused → DELIVERY_FAILED",
  codes(businessFindings(biz({ periods: failedPeriod, deliveries: [delivery({ id: 7, status: "FAILED", failureCode: "rejected_422", acceptedAt: null })] }))) === "DELIVERY_FAILED@d:7");
ok("business: the latest send bounced → DELIVERY_BOUNCED",
  codes(businessFindings(biz({ periods: failedPeriod, deliveries: [delivery({ id: 8, status: "BOUNCED" })] }))) === "DELIVERY_BOUNCED@d:8");
ok("business: a failed send followed by a newer successful one → nothing (the owner already re-sent)",
  businessFindings(biz({ periods: [{ id: 10, periodKey: "2026-09", status: "SENT", evaluatedAt: ago(H) }],
    deliveries: [delivery({ id: 7, status: "FAILED", failureCode: "rejected_422" }), delivery({ id: 9, status: "DELIVERED" })] })).length === 0);
ok("business: a failed send of a month completed manually → nothing",
  businessFindings(biz({ periods: [{ id: 10, periodKey: "2026-09", status: "COMPLETED_MANUALLY", evaluatedAt: ago(H) }],
    deliveries: [delivery({ id: 7, status: "FAILED", failureCode: "timeout_max_attempts" })] })).length === 0);
ok("business: a canceled newer approval does not hide the failed one",
  codes(businessFindings(biz({ periods: failedPeriod, deliveries: [delivery({ id: 7, status: "FAILED", failureCode: "rejected_422" }), delivery({ id: 11, status: "CANCELED" })] }))) === "DELIVERY_FAILED@d:7");
ok("business: a spam complaint → DELIVERY_COMPLAINED (status untouched)",
  codes(businessFindings(biz({ periods: [{ id: 10, periodKey: "2026-09", status: "SENT", evaluatedAt: ago(H) }], deliveries: [delivery({ id: 3, status: "DELIVERED" })], complainedDeliveryIds: [3, 3] }))) === "DELIVERY_COMPLAINED@d:3");
ok("business: webhook on, accepted 30h ago with no event → WEBHOOK_SILENT",
  codes(businessFindings(biz({ webhookConfigured: true, deliveries: [delivery({ id: 2, acceptedAt: ago(30 * H) })] }))) === "WEBHOOK_SILENT@d:2");
ok("business: webhook on, accepted 5 days ago (before the webhook) → nothing",
  businessFindings(biz({ webhookConfigured: true, deliveries: [delivery({ id: 2, acceptedAt: ago(5 * 24 * H) })] })).length === 0);
ok("business: webhook off → no WEBHOOK_SILENT", businessFindings(biz({ deliveries: [delivery({ id: 2, acceptedAt: ago(30 * H) })] })).length === 0);

// ── specs ──
ok("specs: the complaint does not remind; everything else does",
  !REMINDABLE_CODES.includes("DELIVERY_COMPLAINED") && REMINDABLE_CODES.length === Object.keys(FINDING_SPECS).length - 1);
ok("specs: three platform codes", PLATFORM_CODES.length === 3 && PLATFORM_CODES.every((c) => c in FINDING_SPECS));
ok("specs: every code fits the alert table's CHECK", Object.keys(FINDING_SPECS).every((c) => /^[A-Z][A-Z0-9_]{2,47}$/.test(c)));
const detailRe = /^[A-Za-z0-9_:.-]{0,64}$/;
const all = [
  ...platformFindings(plat({ businessesFailed: 2, sweepRuns: [{ kind: "SWEEP", startedAt: ago(3 * H), finishedAt: null, outcome: "RUNNING" }] })),
  ...businessFindings(biz({ periods: failedPeriod, webhookConfigured: true, buildingPackages: [{ periodId: 10, createdAt: ago(3 * H) }],
    deliveries: [delivery({ id: 6, status: "FAILED", failureCode: "timeout_max_attempts" }), delivery({ id: 2, periodId: 12, acceptedAt: ago(30 * H) })], complainedDeliveryIds: [2] })),
];
ok("specs: every subject and detail fits the tables' CHECKs (no text can reach them)",
  all.length >= 6 && all.every((f) => /^(-|[a-z]:[A-Za-z0-9_-]{1,40})$/.test(f.subjectKey) &&
    Object.values(f.detail).every((v) => typeof v !== "string" || detailRe.test(v))), codes(all));

// ── the email ──
const claim = (over: Partial<Claim>): Claim => ({
  scope: { kind: "business", businessId: 9 },
  alertId: 1,
  code: "DELIVERY_BOUNCED",
  subjectKey: "d:12",
  severity: "HIGH",
  detail: {},
  openedAt: ago(2 * H),
  kind: "open",
  notifyCount: 1,
  claimedAt: NOW,
  previousNotifiedAt: null,
  ...over,
});
const claims = [
  claim({}),
  claim({ alertId: 2, scope: { kind: "platform" }, code: "SWEEP_MISSED", subjectKey: "-", severity: "CRITICAL", kind: "reminder", notifyCount: 3 }),
  claim({ alertId: 3, code: "PREPARATION_FAILED", subjectKey: "p:2026-09", kind: "resolved" }),
];
const mail = renderDigest(claims, "https://app.example.com");
ok("email: subject counts new / reminders / resolved", mail.subject.includes("1 חדשות") && mail.subject.includes("1 תזכורות") && mail.subject.includes("1 נפתרו"), mail.subject);
ok("email: scopes are ids and subjects only", scopeLabelHe(claims[0]) === "עסק #9 · שליחה #12" && scopeLabelHe(claims[1]) === "פלטפורמה" && mail.text.includes("חודש 2026-09"));
ok("email: critical first, resolved last", mail.text.indexOf("לא רצה") < mail.text.indexOf("חזר") && mail.text.indexOf("חזר") < mail.text.indexOf("נכשלת"));
ok("email: links only to the admin page", (mail.text.match(/https?:\/\/\S+/g) ?? []).every((u) => u === "https://app.example.com/admin/accountant-ops"));
ok("email: no address, no portal link, no token", !/@/.test(mail.text) && !/\/a\//.test(mail.text) && !/@/.test(mail.html.replace(/<[^>]+>/g, "")));
ok("email: the html escapes", renderDigest([claim({ code: "<script>" })], "https://app.example.com").html.includes("&lt;script&gt;"));
const many = Array.from({ length: 40 }, (_, i) => claim({ alertId: 100 + i }));
ok("email: at most 25 lines, the rest counted", renderDigest(many, "https://app.example.com").text.includes("ועוד 15"));
ok("email: simulation says it is a test", renderDigest([claim({ code: "SIMULATION" })], "https://x.example", { simulation: true }).text.includes("הודעת בדיקה"));
ok("digest key: same claims in any order → same key", digestKey(claims) === digestKey([...claims].reverse()));
ok("digest key: a reminder count changes the key", digestKey(claims) !== digestKey([claims[0], { ...claims[1], notifyCount: 4 }, claims[2]]));
ok("digest key: fits the provider's limit", digestKey(many).length <= 64 && digestKey(many).startsWith("acctops:"));

// ── run log helpers ──
ok("runs: GET is Vercel Cron, POST is GitHub", runSourceOf("GET") === "VERCEL_CRON" && runSourceOf("POST") === "GITHUB_ACTIONS");
const c = countsOnly({ a: 1, b: true, s: "x@y.z", arr: [1], nested: { ok: 2, bad: "t" }, "bad key": 3, nan: Number.NaN });
ok("runs: counts keep numbers and booleans only", JSON.stringify(c) === JSON.stringify({ a: 1, b: true, nested: { ok: 2 } }), JSON.stringify(c));

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nops findings: all checks passed");
process.exit(0);
