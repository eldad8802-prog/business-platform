/**
 * Inbox producer — wiring and boundary locks.
 *
 * The integration test proves what the notification layer believes once a sync
 * has run. It cannot prove WHERE the sync is called from, and that placement is
 * the part most likely to be quietly broken later: moved inside a transaction
 * for convenience, dropped from one of the two close routes, or handed a
 * businessId out of a request body.
 *
 * These checks read the merged sources. They are deliberately narrow — each one
 * names a mistake that would be invisible in a passing integration run.
 *
 * Run: npx tsx lib/notifications/inbox-waiting-notifications.verify.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decideNotification } from "./notification-policy";
import { INBOX_WAITING_SCOPE } from "./inbox-waiting-notifications";
import { translateAttentionWaiting } from "../business-status/translators/attention";
import { finalizeBusinessStatusItem } from "../business-status/priority";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), "utf8");

const CONSUMER = read("lib", "notifications", "inbox-waiting-notifications.ts");
// M2: the WhatsApp intake processor (the only producer of inbound customer
// messages besides the dev-only simulator).
const INTAKE = read("lib", "intake", "whatsapp", "whatsapp-intake.ts");
// M3: the provider-neutral processor sequences route → enrich → markProcessed.
const PROCESSOR = read("lib", "intake", "core", "processor.ts");
const MESSAGE_ROUTE = read("app", "api", "message", "route.ts");
const CLOSE_A = read("app", "api", "conversation", "[id]", "route.ts");
const CLOSE_B = read("app", "api", "conversation", "[id]", "close", "route.ts");
const POLICY = read("lib", "notifications", "notification-policy.ts");
const WRITER = read("lib", "notifications", "notification-writer.ts");
const FACTS = read("lib", "notifications", "exhaustive-facts.ts");
const INVENTORY = read("lib", "notifications", "inventory-alert-notifications.ts");

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

/** Comments explain intent; only code can be evidence of it. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("\nThe consumer owns no business rules");
{
  const code = stripComments(CONSUMER);
  check("truth comes from the business-status loader, not a local query",
    code.includes("loadAttentionWaitingForConversation") && !code.includes("prisma."));
  check("the item is built by the shared translator",
    code.includes("translateAttentionWaiting") && code.includes("finalizeBusinessStatusItem"));
  check("the decision is left to the policy — no severity is chosen here",
    !/severity/i.test(code) && !/"HIGH"/.test(code));
  check("no channel is chosen here", !/IN_APP|PUSH|EMAIL/.test(code));
  check("no cooldown is invented here", !/cooldown/i.test(code));
  check("persistence goes through the shared writer",
    code.includes("persistSnapshotNotifications") && code.includes("resolveNotificationByDedupeKey"));
  check("the dedupe key comes from the policy, not a local string",
    code.includes("buildDedupeKey"));
}

console.log("\nResolution is entity-scoped, not absence-based");
{
  const code = stripComments(CONSUMER);
  check("the scope is still declared as the inbox domain", INBOX_WAITING_SCOPE.domain === "inbox");
  check("it owns exactly the conversation entity type",
    INBOX_WAITING_SCOPE.entityTypes.length === 1 && INBOX_WAITING_SCOPE.entityTypes[0] === "conversation",
    INBOX_WAITING_SCOPE.entityTypes.join(","));

  // The defect. A capped presentation loader must never decide what to close.
  check("it does NOT resolve from absence",
    !code.includes("resolveAbsentNotifications"));
  check("it does NOT read the capped presentation loader",
    !/loadAttentionWaiting\(/.test(code));
  check("it never claims a set is exhaustive",
    !code.includes("declareExhaustive"));

  check("the sync names the conversation it is reconciling",
    /export async function syncInboxWaitingNotifications\(\s*businessId: number,\s*conversationId: number,/.test(code));
  check("resolution asks about that conversation and no other",
    code.includes("loadAttentionWaitingForConversation(businessId, conversationId)"));
  check("a null answer is what closes it — positive evidence, not a missing row",
    /row === null/.test(code) && code.includes("resolveNotificationByDedupeKey"));
  check("the closing key is rebuilt by the policy, never hand-written",
    /resolveNotificationByDedupeKey\(\s*businessId,\s*buildDedupeKey\(/.test(code));
  check("the key it closes is the conversation it was given",
    /entityRef: \{ type: "conversation", id: conversationId \}/.test(code));
}

console.log("\nFailure isolation");
{
  const code = stripComments(CONSUMER);
  check("the whole sync body is wrapped in try/catch", /try\s*\{[\s\S]*\}\s*catch/.test(code));
  check("a failure is returned as data, never thrown", code.includes("ok: false") && !/throw /.test(code));
  check("the failure is still reported to the server log", code.includes("console.error"));
}

console.log("\nOpening producer sits after the commit");
{
  const code = stripComments(INTAKE);
  check("the intake calls the sync", code.includes("syncInboxWaitingNotifications"));
  // The pipeline is a sequence of transactions; syncing before it finishes
  // would persist a notification for a state that has not settled.
  const pipelineAt = code.indexOf("runInboundMessagePipeline({");
  const syncAt = code.indexOf("syncInboxWaitingNotifications(");
  check("it runs AFTER the inbound pipeline, not before",
    pipelineAt > 0 && syncAt > pipelineAt, `pipeline@${pipelineAt} sync@${syncAt}`);
  const txAt = code.lastIndexOf("withTenantTransaction", syncAt);
  const txCloses = code.slice(txAt, syncAt).includes("runInboundMessagePipeline");
  check("it is NOT nested inside one of the intake's transactions", txCloses);
  // Exactly one call site, on the success path. The failure branch lives in the
  // catch below and must not sync: nothing settled, and the receipt is retried.
  check("there is exactly one sync call in the intake",
    (code.match(/syncInboxWaitingNotifications\(/g) ?? []).length === 1);
  // M3: the sync lives in the WhatsApp adapter's enrich(); the processor calls
  // enrich() inside its try, after PERSISTED and before PROCESSED. A failure in
  // enrich() lands in the processor's catch, which never calls enrich again.
  const proc = stripComments(PROCESSOR);
  const enrichDef = code.indexOf("async enrich(");
  const enrichCall = proc.indexOf("await adapter.enrich(");
  const procCatch = proc.indexOf("} catch (error)");
  check("it is on the success path, not in the failure catch",
    syncAt > 0 && enrichDef > 0 && syncAt > enrichDef && enrichCall > 0 && enrichCall < procCatch &&
      (proc.match(/adapter\.enrich\(/g) ?? []).length === 1,
    `sync@${syncAt} enrich@${enrichDef} call@${enrichCall} catch@${procCatch}`);
  check("it runs before the receipt is marked processed",
    enrichCall > proc.indexOf("await markPersisted(") &&
      enrichCall < proc.indexOf("await markProcessed(businessId, event.id, legacyRefs(routed.refs))"));
  check("the businessId is the server-resolved argument, never a payload field",
    code.includes("syncInboxWaitingNotifications(businessId,") && !/payload\.businessId/.test(code));
  check("and it names the conversation it just wrote to",
    code.includes("syncInboxWaitingNotifications(businessId, context.conversation.id") &&
      code.includes("conversation: ingested.conversation"));
}

console.log("\nMessage route syncs the business reply");
{
  const code = stripComments(MESSAGE_ROUTE);
  const calls = code.match(/syncInboxWaitingNotifications\(/g) ?? [];
  // M2: the route writes business messages only (a reply resolves the wait).
  // The inbound side OPENS the wait in the intake processor, checked above.
  check("the one success path syncs", calls.length === 1, `n=${calls.length}`);
  check("the tenant is the session user, never the request body",
    !/syncInboxWaitingNotifications\((?!user\.businessId)/.test(code));
  check("the call names the conversation",
    (code.match(/syncInboxWaitingNotifications\(user\.businessId, conversationId,/g) ?? []).length === 1);
  check("the route can no longer write a customer message",
    !/senderType:\s*body\./.test(code) && !/direction:\s*body\./.test(code) &&
      code.includes('direction: "OUTBOUND"') && code.includes('senderType: "BUSINESS_USER"'));
  check("the route never trusts a body businessId",
    !/body\.businessId/.test(code));
  check("the handler still runs under the session tenant context",
    code.includes("runWithTenantContext({ businessId: user.businessId }"));
  // Each call must follow its message write, not precede it.
  const createAt = code.indexOf("tx.message.create({");
  check("the first sync comes after the message is created",
    createAt > 0 && code.indexOf("syncInboxWaitingNotifications(") > createAt);
}

console.log("\nEvery conversation-close path resolves");
{
  for (const [label, src] of [["POST /api/conversation/[id]", CLOSE_A], ["POST .../close", CLOSE_B]] as const) {
    const code = stripComments(src);
    check(`${label} syncs after closing`, code.includes("syncInboxWaitingNotifications"));
    // tenantTx closes its context with its transaction, so the sync needs its own.
    check(`${label} re-enters the tenant context`,
      code.includes("runWithTenantContext({ businessId: user.businessId }"));
    check(`${label} syncs AFTER the close transaction`,
      code.indexOf("tenantTx(") < code.indexOf("syncInboxWaitingNotifications("));
    check(`${label} derives the tenant from the session`,
      code.includes("getCurrentUser") && !/params.*businessId/.test(code));
    check(`${label} names the conversation it closed`,
      code.includes("syncInboxWaitingNotifications(user.businessId, conversationId,"));
  }
}

console.log("\nPolicy is unchanged and produces the expected decision");
{
  // Built from the real translator so the fact under test is the real one.
  const item = finalizeBusinessStatusItem(
    translateAttentionWaiting([
      {
        conversationId: 77,
        customerName: "Dana",
        channel: "WHATSAPP",
        snippet: "היי",
        relevantAt: new Date("2026-09-10T06:00:00.000Z"),
        conversationCreatedAt: new Date("2026-09-10T05:00:00.000Z"),
        hasPendingSuggestion: false,
      },
    ])[0]!,
  );
  const decision = decideNotification(42, item, new Date("2026-09-10T06:00:00.000Z"));

  check("the waiting fact is inbox / ACTION_REQUIRED / HIGH",
    item.domain === "inbox" && item.semanticCategory === "ACTION_REQUIRED" && item.severity === "HIGH",
    `${item.domain}/${item.semanticCategory}/${item.severity}`);
  check("the policy notifies", decision.notify === true);
  check("IN_APP only", JSON.stringify(decision.channels) === '["IN_APP"]', JSON.stringify(decision.channels));
  check("no PUSH", !decision.channels.includes("PUSH"));
  check("cooldown is twelve hours", decision.cooldownHours === 12, String(decision.cooldownHours));
  check("the dedupe key is the conversation",
    decision.dedupeKey === "b42:inbox:ACTION_REQUIRED:conversation:77", decision.dedupeKey);
  check("the entity is the conversation, not a message",
    item.entityRef.type === "conversation" && item.entityRef.id === 77);
  check("the link is the inbox", item.primaryAction.href === "/inbox");

  // Quiet hours must not matter for a rule that never had PUSH to lose.
  const quiet = decideNotification(42, item, new Date("2026-09-10T20:00:00.000Z")); // 23:00 Jerusalem
  check("quiet hours change nothing for an in-app-only rule",
    JSON.stringify(quiet.channels) === '["IN_APP"]' && quiet.reason === decision.reason,
    quiet.reason);
}

console.log("\nAbsence-based resolution requires an exhaustive set");
{
  const writer = stripComments(WRITER);
  const facts = stripComments(FACTS);
  const inventory = stripComments(INVENTORY);

  check("the resolver's parameter type carries the requirement",
    /present: ExhaustiveFactKeys/.test(writer));
  check("a plain string array can no longer reach it",
    !/presentDedupeKeys: string\[\]/.test(writer));
  check("there is a single-entity resolver for callers that know the entity",
    /export async function resolveNotificationByDedupeKey/.test(writer));

  check("the brand is compile-time only — it is never written into the object",
    facts.includes("as unknown as ExhaustiveFactKeys") && !/\[EXHAUSTIVE\]: true,/.test(facts));
  check("the exhaustive inventory selector has no take/limit",
    /findMany\(\{[\s\S]*?where: \{ businessId, isResolved: false \}[\s\S]*?\}\)/.test(facts) &&
      !/take:/.test(facts));
  check("it selects identity columns only, not a render payload",
    /select: \{ id: true, type: true, itemId: true \}/.test(facts));

  check("the inventory consumer resolves from the uncapped selector",
    inventory.includes("loadAllUnresolvedInventoryAlertIdentities"));
  check("it does NOT resolve from the capped loader's items",
    !/resolveAbsentNotifications\([\s\S]{0,200}items\.map/.test(inventory));
  check("it still PRESENTS from the capped loader — the cap is not the bug",
    inventory.includes("loadInventoryAlertsUnresolved"));
  check("both halves use the same translator, so identity cannot drift",
    (inventory.match(/translateInventoryAlerts\(/g) ?? []).length === 2);
}

console.log("\nThis task changed no policy");
{
  const code = stripComments(POLICY);
  check("the inbox rule is exactly the one that already existed",
    code.includes('[ruleKey("inbox", "ACTION_REQUIRED", "HIGH")]') && code.includes("cooldownHours: 12"));
  check("no inbox rule was added for MEDIUM",
    !code.includes('[ruleKey("inbox", "ACTION_REQUIRED", "MEDIUM")]'));
  check("no EMAIL channel was introduced", !/["']EMAIL["']/.test(code));
  check("the push-eligible set still excludes inbox",
    !/ruleKey\("inbox"[\s\S]{0,200}"PUSH"/.test(code));
}

console.log(
  failures === 0
    ? `\nINBOX PRODUCER WIRING: all checks passed\n`
    : `\nINBOX PRODUCER WIRING: ${failures} FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
