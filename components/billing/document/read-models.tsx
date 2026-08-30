"use client";

/**
 * Billing document read models — the display-only surfaces of the document
 * workspace: status, summaries, details, lines and totals.
 *
 * Extracted verbatim from `app/billing/[id]/page.tsx` (B1, mechanical
 * decomposition): same components, same behavior, different file boundary.
 *
 * Every figure these render arrives from the server already computed. They
 * format, they never derive — see docs/billing-adaptive-design-report-v1.md §8.
 */
import type { ReactNode } from "react";
import { TOKEN } from "@/lib/design/billing-theme";
import {
  DOCUMENT_TYPE_LABEL,
  STATUS_LABEL,
  STATUS_STYLE,
  formatDate,
  formatDateTime,
  formatMoney,
  formatPercent,
  formatQuantity,
  getDocumentTypeLabel,
  type BillingDocumentDetail,
  type BillingDocumentLine,
  type BillingStatus,
} from "@/lib/billing/document-view-model";

export function StatusBadge({ status }: { status: BillingStatus }) {
  const style = STATUS_STYLE[status];
  return (
    <span
      style={{
        padding: "4px 12px",
        borderRadius: 999,
        border: `1px solid ${style.border}`,
        background: style.bg,
        color: style.fg,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function CollapsiblePanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details
      style={{
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: 14,
        background: TOKEN.surface.card,
        padding: "10px 14px",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 600,
          color: TOKEN.ink.secondary,
        }}
      >
        {title}
      </summary>
      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>{children}</div>
    </details>
  );
}

export function CustomerSummaryCard({ doc }: { doc: BillingDocumentDetail }) {
  return (
    <section
      style={{
        background: TOKEN.surface.card,
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: 14,
        padding: "10px 14px",
        color: TOKEN.ink.secondary,
        fontSize: 13,
      }}
      aria-label="לקוח במסמך"
    >
      <span style={{ color: TOKEN.ink.muted }}>לקוח: </span>
      <span style={{ color: TOKEN.ink.primary, fontWeight: 600 }}>
        {doc.customerNameSnapshot ?? "לא הוגדר"}
      </span>
    </section>
  );
}

export function ReviewSummaryCard({ doc }: { doc: BillingDocumentDetail }) {
  const customer = doc.customerNameSnapshot ?? "לא הוגדר";
  const total = formatMoney(doc.totalAmount, doc.currency);
  const itemCount = doc.lines.length;
  const isQuote = doc.documentType === "QUOTE";

  return (
    <section
      style={{
        background: TOKEN.surface.card,
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: 14,
        padding: 16,
        display: "grid",
        gap: 10,
      }}
      aria-label="בדיקת המסמך"
    >
      <div style={{ fontSize: 15, fontWeight: 600, color: TOKEN.ink.primary }}>
        בדיקה קצרה
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <ReviewSummaryRow label="לקוח" value={customer} />
        <ReviewSummaryRow
          label="פריטים"
          value={itemCount === 1 ? "פריט אחד" : `${itemCount} פריטים`}
        />
        <ReviewSummaryRow label="סכום" value={total} emphasized />
      </div>
      <div style={{ fontSize: 12, color: TOKEN.ink.muted, lineHeight: 1.5 }}>
        {isQuote
          ? "זה מה שהלקוח יקבל בהצעה."
          : doc.status === "ISSUED"
          ? "זה המסמך הרשמי שמוכן לשיתוף."
          : "לאחר ההפקה המסמך יקבל מספר רשמי ויינעל לעריכה."}
      </div>
    </section>
  );
}

export function ReviewSummaryRow({
  label,
  value,
  emphasized = false,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        alignItems: "baseline",
      }}
    >
      <span style={{ fontSize: 13, color: TOKEN.ink.muted }}>{label}</span>
      <span
        style={{
          fontSize: emphasized ? 16 : 14,
          color: TOKEN.ink.primary,
          fontWeight: 600,
          textAlign: "left",
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function DetailsCard({
  doc,
  hideCustomer = false,
}: {
  doc: BillingDocumentDetail;
  hideCustomer?: boolean;
}) {
  const customer = doc.customerNameSnapshot ?? "—";
  const created = formatDateTime(doc.createdAt);
  const issued = formatDateTime(doc.issuedAt);
  const validUntil =
    doc.documentType === "QUOTE" && doc.validUntil
      ? formatDate(doc.validUntil)
      : "";

  return (
    <section
      style={{
        background: TOKEN.surface.card,
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: 14,
        padding: 16,
      }}
    >
      <h2
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: TOKEN.ink.primary,
          margin: "0 0 12px 0",
          letterSpacing: "0.02em",
        }}
      >
        פרטי המסמך ללקוח
      </h2>
      <dl style={{ display: "grid", gap: 10, margin: 0 }}>
        {hideCustomer ? null : <DetailRow label="לקוח" value={customer} />}
        <DetailRow
          label="סוג מסמך"
          value={getDocumentTypeLabel(doc.documentType)}
        />
        <DetailRow label="סטטוס" value={STATUS_LABEL[doc.status] ?? doc.status} />
        {validUntil ? (
          <DetailRow label="בתוקף עד" value={validUntil} />
        ) : null}
        {created ? <DetailRow label="נוצר" value={created} /> : null}
        {issued ? <DetailRow label="הופק" value={issued} /> : null}
      </dl>
    </section>
  );
}

export function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <dt
        style={{
          fontSize: 13,
          color: TOKEN.ink.muted,
          margin: 0,
          fontWeight: 500,
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          fontSize: 14,
          color: TOKEN.ink.primary,
          margin: 0,
          fontWeight: 600,
          textAlign: "left",
        }}
      >
        {value}
      </dd>
    </div>
  );
}

export function TotalsCard({
  doc,
  showUnsavedLinesHint = false,
}: {
  doc: BillingDocumentDetail;
  showUnsavedLinesHint?: boolean;
}) {
  const subtotal = formatMoney(doc.subtotalAmount, doc.currency);
  const vat = formatMoney(doc.vatAmount, doc.currency);
  const total = formatMoney(doc.totalAmount, doc.currency);

  return (
    <section
      style={{
        background: TOKEN.surface.card,
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: 14,
        padding: 16,
      }}
    >
      <h2
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: TOKEN.ink.primary,
          margin: "0 0 12px 0",
          letterSpacing: "0.02em",
        }}
      >
        סיכום לתשלום
      </h2>
      {showUnsavedLinesHint ? (
        <div
          style={{
            fontSize: 12,
            color: TOKEN.ink.muted,
            marginBottom: 10,
            lineHeight: 1.5,
            padding: "8px 10px",
            background: TOKEN.surface.inset,
            borderRadius: 8,
            border: `1px solid ${TOKEN.border.DEFAULT}`,
          }}
        >
          יש שינויים שלא נשמרו — הסכומים משקפים את הגרסה האחרונה שנשמרה
        </div>
      ) : null}
      <div style={{ display: "grid", gap: 8 }}>
        <TotalRow label="סכום ביניים" value={subtotal} />
        <TotalRow label='מע"מ' value={vat} />
        <div
          style={{
            height: 1,
            background: TOKEN.border.DEFAULT,
            margin: "4px 0",
          }}
        />
        <TotalRow label='סה"כ לתשלום' value={total} emphasized />
        <div
          style={{
            fontSize: 12,
            color: TOKEN.ink.meta,
            marginTop: 4,
            textAlign: "left",
          }}
        >
          סכומים ב־{doc.currency}
        </div>
      </div>
    </section>
  );
}

export function TotalRow({
  label,
  value,
  emphasized = false,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
      }}
    >
      <span
        style={{
          fontSize: emphasized ? 15 : 14,
          color: emphasized ? TOKEN.ink.primary : TOKEN.ink.secondary,
          fontWeight: emphasized ? 600 : 500,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: emphasized ? 18 : 14,
          color: TOKEN.ink.primary,
          fontWeight: emphasized ? 600 : 600,
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function LinesSection({
  lines,
  currency,
}: {
  lines: BillingDocumentLine[];
  currency: string;
}) {
  return (
    <section
      style={{
        background: TOKEN.surface.card,
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: 14,
        padding: 16,
      }}
    >
      <h2
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: TOKEN.ink.primary,
          margin: "0 0 12px 0",
          letterSpacing: "0.02em",
        }}
      >
        פריטים במסמך ({lines.length})
      </h2>
      {lines.length === 0 ? (
        <div
          style={{
            border: `1px dashed ${TOKEN.border.hover}`,
            borderRadius: 10,
            padding: 16,
            textAlign: "center",
            color: TOKEN.ink.muted,
            fontSize: 14,
          }}
        >
          אין פריטים במסמך
        </div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "grid",
            gap: 8,
          }}
        >
          {lines.map((line) => (
            <LineCard key={line.id} line={line} currency={currency} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function LineCard({
  line,
  currency,
}: {
  line: BillingDocumentLine;
  currency: string;
}) {
  const qty = formatQuantity(line.quantity);
  const unit = formatMoney(line.unitPrice, currency);
  const subtotal = formatMoney(line.lineSubtotal, currency);
  const vatLabel = formatPercent(line.vatRatePercent);
  const vat = formatMoney(line.vatAmount, currency);
  const total = formatMoney(line.lineTotal, currency);

  return (
    <li
      style={{
        background: TOKEN.surface.inset,
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: 10,
        padding: 12,
        display: "grid",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            flex: 1,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: TOKEN.ink.secondary,
              background: TOKEN.border.DEFAULT,
              borderRadius: 6,
              padding: "2px 8px",
              flexShrink: 0,
            }}
          >
            #{line.lineIndex}
          </span>
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: TOKEN.ink.primary,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={line.description}
          >
            {line.description}
          </span>
        </div>
      </div>

      <div
        style={{
          fontSize: 13,
          color: TOKEN.ink.secondary,
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <span>כמות: {qty}</span>
        <span style={{ color: TOKEN.border.hover }}>·</span>
        <span>מחיר ליחידה: {unit}</span>
        <span style={{ color: TOKEN.border.hover }}>·</span>
        <span>סכום: {subtotal}</span>
      </div>

      <div
        style={{
          fontSize: 13,
          color: TOKEN.ink.secondary,
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <span>מע&quot;מ {vatLabel}:</span>
        <span style={{ fontWeight: 600, color: TOKEN.ink.primary }}>{vat}</span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          borderTop: `1px solid ${TOKEN.border.DEFAULT}`,
          paddingTop: 8,
        }}
      >
        <span style={{ fontSize: 13, color: TOKEN.ink.secondary, fontWeight: 500 }}>
          סה&quot;כ פריט
        </span>
        <span style={{ fontSize: 15, fontWeight: 600, color: TOKEN.ink.primary }}>
          {total}
        </span>
      </div>
    </li>
  );
}
