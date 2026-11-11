#!/usr/bin/env node
/**
 * billing-protected-paths-guard.mjs — A0: the existing billing mechanism is not
 * changed by a pull request without it being visible.
 *
 * Owner directive 2026-11-05: the existing invoices / receipts / credit notes —
 * numbering, issuance, frozen snapshots, PDF, signing, payments and settlement,
 * allocation numbers and the uniform export — must not change as part of the
 * document-types expansion. This guard reports, on every pull request to main,
 * any change that touches them. It does not decide; it makes the change explicit.
 *
 * Checks (against the merge base with the PR's base branch):
 *   G1  a changed file (added / modified / deleted / renamed) under PROTECTED_PATHS;
 *   G2  a modified or deleted file under PROTECTED_BASELINES (added is allowed —
 *       a new baseline is reviewable, a rewritten one is not);
 *   G3  prisma/schema.prisma: any change inside a protected model / enum block
 *       (PROTECTED_SCHEMA_NAMES or a name starting with "Billing"), including a
 *       back-relation field added to it;
 *   G4  an added or modified migration.sql that mentions a protected table or
 *       type at all (ALTER, DROP, REFERENCES, TRIGGER, POLICY, GRANT, DML …) —
 *       comments are ignored.
 *       Narrow exception (owner instruction 2026-11-11): a mention is not reported when EVERY line of that migration
 *       that names the protected identifier is (a) a READ — to_regclass(…) or SELECT … FROM — with no write, DDL, grant
 *       or row-lock word on the line, (b) listed by the sha256 of its normalized text in READONLY_MENTIONS_FILE for that
 *       file and name, and (c) that entry carries the owner's approval (approvedBy + reference). A listed read without
 *       the approval is still reported ("pending"); any edit of the line or a new mention is reported as before. The
 *       billing module itself is never exempt (G1–G3 unchanged); only G4 reads the list.
 *
 * Scope: reporting only. It is not a required status check and changes no
 * branch protection; whether to make it required is the owner's decision.
 *
 *   node scripts/ci/billing-protected-paths-guard.mjs --base origin/main
 *   node scripts/ci/billing-protected-paths-guard.mjs --self-test
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export const READONLY_MENTIONS_FILE = "scripts/ci/billing-protected-paths-guard.readonly-mentions.json";
/** [{ file, name, lines: [{ sha256, text }], reason, approval: { approvedBy, approvedAt, reference } }] */
export function loadReadonlyMentions(file = READONLY_MENTIONS_FILE) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  } catch {
    return []; // unreadable → no exception at all (fail closed)
  }
}
export const normalizeSqlLine = (line) => line.replace(/\r/g, "").replace(/\s+/g, " ").trim();
export const sqlLineHash = (line) => createHash("sha256").update(normalizeSqlLine(line)).digest("hex");
const WRITE_OR_LOCK = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|REFERENCES|TRIGGER|POLICY|COPY|LOCK|SHARE|NOWAIT|EXECUTE|CALL|OWNER|RENAME|COMMENT|SECURITY)\b/i;
/** A line that only READS the protected identifier: an existence probe or a SELECT … FROM it, nothing else. */
export function isReadOnlyMention(line, name) {
  const l = normalizeSqlLine(line);
  if (WRITE_OR_LOCK.test(l)) return false;
  const q = "(?:public\\.)?\"?" + name + "\"?";
  const probe = new RegExp("to_regclass\\('" + q + "'\\)");
  const select = new RegExp("\\bFROM " + q + "(?: (?:AS )?\\w+)?(?:\\b|$)", "i");
  return probe.test(l) || (/\bSELECT\b/i.test(l) && select.test(l));
}

export const PROTECTED_PATHS = [
  "lib/services/billing/",
  "lib/billing/",
  "app/api/billing/",
  "app/billing/",
  "components/billing/",
  "lib/services/payments/",
  "app/api/payments/",
  "app/api/collection/",
  "app/api/reports/uniform/",
  "lib/services/financial-events/",
  "lib/pdf/",
];

export const PROTECTED_BASELINES = [".billing-a0/baseline/"];

/** Incoming-money and billing models/enums. Payables (Payment, PaymentAllocation, PaymentDestination…) are NOT here. */
export const PROTECTED_SCHEMA_NAMES = new Set([
  "FinancialEvent",
  "FinancialEventDirection",
  "FinancialEventSourceType",
  "FinancialEventStatus",
  "BusinessPaymentConnection",
  "PaymentDocumentIssuer",
  "PaymentRequest",
  "PaymentRequestStatus",
  "PaymentTransaction",
  "PaymentTransactionStatus",
  "PaymentProviderRouting",
  "PaymentWebhookEvent",
  "PaymentWebhookProcessingStatus",
  "PaymentAuditEvent",
  "PaymentProvider",
  "PaymentAccountingSettlement",
  "PaymentAccountingSettlementStatus",
  "PaymentMethod",
]);

export function isProtectedSchemaName(name) {
  return name.startsWith("Billing") || PROTECTED_SCHEMA_NAMES.has(name);
}

/** model / enum blocks of a Prisma schema: name → normalized body text. */
export function schemaBlocks(text) {
  const blocks = new Map();
  const re = /^(model|enum)\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m;
  while ((m = re.exec(text ?? ""))) {
    const body = m[3]
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").trim())
      .filter(Boolean)
      .join("\n");
    blocks.set(`${m[1]} ${m[2]}`, body);
  }
  return blocks;
}

export function schemaViolations(baseText, headText) {
  const out = [];
  const a = schemaBlocks(baseText);
  const b = schemaBlocks(headText);
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const name = key.split(" ")[1];
    if (!isProtectedSchemaName(name)) continue;
    if (!a.has(key)) out.push(`G3 prisma/schema.prisma: protected ${key} added`);
    else if (!b.has(key)) out.push(`G3 prisma/schema.prisma: protected ${key} removed`);
    else if (a.get(key) !== b.get(key)) out.push(`G3 prisma/schema.prisma: protected ${key} changed`);
  }
  return out;
}

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
}

/** Every protected identifier a migration mentions (quoted or bare, whole word). */
export function migrationViolations(file, sql, allow = loadReadonlyMentions()) {
  const body = stripSqlComments(sql);
  const hits = new Set();
  const re = /"?\b([A-Z][A-Za-z0-9_]*)\b"?/g;
  let m;
  while ((m = re.exec(body))) {
    if (isProtectedSchemaName(m[1])) hits.add(m[1]);
  }
  const out = [];
  for (const n of [...hits].sort()) {
    const word = new RegExp("\\b" + n + "\\b");
    const lines = body.split("\n").filter((l) => word.test(l));
    const entry = (Array.isArray(allow) ? allow : []).find((e) => e && e.file === file && e.name === n);
    const listed = new Set((entry?.lines ?? []).map((x) => x?.sha256));
    const allRead = lines.length > 0 && lines.every((l) => isReadOnlyMention(l, n) && listed.has(sqlLineHash(l)));
    const approved = Boolean(entry?.approval?.approvedBy?.trim() && entry?.approval?.reference?.trim());
    if (allRead && approved) continue;
    out.push(allRead
      ? `G4 ${file}: mentions protected "${n}" — read-only lines listed in ${READONLY_MENTIONS_FILE}, pending the owner's approval`
      : `G4 ${file}: mentions protected "${n}"`);
  }
  return out;
}

export function pathViolations(changes) {
  const out = [];
  for (const { status, path: p, from } of changes) {
    const touched = [p, from].filter(Boolean);
    for (const t of touched) {
      if (PROTECTED_PATHS.some((pre) => t.startsWith(pre))) {
        out.push(`G1 ${status} ${t}`);
        break;
      }
      if (PROTECTED_BASELINES.some((pre) => t.startsWith(pre)) && status !== "A") {
        out.push(`G2 ${status} ${t} (baselines are only ever added, never rewritten)`);
        break;
      }
    }
  }
  return out;
}

/** `git diff --name-status -M` → [{status, path, from?}] */
export function parseNameStatus(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const code = parts[0][0];
      if (code === "R" || code === "C") return { status: code, from: parts[1], path: parts[2] };
      return { status: code, path: parts[1] };
    });
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
}

function showOrNull(ref, file) {
  try {
    return git(["show", `${ref}:${file}`]);
  } catch {
    return null;
  }
}

function check(base) {
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  const changes = parseNameStatus(git(["diff", "--name-status", "-M", mergeBase, "HEAD"]));
  const violations = [...pathViolations(changes)];

  if (changes.some((c) => c.path === "prisma/schema.prisma")) {
    violations.push(...schemaViolations(showOrNull(mergeBase, "prisma/schema.prisma"), showOrNull("HEAD", "prisma/schema.prisma")));
  }
  for (const c of changes) {
    if ((c.status === "A" || c.status === "M" || c.status === "R") && /^prisma\/migrations\/.+\/migration\.sql$/.test(c.path)) {
      violations.push(...migrationViolations(c.path, showOrNull("HEAD", c.path) ?? ""));
    }
  }

  console.log(`billing-protected-paths-guard: ${changes.length} changed file(s) vs merge base ${mergeBase.slice(0, 12)}`);
  console.log(`protected paths: ${PROTECTED_PATHS.join(", ")}; baselines: ${PROTECTED_BASELINES.join(", ")}`);
  if (violations.length === 0) {
    console.log("PASS: no change to the existing billing mechanism");
    return 0;
  }
  console.log("FAIL: this pull request changes the existing billing mechanism — it needs the owner's explicit approval:");
  for (const v of violations) console.log(`FAIL: ${v}`);
  return 1;
}

function selfTest() {
  let pass = 0;
  const fails = [];
  const t = (name, cond) => (cond ? pass++ : fails.push(name));

  // G1 / G2
  const changes = parseNameStatus(
    [
      "M\tlib/services/billing/billing-issue.service.ts",
      "A\t.billing-a0/golden.test.ts",
      "A\t.billing-a0/baseline/new.json",
      "M\t.billing-a0/baseline/golden.json",
      "R100\tlib/billing/vat-rate.ts\tlib/other/vat-rate.ts",
      "A\tlib/services/operational-documents/core.ts",
      "D\tapp/api/payments/webhook/route.ts",
      "M\tlib/services/payables/payables-core.ts",
    ].join("\n")
  );
  const pv = pathViolations(changes);
  t("G1 modified billing service is reported", pv.some((v) => v.includes("billing-issue.service.ts")));
  t("G1 rename OUT of a protected path is reported", pv.some((v) => v.includes("lib/billing/vat-rate.ts")));
  t("G1 deleted payments route is reported", pv.some((v) => v.includes("app/api/payments/webhook/route.ts")));
  t("G2 rewritten baseline is reported", pv.some((v) => v.includes(".billing-a0/baseline/golden.json")));
  t("G2 added baseline is allowed", !pv.some((v) => v.includes("baseline/new.json")));
  t("new module outside billing is allowed", !pv.some((v) => v.includes("operational-documents")));
  t("payables are not billing", !pv.some((v) => v.includes("payables-core")));
  t("A0 test files are allowed", !pv.some((v) => v.includes(".billing-a0/golden.test.ts")));

  // G3
  const base = `model BillingDocument {\n  id Int @id\n  // note\n}\nenum BillingDocumentType {\n  TAX_INVOICE\n}\nmodel Payment {\n  id Int @id\n}\nmodel Other {\n  id Int @id\n}\n`;
  t("G3 identical schema passes", schemaViolations(base, base).length === 0);
  t("G3 comment-only change passes", schemaViolations(base, base.replace("// note", "// other note")).length === 0);
  t("G3 enum value added is reported", schemaViolations(base, base.replace("TAX_INVOICE\n", "TAX_INVOICE\n  ORDER\n")).some((v) => v.includes("enum BillingDocumentType")));
  t("G3 back-relation on BillingDocument is reported", schemaViolations(base, base.replace("id Int @id\n  // note", "id Int @id\n  links Link[]")).some((v) => v.includes("model BillingDocument")));
  t("G3 payables model change passes", schemaViolations(base, base.replace("model Payment {\n  id Int @id", "model Payment {\n  id Int @id\n  x Int")).length === 0);
  t("G3 unrelated model change passes", schemaViolations(base, base.replace("model Other {\n  id Int @id", "model Other {\n  id Int @id\n  y Int")).length === 0);
  t("G3 new protected model is reported", schemaViolations(base, base + "model BillingThing {\n  id Int @id\n}\n").some((v) => v.includes("BillingThing")));

  // G4
  t("G4 FK to BillingDocument is reported", migrationViolations("m.sql", 'ALTER TABLE "X" ADD CONSTRAINT x FOREIGN KEY ("d") REFERENCES "BillingDocument"("id");').length === 1);
  t("G4 enum value add is reported", migrationViolations("m.sql", `ALTER TYPE "BillingDocumentType" ADD VALUE 'ORDER';`).length === 1);
  t("G4 trigger on PaymentTransaction is reported", migrationViolations("m.sql", 'CREATE TRIGGER t AFTER INSERT ON "PaymentTransaction" FOR EACH ROW EXECUTE FUNCTION f();').length === 1);
  t("G4 mention only inside a comment passes", migrationViolations("m.sql", '-- unlike "BillingDocument", this table is separate\nCREATE TABLE "OperationalDocument" (id int);\n/* REFERENCES "BillingDocument" */').length === 0);
  t("G4 new unrelated table passes", migrationViolations("m.sql", 'CREATE TABLE "OperationalDocument" ("id" SERIAL PRIMARY KEY, "billingDocumentId" INTEGER);').length === 0);
  t("G4 payables table passes", migrationViolations("m.sql", 'ALTER TABLE "Payment" ADD COLUMN "x" int;').length === 0);
  // the narrow read-only exception (owner instruction 2026-11-11)
  const probeL = "  OR to_regclass('public.\"BillingDocument\"') IS NULL THEN";
  const selL = "  SELECT d.\"status\"::text INTO v FROM public.\"BillingDocument\" d";
  const sqlRO = "DO $$ BEGIN IF false\n" + probeL + "\nEND IF; END $$;\nCREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN\n" + selL + "\n WHERE d.id = 1; END $f$;";
  const okList = [{ file: "m.sql", name: "BillingDocument", lines: [{ sha256: sqlLineHash(probeL) }, { sha256: sqlLineHash(selL) }], approval: { approvedBy: "owner", reference: "issue#1" } }];
  const pendingList = [{ ...okList[0], approval: { approvedBy: "", reference: "" } }];
  const writeL = 'UPDATE "BillingDocument" SET x = 1;';
  t("G4 listed read-only lines with the owner's approval pass", migrationViolations("m.sql", sqlRO, okList).length === 0);
  t("G4 listed read-only lines without the approval are still reported (pending)", migrationViolations("m.sql", sqlRO, pendingList).some((v) => v.includes("pending")));
  t("G4 the list never applies to another file", migrationViolations("other.sql", sqlRO, okList).length === 1);
  t("G4 an edited listed line is reported again", migrationViolations("m.sql", sqlRO.replace("v FROM", "w FROM"), okList).length === 1);
  t("G4 one unlisted mention beside listed ones is reported", migrationViolations("m.sql", sqlRO + '\nALTER TABLE "BillingDocument" ADD COLUMN x int;', okList).length === 1);
  t("G4 writes and row locks are never read-only", !isReadOnlyMention(writeL, "BillingDocument") && !isReadOnlyMention('SELECT 1 FROM "BillingDocument" FOR UPDATE', "BillingDocument") && !isReadOnlyMention('INSERT INTO t SELECT * FROM "BillingDocument"', "BillingDocument") && !isReadOnlyMention('SELECT 1 FROM "BillingDocument" FOR SHARE', "BillingDocument"));
  t("G4 a listed write line is still reported", migrationViolations("m.sql", writeL, [{ file: "m.sql", name: "BillingDocument", lines: [{ sha256: sqlLineHash(writeL) }], approval: { approvedBy: "o", reference: "r" } }]).length === 1);
  t("G4 an unreadable list grants nothing", loadReadonlyMentions("does/not/exist.json").length === 0);

  console.log(`self-test: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log(`FAIL: ${f}`);
  return fails.length === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  process.exit(selfTest());
} else {
  const i = argv.indexOf("--base");
  const base = i >= 0 ? argv[i + 1] : "origin/main";
  process.exit(check(base));
}
