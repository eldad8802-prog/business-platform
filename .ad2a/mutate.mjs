/**
 * AD-2A lab isolation — the mutation driver for the I-series negative proofs.
 *
 * Usage:  node .ad2a/mutate.mjs <I1|I2|I3|I4|I5|I6|I7|I9|I10|POISON|FB>
 *
 * Each mutation falsifies ONE assumption the hardened laboratory is supposed to
 * catch, and names the file it touches so the workflow can copy it first and prove a
 * byte-identical restore afterwards. Every anchor must occur EXACTLY once: a mutation
 * that silently fails to apply leaves the file unchanged, the proof then runs the
 * unmutated tree, and a "green" means nothing. That happened once while this
 * increment was being built, so here it is a hard error, and the workflow checks
 * `cmp` as well.
 *
 * This script only mutates. Restoring is the caller's job.
 */
import fs from "node:fs";

const CONTRACT = ".ad2a/production-contract.mjs";
const BATTERY = ".ad2a/battery.mjs";
const SCHEMA = "prisma/schema.prisma";

function replaceOnce(file, anchor, replacement) {
  const text = fs.readFileSync(file, "utf8");
  const n = text.split(anchor).length - 1;
  if (n !== 1) throw new Error(`${file}: anchor must occur exactly once, found ${n}: ${JSON.stringify(anchor.slice(0, 80))}`);
  fs.writeFileSync(file, text.replace(anchor, replacement));
}

/** Remove the contract entry whose `table:` is `name`, braces matched, trailing comma included. */
function dropContractEntry(name) {
  const text = fs.readFileSync(CONTRACT, "utf8");
  const anchor = `table: "${name}",`;
  const n = text.split(anchor).length - 1;
  if (n !== 1) throw new Error(`contract entry "${name}" must occur exactly once, found ${n}`);
  const at = text.indexOf(anchor);
  const start = text.lastIndexOf("{", at);
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) break;
  }
  let end = i + 1;
  while (/\s/.test(text[end])) end++;
  if (text[end] === ",") end++;
  fs.writeFileSync(CONTRACT, text.slice(0, start) + text.slice(end));
}

/** Insert lab SQL right after the contract is applied — the lab, not the contract, is falsified.
 *  `sqlExpr` is JavaScript source for the statement, so it can name the proof's own role. */
function afterContractApply(sqlExpr) {
  replaceOnce(
    BATTERY,
    "  await applyProductionContract(owner);\n",
    `  await applyProductionContract(owner);\n  await owner.$executeRawUnsafe(${sqlExpr});\n`
  );
}
/** A plain SQL string as JavaScript source. */
const js = (s) => JSON.stringify(s);

// S8 — the files the object-surface proofs falsify.
const ADAPTER = "lib/services/account/account-deletion.prisma-store.ts";
const COVERAGE = "scripts/ci/erasure/erasure-model-coverage.ts";
const SURFACES = "scripts/ci/erasure/erasure-object-surfaces.ts";

/** Remove one declared object surface, braces matched, trailing comma included. */
function dropObjectSurface(model, field) {
  const text = fs.readFileSync(SURFACES, "utf8");
  const anchor = `model: "${model}",`;
  let at = -1;
  for (let i = text.indexOf(anchor); i >= 0; i = text.indexOf(anchor, i + 1)) {
    const fieldAt = text.indexOf(`field: "${field}"`, i);
    const nextModel = text.indexOf(anchor, i + 1);
    if (fieldAt > i && (nextModel < 0 || fieldAt < nextModel)) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error(`no declared surface for ${model}.${field}`);
  const start = text.lastIndexOf("{", at);
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) break;
  }
  let end = i + 1;
  while (/\s/.test(text[end])) end++;
  if (text[end] === ",") end++;
  fs.writeFileSync(SURFACES, text.slice(0, start) + text.slice(end));
}

const MANIFEST = "lib/services/account/account-erasure-manifest.ts";

/** Remove one delegate from RETAIN_MODELS. */
function dropRetainEntry(delegate) {
  const text = fs.readFileSync(MANIFEST, "utf8");
  const re = new RegExp(`^[ \\t]*"${delegate}",\\r?\\n`, "m");
  if (!re.test(text)) throw new Error(`RETAIN_MODELS does not carry "${delegate}"`);
  fs.writeFileSync(MANIFEST, text.replace(re, ""));
}

/** Add a delegate to RETAIN_MODELS, right after the list opens. */
function addRetainEntry(delegate) {
  replaceOnce(MANIFEST, "export const RETAIN_MODELS = [", `export const RETAIN_MODELS = [\n  "${delegate}",`);
}

/** Add a column to a Prisma model, right after its opening line. */
function insertPrismaField(model, line) {
  const text = fs.readFileSync(SCHEMA, "utf8");
  const re = new RegExp(`(^model ${model} \\{\\r?\\n)`, "m");
  if (!re.test(text)) throw new Error(`no model ${model} in the schema`);
  fs.writeFileSync(SCHEMA, text.replace(re, `$1  ${line}\n`));
}

const MUTATIONS = {
  // A non-E1 table the erasure touches, dropped from the RLS contract.
  I1: () => dropContractEntry("Lead"),
  // A required runtime GRANT removed: CrmNote leaves the lab's broad grant.
  I2: () => replaceOnce(BATTERY, `"CrmNote","CrmAttachment"`, `"CrmAttachment"`),
  // A runtime GRANT nobody declared.
  I3: () => afterContractApply("`GRANT SELECT ON \"Deal\" TO ${RT_ROLE}`"),
  // A policy nobody declared — permissive, FOR DELETE, which is exactly the kind that matters.
  I4: () => afterContractApply(js(`CREATE POLICY ad2a_undeclared_delete ON "Customer" FOR DELETE USING (true)`)),
  // A policy's command changed in the contract: the pilot UPDATE policy becomes FOR ALL.
  // Located inside the Customer entry, independent of line endings.
  I5: () => {
    const text = fs.readFileSync(CONTRACT, "utf8");
    const entry = text.indexOf(`table: "Customer",`);
    const target = `name: "p7pilot_tenant_update", command: "UPDATE"`;
    const at = text.indexOf(target, entry);
    if (entry < 0 || at < 0 || at > text.indexOf(`table: "Appointment",`)) throw new Error("Customer update policy not found");
    fs.writeFileSync(CONTRACT, text.slice(0, at) + `name: "p7pilot_tenant_update", command: "ALL"` + text.slice(at + target.length));
  },
  // A predicate changed: OAuthToken's parent join compares the wrong column.
  I6: () =>
    replaceOnce(
      CONTRACT,
      `p."id" = "OAuthToken"."connectionId"`,
      `p."businessId" = "OAuthToken"."connectionId"`
    ),
  // FORCE broken on one table after the contract ran.
  I7: () => afterContractApply(js(`ALTER TABLE "Lead" NO FORCE ROW LEVEL SECURITY`)),
  // The two false greens Gate-0 reproduced, replayed under the hardened lab.
  I9: () => dropContractEntry("Conversation"),
  I10: () =>
    replaceOnce(
      BATTERY,
      'GRANT SELECT, INSERT, UPDATE ON "Notification","NotificationDelivery" TO ${RT_ROLE}',
      "SELECT 1"
    ),
  // I8: leave a lab full of state a later proof must not inherit — an undeclared
  // DELETE policy and a dropped FORCE, both at once.
  POISON: () => {
    afterContractApply(js(`ALTER TABLE "Lead" NO FORCE ROW LEVEL SECURITY`));
    afterContractApply(js(`CREATE POLICY ad2a_undeclared_delete ON "Customer" FOR DELETE USING (true)`));
  },
  // Fiscal Claim B: the citing key stops being RESTRICT — it CASCADEs, so deleting the
  // cited Document succeeds and takes the fiscal record with it. Red on every server
  // version (the refusal disappears), not only where SQLSTATEs differ. Schema text only.
  FB: () =>
    replaceOnce(
      SCHEMA,
      "document  Document?  @relation(fields: [businessId, documentId], references: [businessId, id], onDelete: Restrict)",
      "document  Document?  @relation(fields: [businessId, documentId], references: [businessId, id], onDelete: Cascade)"
    ),

  // ── S8: the external-object dimension ───────────────────────────────────
  //
  // Each of these falsifies one thing the object contract claims. The point of the
  // contract is that an object surface cannot go quiet — not by being undeclared, not
  // by the model becoming ERASURE_MANAGED, and not by a model-level finding resolving.

  /** S1 — the CrmAttachment surface declaration disappears while the column still exists. */
  S1: () => dropObjectSurface("CrmAttachment", "storageKey"),

  /** S2 — the adapter stops deleting the object and goes back to deleting only the row. */
  S2: () => {
    const text = fs.readFileSync(ADAPTER, "utf8");
    // Everything from the S8 block's own header up to the transaction that follows it:
    // two anchors that each occur once, so line endings and reflowing cannot break it.
    const start = text.indexOf("        // ── S8. THE OBJECTS GO FIRST");
    const end = text.indexOf("        return withTenantTransaction(", start + 1);
    if (start < 0 || end < 0) throw new Error("the S8 object-first block is not where it was");
    fs.writeFileSync(ADAPTER, text.slice(0, start) + text.slice(end));
  },

  /** S3 — InventoryItem's MODEL-level C12 is resolved. Its image surface must survive that. */
  S3: () => {
    replaceOnce(
      ADAPTER,
      "          await tx.crmAttachment.deleteMany({ where: { businessId } });",
      '          await tx.inventoryItem.updateMany({ where: { businessId }, data: { supplierName: null } });\n' +
        "          await tx.crmAttachment.deleteMany({ where: { businessId } });"
    );
    replaceOnce(
      COVERAGE,
      '  InventoryItem: unmanaged("supplierName, a denormalised copy of a Supplier name"),',
      '  InventoryItem: { disposition: "ERASURE_MANAGED" },'
    );
  },

  /** S4 — the InventoryItem image surface declaration is removed. */
  S4: () => dropObjectSurface("InventoryItem", "imageUrl"),

  /** S5 — a new owned-object pointer column arrives with no declaration at all. */
  S5: () => insertPrismaField("CrmNote", "receiptImageUrl String?"),

  // ── R1…R8: the retention contract ───────────────────────────────────────
  //
  // Retention is declared in two places on purpose. These prove the pair cannot drift
  // apart again in either direction, and that the manifest's safety guard can no
  // longer certify itself from an incomplete list.

  /** R1 — a retained model disappears from the manifest while the registry keeps it. */
  R1: () => dropRetainEntry("document"),

  /** R2 — the manifest claims a model the registry does not classify as retained. */
  R2: () => addRetainEntry("customer"),

  /** R3 — the registry stops retaining a model the manifest still retains. */
  // An inline literal, not the `unmanaged()` helper: that helper is declared further
  // down the file, so calling it here would fail on the temporal dead zone instead of
  // on the contract, and the proof would be about module evaluation order.
  R3: () =>
    replaceOnce(
      COVERAGE,
      '  Payment: FISCAL("bookkeeping evidence that money left the business"),',
      '  Payment: { disposition: "UNMANAGED_PERSONAL_DATA", surface: "payeeNameSnapshot and voidReason", target: "E2" },'
    ),

  /** R4 — a NEW retained registry entry arrives with no manifest counterpart. */
  R4: () =>
    replaceOnce(
      COVERAGE,
      '  ReceivingLine: operational("quantities received against a purchase-order line"),',
      '  ReceivingLine: FISCAL("newly declared retained, with no manifest entry"),'
    ),

  /** R5 — a retained model is placed in the delete set. */
  R5: () => replaceOnce(MANIFEST, "export const DELETE_MODELS = [", 'export const DELETE_MODELS = [\n  "document",'),

  /** R6 — a retained model is placed in the anonymise set. */
  R6: () =>
    replaceOnce(
      MANIFEST,
      "export const ANONYMIZE_MODELS = [",
      'export const ANONYMIZE_MODELS = [\n  { model: "document", fields: { fileUrl: "null" } },'
    ),

  /** R7 — a retained model is placed in the revoke set (rows deleted on revoke). */
  R7: () =>
    replaceOnce(
      MANIFEST,
      "export const REVOKE_INTEGRATIONS = [",
      'export const REVOKE_INTEGRATIONS = [\n  { model: "document", deleteRow: true },'
    ),

  /** R8 — one of the five synchronised payables entries is removed again. */
  R8: () => dropRetainEntry("payment"),
};

const id = process.argv[2];
if (!MUTATIONS[id]) {
  console.error(`usage: node .ad2a/mutate.mjs <${Object.keys(MUTATIONS).join("|")}>`);
  process.exit(2);
}
MUTATIONS[id]();
console.log(`[mutate] applied ${id}`);
