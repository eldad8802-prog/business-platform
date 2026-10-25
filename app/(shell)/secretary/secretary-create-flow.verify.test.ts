/**
 * P3 creation flow proof (`npm run verify:secretary-create-flow`).
 *
 * Owner decision 23.10.2026: the P3 flow (18.9.2026, 23d528d5) — "נגדיר את
 * ההתחייבויות" → "מסור למזכירה" → "מצוין, אני זוכרת" — is THE way to create a
 * commitment from every create entry point, with honest copy and the
 * "ביטוחים" match fixed. Pure: reads source text and runs the category matcher.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { findCategoryObligation, INSURANCE, NATIONAL_INSURANCE } from "./secretary-bank-categories";
import { obligationPayeeName, obligationTitle } from "@/lib/obligations/secretary-client";

let failures = 0;
let checks = 0;
function check(ok: boolean, label: string, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

// ── "ביטוחים" is not "ביטוח לאומי"
const onlyNational = [{ obligeeName: "ביטוח לאומי" }];
check(findCategoryObligation(INSURANCE, onlyNational) === null, "ביטוחים is not marked saved by a ביטוח לאומי item");
check(findCategoryObligation(NATIONAL_INSURANCE, onlyNational)?.obligeeName === "ביטוח לאומי", "ביטוח לאומי still finds its own item");
check(findCategoryObligation(INSURANCE, [{ obligeeName: "ביטוח רכב" }, { obligeeName: "ביטוח לאומי" }])?.obligeeName === "ביטוח רכב", "ביטוחים finds a real insurance item");
check(findCategoryObligation("שכירות", [{ obligeeName: "שכירות משרד" }])?.obligeeName === "שכירות משרד", "plain keyword categories unchanged");
check(findCategoryObligation("חשמל", [{ obligeeName: "מים" }]) === null, "no match → not saved");

// ── Entry points lead to P3 ("נגדיר את ההתחייבויות")
const P3_START = "/secretary?screen=bank";
const sheet = read("components/navigation/action-sheet.tsx");
check(sheet.includes(`{ label: "התחייבות חדשה", href: "${P3_START}"`), '"+" → "התחייבות חדשה" opens P3');
check(!sheet.includes('"/payables?new=1"'), '"+" no longer opens the payables form');
for (const other of ['"/tasks?new=1"', '"/billing?create=1"', '"/collection/new"', '"/leads?new=1"', '"/documents/upload"', '"/inventory/items/create"']) {
  check(sheet.includes(other), `"+" keeps its other action ${other}`);
}
const home = read("features/home/v3/desktop-home.tsx");
check(home.includes(`label: "home.desktop.shortcuts.newObligation", href: "${P3_START}"`), "Home shortcut opens P3");
const taskForm = read("features/tasks/task-form.tsx");
check(taskForm.includes(`<Link href="${P3_START}"`) && !taskForm.includes('"/payables?new=1"'), "task form's commitment link opens P3");
const mainScreen = read("app/(shell)/secretary/secretary-home.tsx");
check(mainScreen.includes(`bank: "${P3_START}"`), "Secretary header 'הוסף התחייבות' still opens P3");

// ── The flow's screens
const ui = read("app/(shell)/secretary/secretary-ui.tsx");
const fn = (name: string) => {
  const start = ui.indexOf(`function ${name}(`);
  const end = ui.indexOf("\nfunction ", start + 10);
  return start < 0 ? "" : ui.slice(start, end < 0 ? undefined : end);
};
const bank = fn("BankScreen");
const capture = fn("CaptureScreen");
const loop = fn("LoopResult");
check(bank.includes('backLook="p3"'), "נגדיר את ההתחייבויות uses the P3 back look");
check(fn("P3BackControl").includes("useGoBack(fallbackHref)"), "P3 back look keeps today's navigation (useGoBack)");
check(ui.includes('backLook = "round"'), "every other Secretary screen keeps the round back control by default");
check(capture.indexOf("CAPTURE_KINDS.map") >= 0 && capture.indexOf("CAPTURE_KINDS.map") < capture.indexOf('t("tasks.secretary.capture.task")'), '"משימה" is listed after the payment kinds');
check(capture.includes("TaskForm") && capture.includes("tasksOn ?"), '"משימה" keeps its existing form and flag gate');

// No reminder promise left in the creation flow (nothing sends one).
for (const key of ["tasks.secretary.capture.checkNote", "tasks.secretary.capture.netComputed", "tasks.secretary.loop.createdBody", "tasks.secretary.loop.echoRemind"]) {
  check(!capture.includes(key) && !loop.includes(key), `creation flow no longer shows ${key}`);
}
check(!fn("captureSayForKind").includes("tasks.secretary.capture.say.postdatedCheck"), "cheque intro no longer promises a reminder");
const copyStart = ui.indexOf("const P3_COPY");
const copy = ui.slice(copyStart, ui.indexOf("\n};", copyStart));
check(copyStart > 0 && !/אזכיר לך|תזכורת|אזכיר:/.test(copy), "the flow's new copy promises no reminder", copy.match(/אזכיר[^"`]*/)?.[0] ?? "");
check(copy.includes("לא נרשם בפנקס הצ'קים") && copy.includes("כהתחייבות אחת עם"), "cheque and payment-plan copy say exactly how they are saved");

// One creation path (owner, 25.10.2026): a payment plan is ONE commitment with a real plan, through the same
// secretary create; a payee is linked by id only.
check(
  capture.includes("installmentPlan: { count: installmentCountNumber, cadence: planCadence }") && !capture.includes("onCreateMany?.(inputs)"),
  "a payment plan is saved as one commitment with a real plan (no longer separate one-off payments)",
);
check(
  capture.includes("const linkedPayee = payee.payeeId != null ? { payeeId: payee.payeeId } : {};") && capture.includes("<PayeeField payeeId={payee.payeeId}"),
  "the payee is the payables picker; only its id is sent, and only when one was chosen",
);
check(/generateInstallmentPlan\(\{ totalMinor, count, firstDueAt: first, cadence \}\)/.test(ui), "the plan preview uses the server's own generator");
check(capture.includes("`צ'ק מס' ${checkNumber.trim()}`"), "post-dated cheque note unchanged");
check(capture.includes("`שוטף+${termsDays}`"), "net-terms note unchanged");

// Desktop: the P3 two-per-row column.
const css = read("app/(shell)/secretary/secretary.module.css");
check(!css.includes(".shell:has(.bankGrid)"), "נגדיר את ההתחייבויות is not widened on desktop");
check(!/\.bankGrid\s*\{\s*grid-template-columns:\s*repeat\(3/.test(css), "categories stay two per row on desktop");

// The categories screen (owner, 25.10.2026).
const bankScreen = ui.slice(ui.indexOf("function BankScreen("), ui.indexOf("\n}\n", ui.indexOf("function BankScreen(")));
check(!bankScreen.includes("RememberedObligationCard"), "no \"כבר אני זוכרת\" card on the categories screen");
check(!bankScreen.includes("bank.done") && !bankScreen.includes('href="/secretary"'), "no \"סיימתי, חזרה ליום שלי\" button (the back control and the result screen lead back)");
check(bankScreen.includes("P3_COPY.otherHeading") && bankScreen.includes("<Link className={styles.createButton} href={captureHref()}><PlusIcon /> {P3_COPY.createButton}</Link>"), "\"צור התחייבות\" opens the same empty capture form, under its own \"משהו שלא ברשימה\" heading");
check(/createButton: "צור התחייבות"/.test(ui) && /otherHeading: "משהו שלא ברשימה"/.test(ui), "the new wording");
check(/\.createButton \{[^}]*--sand: color-mix\(in srgb, var\(--dz-warm-sand-pill\), var\(--dz-warning-accent\) 16%\)/.test(css), "\"צור התחייבות\" in the sand of \"הוסף התחייבות\"");
check(/\.ghostFixed \{ flex: 0 0 auto; \}/.test(css) && bankScreen.includes("styles.ghostFixed"), "\"לראות את כל ההתחייבויות\" keeps its own height");
check(
  /const leaveFlow = useGoBack\("\/secretary"\);[\s\S]{0,900}?function finishCreated\(\) \{\s*consumeFlowEntries\(/.test(ui) &&
    /\}\);\s*leaveFlow\(\);\s*\}/.test(ui) &&
    /screen === "bank" \|\| screen === "capture"/.test(ui) &&
    /onDone=\{finishCreated\}/.test(ui) &&
    ui.includes("onDone ? <GhostButton onClick={onDone}>"),
  "\"סיימתי\" after a save marks the categories / form steps done and goes back to the entry point (the Secretary on a direct visit)",
);
check(/mode="created"[\s\S]{0,400}onAddMore=\{startAnother\}/.test(ui) && ui.includes(`config.secondary ? (onDone ? <GhostButton onClick={onDone}>`),"after a save the result screen still offers \"הוסף עוד\" and \"סיימתי\"");

// "×" on the creation sheet steps back like "חזרה" (owner, 25.10.2026) — never a link forward to the categories,
// which looped with their "חזרה" while the bar is hidden.
check(
  capture.includes('const closeSheet = useGoBack(screenHref("bank"));') &&
    capture.includes("<button type=\"button\" onClick={closeSheet} className={styles.captureClose}") &&
    !capture.includes('<Link href={screenHref("bank")} className={styles.captureClose}'),
  "\"×\" goes back one step (useGoBack, categories as the fallback), not forward",
);

// The commitment's own name (owner, 25.10.2026): with a linked payee `obligeeName` is the payee's name; the
// Secretary leads with the title the owner typed and shows the payee on the second line.
const linked = { obligeeName: "מחשבי הדר", ledger: { commitmentId: 1, installmentId: 1, paid: "0.00", remaining: "10.00", title: "ליסינג" } };
const plain = { obligeeName: "שכירות", ledger: { commitmentId: 2, installmentId: 2, paid: "0.00", remaining: "10.00", title: "שכירות" } };
const legacy = { obligeeName: "ועד בית", ledger: null };
check(obligationTitle(linked) === "ליסינג" && obligationPayeeName(linked) === "מחשבי הדר", "linked payee: title first, payee second");
check(obligationTitle(plain) === "שכירות" && obligationPayeeName(plain) === null, "no payee: the same name, no second line");
check(obligationTitle(legacy) === "ועד בית" && obligationPayeeName(legacy) === null, "legacy store / older answer (no title): obligeeName as before");
check(findCategoryObligation("שכירות", [{ obligeeName: "יוסי כהן", ledger: { title: "שכירות משרד" } }])?.ledger?.title === "שכירות משרד", "a category saved with a payee is still found by its title");
for (const [label, needle] of [
  ["list cards", "title: displayName(obligationTitle(item), f.t)"],
  ["list cards' payee line", "meta: withPayee(item, obligationMeta(item, f))"],
  ["timeline rows", "<strong>{obligationTitle(item)}</strong>"],
  ["detail screen", "const name = displayName(obligationTitle(obligation), t);"],
  ["detail \"למי\" = the payee when linked", "displayName(obligationPayeeName(obligation) ?? obligationTitle(obligation), t)"],
  ["\"מצוין, אני זוכרת\"", "const name = obligation ? displayName(obligationTitle(obligation), t)"],
] as const) check(ui.includes(needle), `Secretary shows the title: ${label}`);
check(read("app/(shell)/secretary/page.tsx").includes("name: displayObligeeName(obligationTitle(focus.obligation), t)"), "Secretary focus card shows the title");
check(read("app/(shell)/secretary/paid-question.tsx").includes("{ name: obligationTitle(obligation) }"), "\"שילמת?\" names the commitment");
check(/const name = useState\(obligation\?\.obligeeName/.test(ui) || ui.includes('useState(obligation?.obligeeName ?? "")'), "the edit form is unchanged (it still edits obligeeName — no save change)");

if (failures > 0) {
  console.error(`secretary-create-flow: ${failures}/${checks} checks failed`);
  process.exit(1);
}
console.log(`secretary-create-flow: ${checks} checks passed`);
