/**
 * Collection · the message.
 *
 * This module is the product. Everything else in the collection flow — terms,
 * balances, grouping — exists so that these few lines can be written for the
 * owner instead of by him.
 *
 * The research was explicit about why: the reason a debt drags on is not that
 * writing takes ten minutes. It is that asking someone for money is
 * uncomfortable. The owner is not buying time here; he is buying not having to
 * compose the awkward sentence. So the wording carries more weight than any
 * other string in the system.
 *
 * FIVE RULES, each one a decision and not a style preference:
 *
 *  1. ASSUME GOOD FAITH. "אולי פספסת" — never "לא שילמת". The customer is
 *     assumed to have missed it, because most of the time that is the truth,
 *     and because the owner has to keep working with this person tomorrow.
 *
 *  2. NO COUNTDOWN. A date, never "47 days late". A count invites a judgement;
 *     a date states a fact (Constitution, Article 8 — no manufactured anxiety).
 *
 *  3. NO COLLECTIONS VOCABULARY. The words חוב · גבייה · באיחור · התראה do not
 *     appear. They cast the owner as a debt collector — the role he is
 *     embarrassed by, and the fifth emotional friction the research identified.
 *
 *  4. IT SOUNDS LIKE HIM. Short, plain, first person, no corporate register and
 *     no apology. If it does not sound like something he would send, he edits
 *     it — and if he edits every time, the feature has failed.
 *
 *  5. NO AI. A template. Deterministic, reviewable, free, and identical every
 *     time. The owner can trust what he is approving because it does not change
 *     underneath him.
 *
 * Pure: no I/O, no clock, no Prisma. The caller supplies the numbers.
 */

/** One outstanding document as it appears inside a message. */
export interface MessageInvoiceLine {
  readonly documentNumber: string | null;
  /** Already formatted for display, e.g. "3,400". */
  readonly amount: string;
  readonly issuedOn: Date;
}

export interface BuildCollectionMessageInput {
  readonly customerName: string;
  /** Total across every outstanding document, formatted. */
  readonly totalAmount: string;
  readonly currencySymbol: string;
  readonly invoices: readonly MessageInvoiceLine[];
  /** Omitted when no link could be produced — the message still works. */
  readonly paymentUrl?: string | null;
  /** The sender, so the message closes the way a person would. */
  readonly businessName: string;
}

/** Hebrew day-month-year, the way an Israeli business owner writes a date. */
export function formatHebrewDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${date.getFullYear()}`;
}

/** Thousands separators. Money is easier to trust when it is easy to read. */
export function formatAmount(value: string | number): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  const [whole, fraction] = n.toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === "00" ? grouped : `${grouped}.${fraction}`;
}

function greeting(customerName: string): string {
  const name = customerName.trim();
  return name.length > 0 ? `היי ${name},` : "היי,";
}

/**
 * Build the message.
 *
 * One document reads as a single reminder; several read as a short list, so the
 * customer can see exactly what is open without asking. Both end the same way:
 * an assumption of good faith and an easy way to pay.
 */
export function buildCollectionMessage(
  input: BuildCollectionMessageInput,
): string {
  const lines: string[] = [greeting(input.customerName), ""];
  const symbol = input.currencySymbol;

  if (input.invoices.length === 1) {
    const only = input.invoices[0];
    const ref = only.documentNumber ? ` ${only.documentNumber}` : "";
    lines.push(
      `רציתי להזכיר שחשבונית${ref} מ-${formatHebrewDate(only.issuedOn)} ` +
        `על סך ${only.amount} ${symbol} עדיין פתוחה אצלי.`,
    );
  } else {
    lines.push(
      `רציתי להזכיר שיש ${input.invoices.length} חשבוניות פתוחות אצלי ` +
        `על סך ${input.totalAmount} ${symbol}:`,
    );
    lines.push("");
    for (const inv of input.invoices) {
      const ref = inv.documentNumber ? `${inv.documentNumber} · ` : "";
      lines.push(`• ${ref}${formatHebrewDate(inv.issuedOn)} · ${inv.amount} ${symbol}`);
    }
  }

  lines.push("");
  // Rule 1 — the sentence that keeps the relationship intact.
  lines.push("אם כבר העברת, אשמח שתעדכן ונסגור את זה.");

  if (input.paymentUrl) {
    lines.push("");
    lines.push(`אפשר גם לשלם כאן: ${input.paymentUrl}`);
  }

  lines.push("");
  lines.push("תודה,");
  lines.push(input.businessName);

  return lines.join("\n");
}
