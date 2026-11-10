/**
 * "הפקת מסמך" — the document types offered by the one production entry (stage 1, owner-approved 2026-11-10).
 * Pure: no React, no fetch.
 *
 * Stage 1 builds no new document. Every option opens a flow that already works end to end on main:
 *   - tax invoice and quote → the existing billing create flow (identity gate, draft, issue) — unchanged;
 *   - letter → the saved-letters screen (business_documents);
 *   - supplier purchase order → the existing inventory flow, where "שמירת עותק" lives.
 * A type whose flow does not work yet is NOT listed (no "coming soon"): receipt and consolidated receipt (Draft
 * #1021), tax invoice-receipt and credit note (server routes exist, no screen), payment request, order, delivery
 * note, return note (not built), service call (service-desk track, flag off).
 *
 * Business kind: an exempt dealer may not issue a tax invoice (lib/billing/business-identity.ts — the server
 * refuses it at issue), so it is not offered to one. While the kind is unknown it is offered, as the screen does
 * today; the server still refuses it for an exempt dealer.
 */
export type ProductionBusinessKind = "EXEMPT_DEALER" | "AUTHORIZED_DEALER" | "LTD_COMPANY" | null;

export type ProductionOption =
  | { key: "TAX_INVOICE" | "QUOTE"; kind: "billing"; group: ProductionGroup; title: string; help: string }
  | { key: "LETTER" | "SUPPLIER_ORDER"; kind: "link"; group: ProductionGroup; title: string; help: string; href: string };

export type ProductionGroup = "tax" | "sales" | "general" | "purchasing";

export const PRODUCTION_GROUP_TITLE: Record<ProductionGroup, string> = {
  tax: "מסמכי מס",
  sales: "מכירה",
  general: "כללי",
  purchasing: "רכש",
};

export function productionOptions(input: { businessKind: ProductionBusinessKind }): ProductionOption[] {
  const options: ProductionOption[] = [];
  if (input.businessKind !== "EXEMPT_DEALER") {
    options.push({
      key: "TAX_INVOICE",
      kind: "billing",
      group: "tax",
      title: "חשבונית מס",
      help: "על מכירה או שירות. מקבלת מספר רק בהפקה הסופית.",
    });
  }
  options.push({
    key: "QUOTE",
    kind: "billing",
    group: "sales",
    title: "הצעת מחיר",
    help: "לפני עסקה. אפשר להמיר אותה לחשבונית כשהלקוח מאשר.",
  });
  options.push({
    key: "LETTER",
    kind: "link",
    group: "general",
    title: "מכתב",
    help: "מכתב ללקוח או לגורם אחר, נשמר עם PDF.",
    // no customer passed: the letter screen restores its device draft, which a passed customer would overwrite
    href: "/business-documents/letters/new",
  });
  options.push({
    key: "SUPPLIER_ORDER",
    kind: "link",
    group: "purchasing",
    title: "הזמנה לספק",
    help: "הזמנת סחורה מספק, במסך המלאי. שם אפשר גם לשמור עותק.",
    href: "/inventory/supplier-purchases/new",
  });
  return options;
}

export function groupedProductionOptions(options: ProductionOption[]): { group: ProductionGroup; title: string; options: ProductionOption[] }[] {
  const order: ProductionGroup[] = ["tax", "sales", "general", "purchasing"];
  return order
    .map((group) => ({ group, title: PRODUCTION_GROUP_TITLE[group], options: options.filter((o) => o.group === group) }))
    .filter((g) => g.options.length > 0);
}

/** The billing create entry: `?create=documents` opens the list; an optional customer comes with it. */
export function parseProductionEntry(params: { get(name: string): string | null }): { customerId: number | null; customerName: string | null } {
  const raw = params.get("customerId");
  const id = raw !== null && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null;
  const name = (params.get("customerName") ?? "").trim().slice(0, 200);
  return { customerId: validId(id) ? id : null, customerName: validId(id) && name ? name : null };
}

function validId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}
