/**
 * "הפקת מסמך" stage 1 — which document types the production list offers. Pure.
 * Run: npx tsx features/business-documents/document-production-model.test.ts
 */
import { billingHe } from "@/lib/i18n/messages/areas/billing";
import { billingEn } from "@/lib/i18n/messages/areas/billing.en";

import { groupedProductionOptions, parseProductionEntry, productionOptions } from "./document-production-model";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}
const keys = (kind: Parameters<typeof productionOptions>[0]["businessKind"]) => productionOptions({ businessKind: kind }).map((o) => o.key);

console.log("only types whose flow works today are offered");
for (const kind of ["AUTHORIZED_DEALER", "LTD_COMPANY", null] as const) {
  ok(`${kind ?? "unknown kind"}: tax invoice, quote, letter, supplier order`, JSON.stringify(keys(kind)) === JSON.stringify(["TAX_INVOICE", "QUOTE", "LETTER", "SUPPLIER_ORDER"]), JSON.stringify(keys(kind)));
}
ok("exempt dealer: no tax invoice (the server refuses it at issue)", JSON.stringify(keys("EXEMPT_DEALER")) === JSON.stringify(["QUOTE", "LETTER", "SUPPLIER_ORDER"]), JSON.stringify(keys("EXEMPT_DEALER")));
const all = productionOptions({ businessKind: "AUTHORIZED_DEALER" });
for (const notYet of ["RECEIPT", "TAX_INVOICE_RECEIPT", "CREDIT_NOTE", "PAYMENT_REQUEST", "ORDER", "DELIVERY_NOTE", "RETURN_NOTE", "SERVICE_CALL"]) {
  ok(`${notYet} is not offered (its flow does not work yet)`, !all.some((o) => (o.key as string) === notYet));
}
console.log("every option and group has its words in Hebrew and English (billing.production)");
for (const [lang, m] of [["he", billingHe.production], ["en", billingEn.production]] as const) {
  for (const o of productionOptions({ businessKind: null })) {
    const w = (m.option as Record<string, { title: string; help: string }>)[o.key];
    ok(`${lang}: ${o.key} has a title and says when to choose it`, !!w && w.title.length > 1 && w.help.length > 10, JSON.stringify(w));
    ok(`${lang}: ${o.key} says nothing like "coming soon"`, !!w && !/בקרוב|soon/i.test(w.title + w.help));
  }
  for (const g of ["tax", "sales", "general", "purchasing"] as const) ok(`${lang}: group ${g} has a heading`, (m.group as Record<string, string>)[g]?.length > 1);
  ok(`${lang}: the customer line carries the name`, m.forCustomer.includes("{name}"));
}
ok("tax invoice and quote go to the existing billing create flow", all.filter((o) => o.kind === "billing").map((o) => o.key).join() === "TAX_INVOICE,QUOTE");
const hrefs = Object.fromEntries(all.flatMap((o) => (o.kind === "link" ? [[o.key, o.href]] : [])));
ok("letter → the existing new-letter screen, no customer passed (it would overwrite the device draft)", hrefs.LETTER === "/business-documents/letters/new");
ok("supplier order → the existing inventory flow", hrefs.SUPPLIER_ORDER === "/inventory/supplier-purchases/new");

console.log("groups keep a fixed order and drop empty ones");
ok("authorized dealer: tax, sales, general, purchasing", groupedProductionOptions(all).map((g) => g.group).join() === "tax,sales,general,purchasing");
ok("exempt dealer: no empty tax group", groupedProductionOptions(productionOptions({ businessKind: "EXEMPT_DEALER" })).map((g) => g.group).join() === "sales,general,purchasing");

console.log("the entry parameters from a customer card");
const p = (q: string) => parseProductionEntry(new URLSearchParams(q));
ok("customer id and name", JSON.stringify(p("create=documents&customerId=12&customerName=%D7%93%D7%A0%D7%94")) === JSON.stringify({ customerId: 12, customerName: "דנה" }));
ok("no customer", JSON.stringify(p("create=documents")) === JSON.stringify({ customerId: null, customerName: null }));
for (const bad of ["0", "-3", "1.5", "abc", "12abc", "99999999999", ""]) {
  ok(`invalid customer id ${JSON.stringify(bad)} → none (and no name)`, JSON.stringify(p(`customerId=${bad}&customerName=x`)) === JSON.stringify({ customerId: null, customerName: null }));
}
ok("a name is trimmed and capped at 200", p(`customerId=5&customerName=${encodeURIComponent("  " + "א".repeat(300))}`).customerName?.length === 200);

console.log(`\n${pass}/${pass + failures.length} passed`);
if (failures.length) process.exit(1);
