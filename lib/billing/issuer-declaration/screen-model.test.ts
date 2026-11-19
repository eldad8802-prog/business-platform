/**
 * D5 — the issuer declaration screens' view model (#1081; approved design 2026-11-17). Pure. Every state has a
 * screen; every link outcome has a Hebrew title, explanation and a way to continue; only a transient failure keeps the
 * token for a retry; the billing notice follows the owner's rules (non-blocking, hidden after a declaration, "אחר כך"
 * for this visit only). Plus source checks that the screens keep the security properties.
 *
 *   npx tsx lib/billing/issuer-declaration/screen-model.test.ts
 */
import { readFileSync } from "node:fs";

import { COMPLETION_FIELD, confirmViewFor, declarationScreenFor, issuerNoticeVisible } from "@/lib/billing/issuer-declaration/screen-model";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, got?: unknown) {
  if (!cond) {
    console.error("FAIL: D5", name, got !== undefined ? `(got: ${JSON.stringify(got)})` : "");
    failed += 1;
    return;
  }
  passed += 1;
  console.log("OK: D5", name);
}

// ── which screen ─────────────────────────────────────────────────────────────
const base = { declared: false, precondition: null, declarantNameMissing: false, editableFields: [], hasStatement: false } as const;
ok("declared → status screen", declarationScreenFor({ ...base, declared: true }) === "DECLARED");
ok("ALREADY_DECLARED → status screen", declarationScreenFor({ ...base, precondition: "ALREADY_DECLARED" }) === "DECLARED");
ok("several users → designation screen", declarationScreenFor({ ...base, precondition: "NEEDS_DESIGNATION", hasStatement: true }) === "NEEDS_DESIGNATION");
ok("missing editable detail → completion screen", declarationScreenFor({ ...base, precondition: "INCOMPLETE", editableFields: ["billingVatNumber"] }) === "COMPLETE");
ok("missing declarant name only → completion screen (explained)", declarationScreenFor({ ...base, precondition: "INCOMPLETE", declarantNameMissing: true }) === "COMPLETE");
ok("missing only a locked detail → blocked (correction path)", declarationScreenFor({ ...base, precondition: "INCOMPLETE" }) === "BLOCKED");
ok("complete with a statement → review screen", declarationScreenFor({ ...base, hasStatement: true }) === "REVIEW");

// ── the billing notice ───────────────────────────────────────────────────────
ok("notice: shown when on and not declared", issuerNoticeVisible({ available: true, declared: false, dismissedThisVisit: false }));
ok("notice: never when the screens are off (404)", !issuerNoticeVisible({ available: false, declared: false, dismissedThisVisit: false }));
ok("notice: never after a valid declaration", !issuerNoticeVisible({ available: true, declared: true, dismissedThisVisit: false }));
ok("notice: hidden for this visit after 'אחר כך'", !issuerNoticeVisible({ available: true, declared: false, dismissedThisVisit: true }));
{
  const src = readFileSync("components/billing/IssuerDeclarationNotice.tsx", "utf8");
  ok("notice: 'אחר כך' is component state only — nothing persisted, so the next visit shows it again",
    src.includes("setDismissed(true)") && !/localStorage\.setItem|sessionStorage|document\.cookie/.test(src));
  ok("notice: non-blocking — it disables or hides nothing else", !/disabled=|pointerEvents|display:\s*"none"/.test(src));
  const page = readFileSync("app/billing/page.tsx", "utf8");
  ok("billing page: the notice is mounted once", (page.match(/<IssuerDeclarationNotice \/>/g) ?? []).length === 1);
}

// ── every link outcome ───────────────────────────────────────────────────────
const STATUSES = ["CONFIRMED", "SIGN_IN_REQUIRED", "EXPIRED", "SUPERSEDED", "USED", "BINDING_MISMATCH", "ALREADY_DECLARED",
  "INCOMPLETE", "NEEDS_DESIGNATION", "NOT_RECORDED", "ERROR", "INVALID", "SOMETHING_UNKNOWN"];
for (const s of STATUSES) {
  const v = confirmViewFor(s);
  ok(`outcome ${s}: Hebrew title + explanation + an action`, /[֐-׿]/.test(v.title) && /[֐-׿]/.test(v.body) && v.actions.length > 0, v);
}
ok("only a transient failure is retryable (the link was not spent)",
  STATUSES.filter((s) => confirmViewFor(s).retryable).sort().join(",") === "ERROR,NOT_RECORDED");
ok("signed out: the primary action is to sign in, and the text says to reopen the link", confirmViewFor("SIGN_IN_REQUIRED").actions[0] === "SIGN_IN"
  && confirmViewFor("SIGN_IN_REQUIRED").body.includes("לפתוח את הקישור שוב"));
ok("expired: a new link is offered", confirmViewFor("EXPIRED").actions[0] === "NEW_LINK");
ok("superseded/used: leads to the status (it may already be declared)", confirmViewFor("SUPERSEDED").actions[0] === "STATUS" && confirmViewFor("USED").actions[0] === "STATUS");
ok("details changed: back to review the details", confirmViewFor("BINDING_MISMATCH").actions[0] === "REVIEW_DETAILS");
ok("an unknown status never pretends success", confirmViewFor("SOMETHING_UNKNOWN").tone !== "success");

// ── the VAT number is its own field ─────────────────────────────────────────
ok("VAT dealer number: its own label, distinct from the ID / company number", COMPLETION_FIELD.billingVatNumber?.label === "מספר עוסק מורשה"
  && COMPLETION_FIELD.billingTaxId?.label !== COMPLETION_FIELD.billingVatNumber?.label);
ok("phone hint states the 9–10 digit rule", (COMPLETION_FIELD.billingPhone?.hint ?? "").includes("9–10"));

// ── the confirm page keeps the security properties ──────────────────────────
{
  const src = readFileSync("app/billing/issuer-declaration/confirm/confirm-screen.tsx", "utf8");
  ok("confirm page: the token leaves the address bar before anything else", src.indexOf("history.replaceState") > 0
    && src.indexOf("history.replaceState") < src.indexOf('fetch("/api/billing/issuer-declaration/check"'));
  ok("confirm page: the token is never stored", !/localStorage\.setItem|sessionStorage|document\.cookie/.test(src));
  ok("confirm page: a spent or refused link is dropped from memory (no retry with it)", src.includes("if (!confirmViewFor(status).retryable) setToken(null)"));
  const screen = readFileSync("app/billing/issuer-declaration/declaration-screen.tsx", "utf8");
  ok("declaration screen: missing details are saved through the one profile write path", screen.includes('fetch("/api/billing/invoice-profile"')
    && !/businessProfile|prisma/.test(screen));
  ok("declaration screen: nothing is declared on it (only the emailed link confirms)", !screen.includes("/api/billing/issuer-declaration/confirm"));
}

console.log(failed ? `\nD5: ${passed} passed, ${failed} FAILED` : `\nD5: ${passed}/${passed} passed`);
if (failed) process.exit(1);
