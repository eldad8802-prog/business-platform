/**
 * T1-ERASURE — the inbound sender authorisation list is actually erased, and the
 * claim that it is stays tied to code that does it.
 *
 * The failure this exists to prevent is a registry edit. `ERASURE_MANAGED` is a
 * promise to a person that their data is gone; flipping a disposition is one line
 * and proves nothing. So every assertion below runs from the ADAPTER SOURCE
 * outward: what it deletes, in which order, and with what scope — and only then
 * checks that the registry and the manifest agree with it.
 *
 * What this file deliberately does NOT claim:
 *
 *   * it does not prove rows disappear from a live database. That is the AD-2A
 *     battery's job, against real PostgreSQL under FORCE row-level security, and
 *     the assertions it must contain are themselves checked here
 *   * it does not close InboundEmailAddress, InboundEmailMessage or
 *     InboundEmailAttachmentImport. Those keep their recorded debt, and this file
 *     fails if somebody quietly promotes them
 *   * it says nothing about raw MIME in object storage, which no database
 *     erasure can reach
 *
 *   npx tsx lib/services/account/inbound-email-erasure.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { DELETE_MODELS, RETAIN_MODELS } from "./account-erasure-manifest";
import { MODEL_COVERAGE } from "../../../scripts/ci/erasure/erasure-model-coverage";
import { ACCEPTED_DEBT, debtKey } from "../../../scripts/ci/erasure/erasure-contract-debt";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const ADAPTER_PATH = "lib/services/account/account-deletion.prisma-store.ts";
const adapterRaw = read(ADAPTER_PATH);
const battery = read(".ad2a/battery.mjs");

/**
 * The adapter minus its commentary. This file's own subject matter is full of
 * sentences about deleting things, and a comment explaining why something is NOT
 * deleted must never read as deleting it.
 */
const adapter = adapterRaw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
  .join("\n");
const adapterLines = adapter.split("\n");

/** Line number of the first delete issued against a delegate, or -1. */
function deleteLine(delegate: string): number {
  return adapterLines.findIndex((l) => l.includes(`tx.${delegate}.deleteMany`));
}

const CLOSED = ["InboundEmailAuthorizedSender", "InboundEmailSenderChallenge"] as const;
const STILL_OPEN = ["InboundEmailAddress", "InboundEmailMessage", "InboundEmailAttachmentImport"] as const;
const delegateOf = (model: string) => model[0]!.toLowerCase() + model.slice(1);

let passed = 0;
let failed = 0;
function check(what: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}`);
    console.log(`        ${(error as Error).message.split("\n")[0]}`);
  }
}

console.log("\nT1-ERASURE — inbound email sender authorisation\n");

// ── 1. The adapter actually deletes ──────────────────────────────────────────

check("the adapter deletes both models on the erasure path", () => {
  for (const model of CLOSED) {
    assert.ok(
      deleteLine(delegateOf(model)) >= 0,
      `the adapter issues no deleteMany on ${model}, so ERASURE_MANAGED would be a promise with nothing behind it`
    );
  }
});

check("the child is deleted BEFORE the parent", () => {
  const child = deleteLine("inboundEmailSenderChallenge");
  const parent = deleteLine("inboundEmailAuthorizedSender");
  assert.ok(child >= 0 && parent >= 0, "both deletes must exist before their order means anything");
  assert.ok(
    child < parent,
    "challenges must be deleted before the senders they belong to; relying on the database cascade is the shape that failed silently for the conversation graph"
  );
});

// ── 2. Scope. An unscoped delete is a cross-tenant incident ──────────────────

check("every inbound delete is scoped to one business", () => {
  for (const model of CLOSED) {
    const line = adapterLines[deleteLine(delegateOf(model))]!;
    assert.ok(
      /deleteMany\(\{\s*where:\s*\{\s*businessId\s*\}\s*\}\)/.test(line),
      `${model} is deleted without a plain businessId scope: ${line.trim()}`
    );
  }
});

check("the adapter issues no unscoped deleteMany anywhere", () => {
  // `deleteMany()` and `deleteMany({})` both mean "every row in the table". Under
  // FORCE row-level security the tenant policy would still hold the blast radius,
  // but a delete whose correctness depends only on a GUC set three frames away is
  // not something this file is willing to certify.
  const offenders = adapterLines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /\.deleteMany\(\s*\)/.test(l) || /\.deleteMany\(\s*\{\s*\}\s*\)/.test(l))
    .map(({ l, i }) => `line ${i + 1}: ${l.trim()}`);
  assert.deepEqual(offenders, [], "an unscoped deleteMany is on the erasure path");
});

check("the deletes are state-convergent, so a repeated erasure is safe", () => {
  // deleteMany on an already-empty set is a no-op that reports zero. Nothing here
  // reads a count, branches on one, or deletes by id, so running the erasure twice
  // leaves exactly the same state as running it once.
  for (const model of CLOSED) {
    const line = adapterLines[deleteLine(delegateOf(model))]!;
    assert.ok(!/\bdelete\(/.test(line), `${model} is deleted by id, which is not idempotent`);
    assert.ok(!/findFirst|findUnique|count\(/.test(line), `${model} deletion reads state first`);
  }
});

// ── 3. The contract agrees with the code ─────────────────────────────────────

check("both deletes are declared in the manifest", () => {
  const declared = new Set<string>(DELETE_MODELS as readonly string[]);
  for (const model of CLOSED) {
    assert.ok(
      declared.has(delegateOf(model)) || declared.has(model),
      `${model} is deleted by the adapter and no contract declares it`
    );
  }
});

check("neither model is legally retained", () => {
  const retained = new Set<string>(RETAIN_MODELS as readonly string[]);
  for (const model of CLOSED) {
    assert.ok(
      !retained.has(delegateOf(model)) && !retained.has(model),
      `${model} is in both the retain set and the delete set`
    );
  }
});

check("both models are classified ERASURE_MANAGED", () => {
  for (const model of CLOSED) {
    const coverage = MODEL_COVERAGE[model];
    assert.ok(coverage, `${model} has no disposition at all`);
    assert.equal(
      coverage.disposition,
      "ERASURE_MANAGED",
      `${model} is deleted by the adapter but does not say so`
    );
  }
});

check("their accepted debt is gone, and only theirs", () => {
  const keys = new Set(ACCEPTED_DEBT.map((d) => debtKey(d)));
  for (const model of CLOSED) {
    const stale = [...keys].filter((k) => k.includes(model));
    assert.deepEqual(stale, [], `${model} still carries accepted debt it no longer owes`);
  }
  assert.equal(
    ACCEPTED_DEBT.length,
    63,
    `the ledger should hold exactly the 63 debts that predate T1-DB; it holds ${ACCEPTED_DEBT.length}`
  );
});

// ── 4. Scope discipline: what this increment must NOT have closed ────────────

check("the three older inbound models keep their recorded debt", () => {
  const keys = new Set(ACCEPTED_DEBT.map((d) => debtKey(d)));
  for (const model of STILL_OPEN) {
    assert.equal(
      MODEL_COVERAGE[model]?.disposition,
      "UNMANAGED_PERSONAL_DATA",
      `${model} was promoted, and nothing in this increment erases it`
    );
    assert.ok(
      [...keys].some((k) => k.includes(model)),
      `${model} lost its debt entry without gaining an erasure`
    );
  }
});

check("the adapter still does not touch the three older inbound models", () => {
  for (const model of STILL_OPEN) {
    assert.ok(
      !adapter.includes(`tx.${delegateOf(model)}.`),
      `the adapter operates on ${model}, which is still declared unmanaged`
    );
  }
});

check("raw MIME in object storage is not claimed to be erased", () => {
  // The honest boundary. `rawObjectKey` points OUTSIDE Postgres, so no adapter
  // statement can reach it, and this increment adds no object-store deletion.
  for (const marker of ["S3", "s3Client", "DeleteObject", "r2", "putObject", "deleteObject"]) {
    assert.ok(!adapter.includes(marker), `the erasure adapter reaches object storage (${marker})`);
  }
  assert.ok(
    !adapter.includes("rawObjectKey"),
    "the adapter names rawObjectKey, which would imply an external erasure it does not perform"
  );
});

// ── 5. The live proof exists where a live proof belongs ──────────────────────

check("the AD-2A battery seeds both tenants and proves the delete is scoped", () => {
  assert.ok(
    battery.includes("owner.inboundEmailAuthorizedSender.create"),
    "the battery does not seed an authorised sender, so its counts would pass vacuously"
  );
  assert.ok(
    battery.includes("owner.inboundEmailSenderChallenge.create"),
    "the battery does not seed a challenge"
  );
  for (const model of CLOSED) {
    const d = delegateOf(model);
    assert.ok(
      battery.includes(`owner.${d}.count({ where: { businessId: A.biz.id } })) === 0`),
      `the battery does not assert the deleted tenant's ${model} rows are gone`
    );
    assert.ok(
      battery.includes(`owner.${d}.count({ where: { businessId: B.biz.id } })) === 1`),
      `the battery does not assert the control tenant's ${model} rows survive`
    );
  }
});

// ── 6. Nothing else moved ────────────────────────────────────────────────────

check("this increment adds no migration and no schema change", () => {
  const dirs = fs
    .readdirSync(path.join(ROOT, "prisma/migrations"))
    .filter((d) => /^\d{14}_/.test(d))
    .sort();
  assert.equal(
    dirs[dirs.length - 1],
    "20260916090000_inbound_email_authorized_senders",
    "a migration landed after T1-DB; T1-ERASURE is runtime behaviour only"
  );
});

check("the inbound feature is still inert", () => {
  const flag = read("lib/inbound-email/inbound-email-flag.ts");
  assert.ok(/=== "true"/.test(flag), "the flag no longer requires the exact string true");
  for (const root of ["app", "components"]) {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(entry.name)) {
          const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
          for (const model of CLOSED) if (src.includes(`.${delegateOf(model)}.`)) hits.push(rel);
        }
      }
    };
    walk(root);
    assert.deepEqual(hits, [], `a runtime consumer of a T1 model appeared under ${root}/`);
  }
});

/**
 * STILL OPEN, and recorded here so the next increment inherits it rather than
 * rediscovering it:
 *
 *   * RAW MIME. `InboundEmailMessage.rawObjectKey` references an object outside
 *     Postgres. Deleting the row does not delete the object, so inbound erasure
 *     is not complete until an increment deletes both.
 *
 *   * THE IN-FLIGHT RACE. A message can already be sitting in the queue when a
 *     business is deleted. Nothing here prevents a worker from writing its
 *     personal data back afterwards, because no worker exists yet. Whatever
 *     consumes that queue MUST re-read the Business lifecycle at execution time
 *     and refuse a tenant that is DELETION_REQUESTED or PURGED. Checking it only
 *     when the message is enqueued is not enough, and this increment does not
 *     solve it.
 */

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
