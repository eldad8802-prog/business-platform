/**
 * The secondary line of a CRM row (Customers / Leads / Suppliers).
 *
 * WHY THIS EXISTS. Every list used to build this line by joining its values into
 * ONE string — `[phone, email, city].join(" · ")` — and dropping it into a span.
 * That single string caused two separate defects at once:
 *
 *  1. OVERFLOW. `.crm-row__meta` carried `white-space: nowrap` with an
 *     `overflow: hidden` that a non-replaced inline box ignores, so the joined
 *     line could not wrap, could not be clipped, and ran straight out of the
 *     card. Rendering the values as individual flex items lets the line WRAP on
 *     a narrow screen instead of colliding or vanishing — the values stack,
 *     nothing is thrown away.
 *
 *  2. BIDI. A phone number, an email and a Hebrew city in one RTL string are
 *     re-ordered by the bidi algorithm, and the neutral "·" separators attach
 *     themselves to whichever run wins — so the parts appear in an order nobody
 *     wrote. Each value is isolated (`.crm-row__meta-part`, `unicode-bidi:
 *     isolate`) and the separator is generated in CSS rather than living in the
 *     text run, so the reading order is exactly the order passed in.
 *
 * Presentation only: it takes values already formatted by the caller, drops the
 * empty ones, and renders nothing at all when none survive.
 */
export function CrmRowMeta({
  parts,
  className,
  style,
}: {
  /** Display-ready values, in reading order. Empty / null entries are dropped. */
  parts: Array<string | null | undefined>;
  /** Extra classes, appended to `crm-row__meta`. */
  className?: string;
  style?: React.CSSProperties;
}) {
  const shown = parts.filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  if (shown.length === 0) return null;

  return (
    <span
      className={className ? `crm-row__meta ${className}` : "crm-row__meta"}
      style={style}
    >
      {shown.map((part, i) => (
        // Index key: these are positional display fragments of one line, not
        // entities — there is nothing stabler to key on and no reordering.
        <span className="crm-row__meta-part" key={`${i}-${part}`}>
          {part}
        </span>
      ))}
    </span>
  );
}
