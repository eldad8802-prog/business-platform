/**
 * Documents producer — wiring and boundary locks.
 *
 * The integration suite proves what the notification layer believes once a sync
 * has run. It cannot prove where the sync is called from, that the aggregated
 * model was not quietly replaced by a per-document one, or that this producer
 * stayed out of Attention. Those are the mistakes that would look fine in a
 * passing integration run and be wrong in production.
 *
 * Run: npx tsx lib/notifications/documents-review-queue-notifications.verify.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PAPERWORK_PENDING_MIN } from "../business-status/paperwork-insight";
import { finalizeBusinessStatusItem } from "../business-status/priority";
import { translateDocumentsReviewQueue } from "../business-status/translators/documents";
import { pendingReviewInboxHref } from "../documents/pending-review";
import { decideNotification } from "./notification-policy";
import { DOCUMENTS_REVIEW_QUEUE_SCOPE } from "./documents-review-queue-notifications";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), "utf8");

const CONSUMER = read("lib", "notifications", "documents-review-queue-notifications.ts");
const TRANSLATOR = read("lib", "business-status", "translators", "documents.ts");
const BS_SERVICE = read("lib", "business-status", "business-status.service.ts");
const POLICY = read("lib", "notifications", "notification-policy.ts");
const PIPELINE = read("lib", "services", "documents", "process-document-pipeline.service.ts");
const APPROVE = read("app", "api", "documents", "[id]", "approve", "route.ts");
const PROCESS = read("app", "api", "documents", "[id]", "process", "route.ts");
const GMAIL = read("app", "api", "integrations", "gmail", "import", "route.ts");
const WA_INTAKE = read("lib", "services", "integrations", "whatsapp", "documents-intake.service.ts");
const PENDING = read("lib", "documents", "pending-review.ts");
const INSIGHT = read("lib", "business-status", "paperwork-insight.ts");

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

/** Comments explain intent; only code can be evidence of it. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("\nThe model is the QUEUE, not the document");
{
  const code = stripComments(CONSUMER);
  check("the scope owns exactly one entity type",
    DOCUMENTS_REVIEW_QUEUE_SCOPE.entityTypes.length === 1 &&
      DOCUMENTS_REVIEW_QUEUE_SCOPE.entityTypes[0] === "documents_review_queue",
    DOCUMENTS_REVIEW_QUEUE_SCOPE.entityTypes.join(","));
  check("the domain is documents", DOCUMENTS_REVIEW_QUEUE_SCOPE.domain === "documents");

  // A per-document producer is the thing this design exists to avoid.
  check("it never loads individual pending documents",
    !code.includes("loadDocumentsNeedsReview"));
  check("it never translates per-document facts",
    !code.includes("translateDocumentsNeedsReview"));
  check("it writes exactly one item per pass",
    /persistSnapshotNotifications\(businessId, \[item\], now\)/.test(code));
  check("the count comes from the canonical uncapped selector",
    code.includes("countPendingReviewAllTime"));
  check("it does not run its own count query", !code.includes("prisma."));
}

console.log("\nThreshold and destination are reused, not restated");
{
  const code = stripComments(CONSUMER);
  check("the threshold is imported from the ratified constant",
    code.includes("PAPERWORK_PENDING_MIN"));
  check("no second literal threshold is introduced",
    !/pendingCount\s*<\s*[0-9]/.test(code) && !/>=\s*[0-9]+\s*\)/.test(code));
  check("the ratified value is still five", PAPERWORK_PENDING_MIN === 5,
    String(PAPERWORK_PENDING_MIN));

  check("the destination comes from the shared helper",
    code.includes("pendingReviewInboxHref"));
  check("the helper is defined once, in the documents module",
    stripComments(PENDING).includes("export function pendingReviewInboxHref"));
  check("the Attention insight uses that same helper",
    stripComments(INSIGHT).includes("pendingReviewInboxHref(pendingMonths)"));
  check("no surface builds the month link by hand any more",
    !/\/documents\/inbox\?month=\$\{/.test(stripComments(INSIGHT)) &&
      !/\/documents\/inbox\?month=\$\{/.test(stripComments(CONSUMER)));

  // The helper's behaviour, since two surfaces now depend on it.
  check("it points at the newest month holding work",
    pendingReviewInboxHref(["2026-09", "2026-07"]) === "/documents/inbox?month=2026-09");
  check("with no pending month it falls back to the plain inbox",
    pendingReviewInboxHref([]) === "/documents/inbox");
}

console.log("\nThis producer is NOT a second Attention card");
{
  const code = stripComments(BS_SERVICE);
  check("the snapshot service does not import the queue translator",
    !code.includes("translateDocumentsReviewQueue"));
  check("the snapshot service does not call it",
    !/translateDocumentsReviewQueue\(/.test(code));
  check("Attention still builds documents from the per-document translator",
    code.includes("translateDocumentsNeedsReview"));
  check("the paperwork insight is still the backlog's Attention voice",
    code.includes("evaluatePaperworkInsight"));
}

console.log("\nResolution is a threshold, not an absence");
{
  const code = stripComments(CONSUMER);
  check("it never resolves from absence",
    !code.includes("resolveAbsentNotifications"));
  check("it never claims an exhaustive key set",
    !code.includes("declareExhaustive"));
  check("it closes by the queue's own identity",
    code.includes("resolveNotificationByDedupeKey"));
  check("the closing key is built by the policy, not hand-written",
    /queueDedupeKey|buildDedupeKey/.test(code));
  check("closing happens only below the threshold",
    /pendingCount < PAPERWORK_PENDING_MIN/.test(code));
}

console.log("\nEvery queue-count change has a post-commit producer");
{
  // The Gmail import is deliberately NOT a producer, and this pins that it
  // stays that way rather than being quietly added later.
  //
  // `integration-intake.verify.test.ts` holds a ratified lock — "creation still
  // triggers no approval or learning anywhere" — that forbids the string
  // "notification" on the Gmail route, alongside financialRecord, reviewEvent,
  // billingDocument, vendorLearning and supplier. Wiring the queue sync there
  // trips it. Renaming the import to dodge a substring check would be worse
  // than the gap, and weakening a lock from another programme is not this
  // task's call. The consequence is stated in the report: a Gmail import that
  // crosses the threshold waits for the next queue-changing event to surface.
  for (const [label, src, expect] of [
    ["the pipeline (needs_review and failed)", PIPELINE, 1],
    ["the approve route", APPROVE, 1],
    ["the retry route, which cannot change the queue", PROCESS, 0],
    ["the Gmail import stays OUT, per the ingestion lock", GMAIL, 0],
    ["the WhatsApp documents intake", WA_INTAKE, 1],
  ] as const) {
    const code = stripComments(src);
    const calls = (code.match(/syncDocumentsReviewQueueNotification\(/g) ?? []).length;
    check(`${label} syncs`, calls === expect, `${calls} call${calls === 1 ? "" : "s"}`);
  }

  // Ordering: the sync must follow the write, never precede it.
  const pipeline = stripComments(PIPELINE);
  check("the pipeline syncs in its finally, after both outcomes",
    pipeline.indexOf("} finally {") < pipeline.indexOf("syncDocumentsReviewQueueNotification("));
  const approve = stripComments(APPROVE);
  check("the approve route syncs after its transaction",
    approve.indexOf("status: \"approved\"") < approve.indexOf("syncDocumentsReviewQueueNotification("));

  // Tenant sources, per site.
  check("the pipeline uses its own server-derived businessId",
    pipeline.includes("syncDocumentsReviewQueueNotification(businessId,"));
  check("the approve route uses the session user",
    approve.includes("syncDocumentsReviewQueueNotification(user.businessId,"));
  // The retry route early-returns for anything already in review, so a document
  // in the queue can never leave it there. A sync would be a recount that is
  // provably a no-op, and code claiming to maintain a count it cannot change is
  // worse than no code.
  check("the retry route still refuses to touch a reviewed document",
    stripComments(PROCESS).includes(`document.status !== "processing" && document.status !== "failed"`));
  check("the Gmail ingestion lock is still intact",
    !stripComments(GMAIL).includes("notification"));
  check("the WhatsApp intake uses the server-resolved input",
    stripComments(WA_INTAKE).includes("syncDocumentsReviewQueueNotification(input.businessId,"));
  check("no site reads a businessId from a request body",
    ![APPROVE, PROCESS, GMAIL].some((s) => /body\.businessId/.test(stripComments(s))));
}

console.log("\nFailed documents did NOT become notifications");
{
  const code = stripComments(CONSUMER);
  check("the consumer never mentions the failed status", !/"failed"/.test(code));
  check("the policy has no documents failure rule",
    !/ruleKey\("documents", "FAILURE_EVENT"/.test(stripComments(POLICY)));
  check("only needs_review feeds the queue — via the shared selector",
    stripComments(PENDING).includes('PENDING_REVIEW_STATUS = "needs_review"'));
}

console.log("\nPolicy is unchanged and produces the expected decision");
{
  const item = finalizeBusinessStatusItem(
    translateDocumentsReviewQueue({
      businessId: 42,
      pendingCount: 17,
      href: "/documents/inbox?month=2026-09",
      now: new Date("2026-09-10T06:00:00.000Z"),
    }),
  );
  const decision = decideNotification(42, item, new Date("2026-09-10T06:00:00.000Z"));

  check("the fact is documents / ACTION_REQUIRED / MEDIUM",
    item.domain === "documents" && item.semanticCategory === "ACTION_REQUIRED" &&
      item.severity === "MEDIUM",
    `${item.domain}/${item.semanticCategory}/${item.severity}`);
  check("the policy notifies", decision.notify === true);
  check("IN_APP only", JSON.stringify(decision.channels) === '["IN_APP"]',
    JSON.stringify(decision.channels));
  check("no PUSH", !decision.channels.includes("PUSH"));
  check("cooldown is 72 hours", decision.cooldownHours === 72, String(decision.cooldownHours));
  check("the dedupe key is the business's queue",
    decision.dedupeKey === "b42:documents:ACTION_REQUIRED:documents_review_queue:42",
    decision.dedupeKey);
  check("the entity is the queue, not a document",
    item.entityRef.type === "documents_review_queue" && item.entityRef.id === 42);
  check("the count is in the title", item.title.startsWith("17 "), item.title);
  check("the summary makes no claim about what the documents say",
    item.summary !== null && !/₪|\d+\.\d/.test(item.summary), item.summary ?? "");

  // Quiet hours cannot matter for a rule that never had PUSH.
  const quiet = decideNotification(42, item, new Date("2026-09-10T20:00:00.000Z"));
  check("quiet hours change nothing for an in-app-only rule",
    JSON.stringify(quiet.channels) === '["IN_APP"]' && quiet.reason === decision.reason);
}

console.log("\nNo policy was added or changed");
{
  const code = stripComments(POLICY);
  check("the documents MEDIUM rule is the one that already existed",
    code.includes('[ruleKey("documents", "ACTION_REQUIRED", "MEDIUM")]') &&
      code.includes("cooldownHours: 72"));
  check("the unreachable HIGH rule is preserved, not fixed",
    code.includes('[ruleKey("documents", "ACTION_REQUIRED", "HIGH")]'));
  check("no EMAIL channel was introduced", !/["']EMAIL["']/.test(code));
  check("documents still grant no PUSH",
    !/ruleKey\("documents"[\s\S]{0,200}"PUSH"/.test(code));
}

console.log(
  failures === 0
    ? `\nDOCUMENTS PRODUCER WIRING: all checks passed\n`
    : `\nDOCUMENTS PRODUCER WIRING: ${failures} FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
