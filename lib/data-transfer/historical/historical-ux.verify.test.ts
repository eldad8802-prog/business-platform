/**
 * I-8B.6 — the owner-facing surface of the historical fiscal flow.
 *
 * # What this verifier is for
 *
 * The engine's guarantees are already proven. What was NOT proven before this
 * increment is that an owner can be shown those guarantees without being lied
 * to. Three failures are possible here and none of them would break a build:
 *
 *   a code the engine emits has no owner wording, and renders as nothing
 *   a screen decides something the server is supposed to decide
 *   the wording implies Dubiz issued a document, or that an override repairs one
 *
 * So the checks below read the ENGINE'S OWN unions out of its source and demand
 * an owner sentence for every member, then read the screens and demand that
 * authority stayed on the server.
 *
 * Run: npx tsx lib/data-transfer/historical/historical-ux.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ACTION_BUTTON,
  ACTION_HELP,
  ACTION_LABEL,
  BLOCKING_REASON_TEXT,
  DATABASE_DUPLICATE_TEXT,
  DOCUMENT_TYPE_LABEL,
  DUBIZ_ORIGIN_BADGE,
  DUPLICATE_ERROR_TEXT,
  DUPLICATE_WARNING_TEXT,
  EXTERNAL_ORIGIN_BADGE,
  EXTERNAL_ORIGIN_EXPLANATION,
  FACT_LABEL,
  FAILURE_TEXT,
  IN_FILE_DUPLICATE_TEXT,
  MAPPING_BLOCKER_TEXT,
  MAPPING_STATUS_LABEL,
  NOT_READY_TEXT,
  REVERSAL_TARGET_TEXT,
  REVERSAL_TEXT,
  ROW_ERROR_TEXT,
  ROW_RESULT_TEXT,
  ROW_STATE_LABEL,
  ROW_WARNING_TEXT,
  documentTypeLabel,
  failureText,
} from "@/lib/data-transfer/historical/historical-owner-language";
import { HISTORICAL_TYPE_LABELS } from "@/lib/data-transfer/historical/historical-vocabulary";

let passed = 0;
const failures: string[] = [];

function check(label: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`FAIL  ${label} — ${(error as Error).message}`);
  }
}

/** Source, comment-free and NUL-free, so a guard never fires on prose. */
function codeOf(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\u0000/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * The members of a string-literal union, read out of the engine's own source.
 *
 * The point is that this list is NOT maintained here. A code added to the engine
 * appears in this list on the next run, and the completeness check below fails
 * until somebody writes the owner a sentence about it.
 */
function unionMembers(file: string, typeName: string): string[] {
  const src = codeOf(file);
  const start = src.indexOf(`export type ${typeName} =`);
  assert.notEqual(start, -1, `type ${typeName} not found in ${file}`);
  const end = src.indexOf(";", start);
  assert.notEqual(end, -1, `type ${typeName} is not terminated in ${file}`);
  const body = src.slice(start, end);
  const members = [...body.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  assert.ok(members.length > 0, `no members parsed for ${typeName}`);
  return members;
}

/** Field names of an object type, read out of source the same way. */
function objectFields(file: string, typeName: string): string[] {
  const src = codeOf(file);
  const start = src.indexOf(`export type ${typeName} =`);
  assert.notEqual(start, -1, `type ${typeName} not found in ${file}`);
  const open = src.indexOf("{", start);
  const close = src.indexOf("};", open);
  const body = src.slice(open, close);
  const fields = [...body.matchAll(/^\s{2}([A-Za-z]+)\??:/gm)].map((m) => m[1]);
  assert.ok(fields.length > 0, `no fields parsed for ${typeName}`);
  return fields;
}

const ANALYZE = "lib/data-transfer/historical/historical-analyze.ts";
const DUPES = "lib/data-transfer/historical/historical-analyze-duplicates.ts";
const DUPLICATES = "lib/data-transfer/historical/historical-duplicates.ts";
const DECISIONS = "lib/data-transfer/historical/historical-decisions.ts";
const PREVIEW = "lib/data-transfer/historical/historical-preview.ts";
const EXECUTE = "lib/data-transfer/historical/historical-execute.ts";

const IMPORT_SCREEN =
  "components/settings/import-export/historical/HistoricalImportScreen.tsx";
const RECORDS_SCREEN =
  "components/settings/import-export/historical/HistoricalRecordsScreen.tsx";
const DETAIL_SCREEN =
  "components/settings/import-export/historical/HistoricalRecordDetail.tsx";
const LANGUAGE = "lib/data-transfer/historical/historical-owner-language.ts";
const SCREENS = [IMPORT_SCREEN, RECORDS_SCREEN, DETAIL_SCREEN];

console.log("\nI-8B.6 — historical fiscal UX, owner-facing guarantees\n");

/* ============================ 1. every engine code has an owner sentence == */

/** Every member of an engine union must have non-empty Hebrew wording. */
function covers(
  label: string,
  members: readonly string[],
  map: Record<string, string>
): void {
  const hebrew = /[֐-׿]/;
  for (const member of members) {
    const text = map[member];
    assert.ok(
      typeof text === "string" && text.trim() !== "",
      `${label}: no owner wording for ${member}`
    );
    assert.ok(hebrew.test(text), `${label}: ${member} is not Hebrew`);
  }
  // And nothing extra: a stale entry is wording for a code that cannot happen.
  for (const key of Object.keys(map)) {
    assert.ok(
      members.includes(key),
      `${label}: wording for "${key}", which the engine cannot emit`
    );
  }
}

check("every structural row error has owner wording, and no extras", () => {
  covers("ROW_ERROR_TEXT", unionMembers(ANALYZE, "HistoricalRowErrorCode"), ROW_ERROR_TEXT);
});

check("every row warning has owner wording, and no extras", () => {
  covers(
    "ROW_WARNING_TEXT",
    unionMembers(ANALYZE, "HistoricalRowWarningCode"),
    ROW_WARNING_TEXT
  );
});

check("every duplicate error has owner wording, and no extras", () => {
  covers("DUPLICATE_ERROR_TEXT", unionMembers(DUPES, "DuplicateErrorCode"), DUPLICATE_ERROR_TEXT);
});

check("every duplicate warning has owner wording, and no extras", () => {
  covers(
    "DUPLICATE_WARNING_TEXT",
    unionMembers(DUPES, "DuplicateWarningCode"),
    DUPLICATE_WARNING_TEXT
  );
});

check("every mapping blocker has owner wording, and no extras", () => {
  covers(
    "MAPPING_BLOCKER_TEXT",
    unionMembers(ANALYZE, "HistoricalMappingBlockerCode"),
    MAPPING_BLOCKER_TEXT
  );
});

check("every duplicate state has owner wording, and no extras", () => {
  covers(
    "DATABASE_DUPLICATE_TEXT",
    unionMembers(DUPLICATES, "DatabaseDuplicateState"),
    DATABASE_DUPLICATE_TEXT
  );
  covers(
    "IN_FILE_DUPLICATE_TEXT",
    unionMembers(DUPLICATES, "InFileDuplicateState"),
    IN_FILE_DUPLICATE_TEXT
  );
});

check("all EIGHT reversal states have owner wording, and no extras", () => {
  const states = unionMembers(DUPLICATES, "ReversalState");
  assert.equal(states.length, 8, "the reversal vocabulary changed size");
  covers("REVERSAL_TEXT", states, REVERSAL_TEXT);
});

check("every blocking reason has owner wording, and no extras", () => {
  covers(
    "BLOCKING_REASON_TEXT",
    unionMembers(DECISIONS, "BlockingReasonCode"),
    BLOCKING_REASON_TEXT
  );
});

check("every comparable fact has an owner label, and no extras", () => {
  covers("FACT_LABEL", objectFields(DUPLICATES, "ComparableFacts"), FACT_LABEL);
});

check("every execution outcome has owner wording, and no extras", () => {
  covers("ROW_RESULT_TEXT", unionMembers(EXECUTE, "HistoricalRowResultCode"), ROW_RESULT_TEXT);
});

check("every row state has a label", () => {
  assert.deepEqual(Object.keys(ROW_STATE_LABEL).sort(), ["ERROR", "READY", "WARNING"]);
  for (const text of Object.values(ROW_STATE_LABEL)) assert.ok(text.trim() !== "");
});

check("every mapping status has a label", () => {
  assert.deepEqual(Object.keys(MAPPING_STATUS_LABEL).sort(), [
    "AMBIGUOUS",
    "EXACT",
    "SUGGESTED",
    "UNMAPPED",
  ]);
});

/**
 * The reversal TARGET classes describe what a credit will attach to. One of them
 * — NOT_APPLICABLE — is deliberately the empty string, because a document that
 * is not a credit has nothing to say here and a sentence would be noise.
 */
check("every reversal target class is accounted for", () => {
  const classes = unionMembers(PREVIEW, "ReversalTargetClass");
  for (const member of classes) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(REVERSAL_TARGET_TEXT, member),
      `no entry for ${member}`
    );
  }
  assert.equal(REVERSAL_TARGET_TEXT.NOT_APPLICABLE, "");
  for (const [key, text] of Object.entries(REVERSAL_TARGET_TEXT)) {
    if (key === "NOT_APPLICABLE") continue;
    assert.ok(text.trim() !== "", `${key} has no wording`);
  }
});

check("every reason the preview gives for not being ready is explained", () => {
  const src = codeOf(PREVIEW);
  const reasons = [...src.matchAll(/notReadyReasons\.push\("([A-Z_]+)"\)/g)].map(
    (m) => m[1]
  );
  assert.ok(reasons.length >= 5, "the not-ready reasons could not be read");
  for (const reason of reasons) {
    assert.ok(
      typeof NOT_READY_TEXT[reason] === "string" && NOT_READY_TEXT[reason] !== "",
      `no owner wording for ${reason}`
    );
  }
});

check("every execute refusal code has owner wording", () => {
  for (const code of unionMembers(EXECUTE, "HistoricalExecuteErrorCode")) {
    assert.ok(
      typeof FAILURE_TEXT[code] === "string" && FAILURE_TEXT[code] !== "",
      `no owner wording for ${code}`
    );
  }
});

/* ==================== 2. the two states that must never be generic ======== */

check("an expired preview says so, and says what to do", () => {
  const text = failureText("TOKEN_EXPIRED");
  assert.notEqual(text, "משהו השתבש. נסו שוב.");
  assert.match(text, /פגה/);
  assert.match(text, /מחדש/);
});

check("stale data says so, in both of the codes that mean it", () => {
  for (const code of ["ANALYSIS_STALE", "PREVIEW_STALE"]) {
    const text = failureText(code);
    assert.notEqual(text, "משהו השתבש. נסו שוב.");
    assert.match(text, /השתנו/, code);
    assert.match(text, /מחדש/, code);
  }
});

check("a known code beats the server's own message; an unknown one falls back", () => {
  assert.equal(failureText("TOKEN_EXPIRED", "whatever"), FAILURE_TEXT.TOKEN_EXPIRED);
  assert.equal(failureText("NOT_A_CODE", "מהשרת"), "מהשרת");
  assert.equal(failureText(null, null), "משהו השתבש. נסו שוב.");
  assert.equal(failureText(undefined), "משהו השתבש. נסו שוב.");
});

check("the screen offers a way OUT of every recoverable state", () => {
  const src = codeOf(IMPORT_SCREEN);
  for (const code of [
    "TOKEN_EXPIRED",
    "ANALYSIS_STALE",
    "PREVIEW_STALE",
    "DECISION_CHANGED",
  ]) {
    assert.ok(src.includes(code), `the screen does not handle ${code}`);
  }
  // Re-checking the file is the recovery, and it is a real control.
  assert.match(src, /בדקו את הקובץ מחדש/);
});

check("no decision is silently refreshed, converted or substituted", () => {
  const src = codeOf(IMPORT_SCREEN);
  // Recovery CLEARS the preview and the owner's overrides and re-analyzes. It
  // must not carry the old choices into a new analysis, which is how a CREATE
  // becomes a SKIP without anybody saying so.
  assert.match(src, /setPreview\(null\);\s*setOverrides\(\{\}\);\s*void runAnalyze/);
  // And it never rewrites an override on its own.
  assert.ok(
    !/setOverrides\(\(prev\) => \(\{[^}]*SKIP/.test(src),
    "the screen rewrites a decision by itself"
  );
});

/* ==================== 3. CREATE_ANYWAY means one thing only =============== */

check("the three actions are labelled, buttoned and explained", () => {
  for (const map of [ACTION_LABEL, ACTION_BUTTON, ACTION_HELP]) {
    assert.deepEqual(Object.keys(map).sort(), ["CREATE", "CREATE_ANYWAY", "SKIP"]);
    for (const text of Object.values(map)) assert.ok(text.trim() !== "");
  }
});

check("CREATE_ANYWAY is an ADDITIONAL record, and says so in those words", () => {
  const help = ACTION_HELP.CREATE_ANYWAY;
  assert.match(help, /נוספת/, "it must say another record is added");
  // The three things it is NOT, stated as negations rather than left to
  // inference. An owner may have to explain this choice years later.
  assert.match(help, /לא מתעדכנת/);
  assert.match(help, /לא מוחלפת/);
  assert.match(help, /לא נמחקת/);
  assert.match(ACTION_BUTTON.CREATE_ANYWAY, /נוספת/);
});

check("no wording anywhere claims an override repairs or replaces anything", () => {
  // Positive claims only: the negated forms above are the whole point.
  const claims = [
    "יוחלף",
    "יימחק",
    "יעודכן",
    "ימוזג",
    "יתוקן",
    "נדרוס",
    "נחליף",
    "נעדכן",
    "נמחק את",
    "נתקן",
  ];
  const surface = [
    ...Object.values(ACTION_LABEL),
    ...Object.values(ACTION_BUTTON),
    ...Object.values(ACTION_HELP),
    ...Object.values(DATABASE_DUPLICATE_TEXT),
    ...Object.values(IN_FILE_DUPLICATE_TEXT),
    ...Object.values(DUPLICATE_WARNING_TEXT),
  ].join(" ");
  for (const claim of claims) {
    assert.ok(!surface.includes(claim), `the wording says "${claim}"`);
  }
});

/* ==================== 4. the server decides ============================== */

check("the confirm button is gated on the SERVER's readiness, not the screen's", () => {
  const src = codeOf(IMPORT_SCREEN);

  // The gate must be on THE CONFIRM BUTTON, not merely somewhere in the file:
  // the reasons panel also tests `readyForExecute`, and a check that accepted
  // that would pass with the button ungated.
  const at = src.indexOf("onClick={runImport}");
  assert.notEqual(at, -1, "the confirm button was not found");
  const button = src.slice(at, at + 500);
  const disabled = /disabled=\{([\s\S]*?)\}\s*\n/.exec(button);
  assert.ok(disabled, "the confirm button has no disabled expression");
  assert.match(
    disabled![1],
    /!preview\.readyForExecute/,
    "the confirm button is not gated on the server's readiness"
  );
  // Choices made since the last preview must be sent before anything runs.
  assert.match(disabled![1], /decisionsPending/);

  // And the token is the server's, taken from the preview that was just signed.
  assert.match(src, /confirmed\.previewToken/);
  assert.ok(
    !src.includes("readyForExecute = "),
    "the screen computes readiness itself"
  );
});

check("the choices offered are exactly the ones the server permits", () => {
  const src = codeOf(IMPORT_SCREEN);
  assert.match(src, /row\.allowedDecisions\.map\(/);
  // No hardcoded action list is rendered as buttons.
  assert.ok(
    !/\["CREATE",\s*"SKIP",\s*"CREATE_ANYWAY"\]\.map/.test(src),
    "the screen offers a hardcoded action list"
  );
});

check("a blocked row is offered no action at all", () => {
  const src = codeOf(IMPORT_SCREEN);
  assert.match(src, /row\.blocked \?/);
  assert.match(src, /אי אפשר לקלוט אותה/);
});

check("the screen reconstructs no duplicate or reversal policy of its own", () => {
  const src = codeOf(IMPORT_SCREEN);
  // It reads states; it must not derive them. No identity comparison, no
  // matching, no target search.
  for (const forbidden of [
    "STRONG_CANDIDATE =",
    "sourceSystemCode ===",
    "originalDocumentNumber ===",
    "CREDITABLE",
    "identityKey",
  ]) {
    assert.ok(!src.includes(forbidden), `the screen computes ${forbidden}`);
  }
});

check("the screen posts to the historical endpoints, and to nothing else", () => {
  const src = codeOf(IMPORT_SCREEN);
  const urls = [...src.matchAll(/fetch\(\s*"([^"]+)"/g)].map((m) => m[1]);
  const templated = [...src.matchAll(/fetch\(\s*`([^`]+)`/g)].map((m) => m[1]);
  for (const url of [...urls, ...templated]) {
    assert.ok(
      url.startsWith("/api/data-transfer/import/historical/"),
      `the screen calls ${url}`
    );
  }
  assert.ok(
    urls.includes("/api/data-transfer/import/historical/analyze") &&
      urls.includes("/api/data-transfer/import/historical/preview") &&
      urls.includes("/api/data-transfer/import/historical/execute"),
    "the three engine calls are not all present"
  );
  // Crucially NOT the generic import routes, which refuse this domain anyway.
  assert.ok(!src.includes('"/api/data-transfer/import/analyze"'));
  assert.ok(!src.includes('"/api/data-transfer/import/execute"'));
});

/* ==================== 5. read-only, and visibly external ================= */

check("the records screens can only read — no mutating request exists", () => {
  for (const screen of [RECORDS_SCREEN, DETAIL_SCREEN]) {
    const src = codeOf(screen);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.ok(!src.includes(`method: "${method}"`), `${screen} sends ${method}`);
    }
    assert.ok(!src.includes("method:"), `${screen} sets a request method at all`);
  }
});

check("no billing, payment, authority or issuance action is reachable", () => {
  const forbidden = [
    "billing",
    "Billing",
    "payment",
    "Payment",
    "authority",
    "Authority",
    "uniform",
    "allocationNumber",
    "reissue",
    "financialEvent",
  ];
  for (const screen of SCREENS) {
    const src = codeOf(screen);
    for (const needle of forbidden) {
      assert.ok(!src.includes(needle), `${screen} references ${needle}`);
    }
  }
});

check("the records screens expose no edit or delete affordance", () => {
  // The verbs themselves are allowed — but only inside a DENIAL. "אי אפשר
  // לערוך" is exactly what this screen should say; "ערוך" on a button is not.
  const denial = /(אי אפשר|לא ניתן|לא נשמר|בלבד)/;
  for (const screen of [RECORDS_SCREEN, DETAIL_SCREEN]) {
    const src = codeOf(screen);
    for (const word of ["עריכה", "ערוך", "מחיקה", "מחק", "שליחה", "שלח", "ביטול מסמך"]) {
      let from = 0;
      for (;;) {
        const at = src.indexOf(word, from);
        if (at === -1) break;
        const context = src.slice(Math.max(0, at - 60), at + word.length);
        assert.ok(
          denial.test(context),
          `${screen} offers "${word}" outside a denial — ${context.trim().slice(-60)}`
        );
        from = at + word.length;
      }
    }
  }
  // And it says so out loud, so the absence reads as intent rather than an
  // unfinished screen.
  assert.match(codeOf(RECORDS_SCREEN), /לצפייה בלבד/);
  assert.match(codeOf(DETAIL_SCREEN), /לצפייה בלבד/);
});

check("external origin is stated, and is a DIFFERENT sentence from Dubiz's", () => {
  assert.notEqual(EXTERNAL_ORIGIN_BADGE, DUBIZ_ORIGIN_BADGE);
  assert.match(EXTERNAL_ORIGIN_BADGE, /מערכת אחרת/);
  assert.match(DUBIZ_ORIGIN_BADGE, /דוביז/);
  // The explanation must deny each of the three things Dubiz did NOT do.
  assert.match(EXTERNAL_ORIGIN_EXPLANATION, /לא הפיקה/);
  assert.match(EXTERNAL_ORIGIN_EXPLANATION, /לא הקצתה/);
  assert.match(EXTERNAL_ORIGIN_EXPLANATION, /לא דיווחה/);
});

check("every record on every historical screen carries the external badge", () => {
  for (const screen of [RECORDS_SCREEN, DETAIL_SCREEN]) {
    assert.match(codeOf(screen), /EXTERNAL_ORIGIN_BADGE/, screen);
  }
  // The import screen states it before the owner uploads anything.
  assert.match(codeOf(IMPORT_SCREEN), /EXTERNAL_ORIGIN_EXPLANATION/);
});

check("the import screen promises no issuance, numbering or reporting", () => {
  const src = codeOf(IMPORT_SCREEN);
  assert.match(src, /לא יופק מסמך חדש/);
  assert.match(src, /לא יוקצה\s*\n?\s*מספר/);
  assert.match(src, /לא ידווח/);
});

/* ==================== 6. no implementation vocabulary =================== */

check("no owner sentence contains implementation vocabulary", () => {
  const forbidden = [
    "HMAC",
    "RLS",
    "ImportRun",
    "evidenceFingerprint",
    "fingerprint",
    "sourceRowNumber",
    "Prisma",
    "Decimal",
    "advisory",
    "GUC",
    "tenant",
    "businessId",
    "hash",
    "SHA",
    "JWT",
    "SQL",
    "אסימון",
    "טרנזקציה",
    "גיבוב",
    "טוקן",
  ];
  const surface = [
    ...Object.values(ROW_STATE_LABEL),
    ...Object.values(ROW_ERROR_TEXT),
    ...Object.values(ROW_WARNING_TEXT),
    ...Object.values(DUPLICATE_ERROR_TEXT),
    ...Object.values(DUPLICATE_WARNING_TEXT),
    ...Object.values(MAPPING_BLOCKER_TEXT),
    ...Object.values(MAPPING_STATUS_LABEL),
    ...Object.values(ACTION_LABEL),
    ...Object.values(ACTION_BUTTON),
    ...Object.values(ACTION_HELP),
    ...Object.values(DATABASE_DUPLICATE_TEXT),
    ...Object.values(IN_FILE_DUPLICATE_TEXT),
    ...Object.values(FACT_LABEL),
    ...Object.values(REVERSAL_TEXT),
    ...Object.values(REVERSAL_TARGET_TEXT),
    ...Object.values(BLOCKING_REASON_TEXT),
    ...Object.values(NOT_READY_TEXT),
    ...Object.values(ROW_RESULT_TEXT),
    ...Object.values(FAILURE_TEXT),
    EXTERNAL_ORIGIN_BADGE,
    EXTERNAL_ORIGIN_EXPLANATION,
    DUBIZ_ORIGIN_BADGE,
  ].join("\n");
  for (const word of forbidden) {
    assert.ok(!surface.includes(word), `owner wording contains "${word}"`);
  }
});

check("the language module is safe to ship to a browser", () => {
  // It is imported by three client components. A runtime import of Prisma or the
  // engine would pull a database client into the bundle; every engine import
  // here must be `import type`, which is erased.
  const src = codeOf(LANGUAGE);
  assert.ok(!src.includes("@/lib/prisma"), "the language module imports a client");
  assert.ok(!src.includes("@prisma/client"), "the language module imports Prisma");
  const engineImports = [
    ...src.matchAll(/^import\s+(type\s+)?[\s\S]*?from "(@\/lib\/data-transfer\/[^"]+)";$/gm),
  ];
  for (const [, isType, from] of engineImports) {
    if (from.endsWith("historical-vocabulary")) continue; // pure data, no client
    assert.ok(isType, `${from} is imported at runtime, not as a type`);
  }
});

check("the screens carry no engine internals as owner text", () => {
  for (const screen of SCREENS) {
    const src = codeOf(screen);
    // Word-bounded: `URLSearchParams` is not a mention of row-level security.
    for (const pattern of [
      /\bHMAC\b/,
      /\bRLS\b/,
      /\badvisory\b/i,
      /@\/lib\/prisma/,
      /@prisma\/client/,
    ]) {
      assert.ok(!pattern.test(src), `${screen} references ${pattern.source}`);
    }
  }
});

check("no internal id is ever rendered", () => {
  for (const screen of SCREENS) {
    const src = codeOf(screen);
    // An id may be a href (`${...}` in a template literal is a URL) or a React
    // `key=` (never painted). A BARE `{x.id}` in JSX is TEXT, and that is what
    // must not exist.
    for (const holder of ["item", "record", "relation"]) {
      const printed = new RegExp(`(?<!\\$)(?<!key=)\\{\\s*${holder}\\.id\\s*\\}`);
      assert.ok(!printed.test(src), `${screen} renders ${holder}.id as text`);
    }
  }
  // The execute response carries a runId. The screen must not show it.
  const src = codeOf(IMPORT_SCREEN);
  assert.ok(!src.includes("runId"), "the import screen exposes the run id");
});

/* ==================== 7. vocabulary and boundaries ====================== */

check("the four document types are labelled from the ONE vocabulary", () => {
  assert.equal(DOCUMENT_TYPE_LABEL, HISTORICAL_TYPE_LABELS);
  assert.equal(documentTypeLabel("TAX_INVOICE"), HISTORICAL_TYPE_LABELS.TAX_INVOICE);
  assert.equal(documentTypeLabel("CREDIT_NOTE"), HISTORICAL_TYPE_LABELS.CREDIT_NOTE);
  // An unknown code stays readable rather than rendering as nothing.
  assert.equal(documentTypeLabel("SOMETHING_ELSE"), "SOMETHING_ELSE");
  // QUOTE is not a fiscal document and has no label here.
  assert.ok(!Object.keys(DOCUMENT_TYPE_LABEL).includes("QUOTE"));
});

check("no screen creates, links or searches a customer", () => {
  for (const screen of SCREENS) {
    const src = codeOf(screen);
    assert.ok(!/customerId/.test(src), `${screen} handles a customer id`);
    assert.ok(!/\/api\/(crm|customers)/.test(src), `${screen} calls a customer API`);
  }
  // The detail view says the snapshot is NOT a customer card.
  assert.match(codeOf(DETAIL_SCREEN), /לא מקושר לכרטיס לקוח/);
});

check("currency is never defaulted for the owner", () => {
  // The engine refuses a missing currency; the wording must not soften that
  // into "we assumed shekels".
  assert.match(ROW_ERROR_TEXT.MISSING_CURRENCY, /לא נניח/);
  const surface = Object.values(ROW_ERROR_TEXT).join(" ");
  assert.ok(!surface.includes("USD"));
  assert.ok(!surface.includes("EUR"));
});

check("the ambiguous-date question is asked, not guessed", () => {
  assert.match(ROW_ERROR_TEXT.AMBIGUOUS_DATE, /בחרו/);
  const src = codeOf(IMPORT_SCREEN);
  assert.match(src, /DATE_FORMAT_REQUIRED/);
  assert.match(src, /03\/04\/2025/, "the example the owner needs is missing");
  // Both readings are offered. Neither is preselected.
  assert.match(src, /"DMY"/);
  assert.match(src, /"MDY"/);
  assert.ok(
    !/useState<DateFormat>\("DMY"\)/.test(src),
    "a date format is preselected for the owner"
  );
});

check("a warning is never presented as a blocker", () => {
  const src = codeOf(IMPORT_SCREEN);
  assert.match(src, /שורה עם התראה עדיין ניתנת לקליטה/);
  // The three summary buckets stay distinct rather than collapsing into one.
  assert.match(src, /ROW_STATE_LABEL\.READY/);
  assert.match(src, /ROW_STATE_LABEL\.WARNING/);
  assert.match(src, /ROW_STATE_LABEL\.ERROR/);
});

check("replay is explained rather than presented as a second import", () => {
  assert.match(ROW_RESULT_TEXT.ALREADY_EXECUTED, /כבר נשמר/);
  const src = codeOf(IMPORT_SCREEN);
  assert.match(src, /result\.replayed/);
  assert.match(src, /שום דבר לא נשמר/);
});

check("the completion summary leads to the records view", () => {
  const src = codeOf(IMPORT_SCREEN);
  assert.match(src, /recordsHref/);
  assert.match(src, /לצפייה במסמכים ההיסטוריים/);
});

/* ==================== 8. mobile, RTL and the design system ============== */

check("the screens own no design system of their own", () => {
  for (const screen of SCREENS) {
    const src = codeOf(screen);
    assert.match(src, /@\/components\/settings\/SettingsSection/, screen);
    // Mist tokens only — no hex colour, no rgb(), no named colour utility.
    const hex = src.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    for (const colour of hex) {
      assert.ok(
        src.includes(`var(--dz-danger,${colour})`) ||
          src.includes(`var(--dz-danger, ${colour})`),
        `${screen} hardcodes the colour ${colour}`
      );
    }
    assert.ok(!/rgb\(/.test(src), `${screen} hardcodes an rgb colour`);
  }
});

check("every control clears the 44px touch target", () => {
  for (const screen of SCREENS) {
    const src = codeOf(screen);
    // Scanning to the tag's closing ">" does not work: `onClick={() =>` puts a
    // ">" inside the tag. So each control is read from its opening tag to its
    // className, which every control on these screens has.
    for (const match of src.matchAll(/<(button|select|input|Link)\b/g)) {
      const chunk = src.slice(match.index, (match.index ?? 0) + 900);
      // The hidden file input is not a touch target; its visible button is.
      if (/\bclassName="sr-only"/.test(chunk.slice(0, 200))) continue;

      const className = /className=\{?[`"]([^`"]*)/.exec(chunk);
      assert.ok(className, `${screen}: a ${match[1]} with no className`);
      const classes = className![1];
      assert.ok(
        /min-h-\[44px\]/.test(classes) || /\bpy-6\b/.test(classes),
        `${screen}: a ${match[1]} with no 44px touch target — ${classes.slice(0, 60)}`
      );
    }
  }
});

check("long owner text cannot break the layout", () => {
  // Document numbers, customer names and source-system labels are all
  // arbitrary-length owner data. Every place one is printed must wrap or clip.
  for (const screen of SCREENS) {
    const src = codeOf(screen);
    assert.ok(
      src.includes("break-words") || src.includes("truncate"),
      `${screen} prints owner data with no overflow handling`
    );
  }
});

check("the list widens on a bigger screen instead of staying a phone column", () => {
  const src = codeOf(RECORDS_SCREEN);
  assert.match(src, /sm:grid-cols-2/);
  const importSrc = codeOf(IMPORT_SCREEN);
  assert.match(importSrc, /sm:grid-cols-4/);
});

check("loading, empty, filtered-empty and error states all exist", () => {
  const src = codeOf(RECORDS_SCREEN);
  assert.match(src, /animate-pulse/, "no loading state");
  assert.match(src, /emptyHistory/, "no first-run empty state");
  assert.match(src, /אין מסמכים שמתאימים לסינון/, "no filtered-empty state");
  assert.match(src, /נסו שוב/, "no error recovery");
  const detail = codeOf(DETAIL_SCREEN);
  assert.match(detail, /animate-pulse/, "no detail loading state");
  assert.match(detail, /המסמך לא נמצא/, "no detail not-found state");
});

console.log(`\n  ${passed} checks passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  failures.forEach((f) => console.log(`  FAILED: ${f}`));
  process.exitCode = 1;
}
