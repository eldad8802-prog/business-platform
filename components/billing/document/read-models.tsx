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
import { useI18n } from "@/components/i18n/I18nProvider";
import {
  STATUS_STYLE,
  formatDate,
  formatDateTime,
  formatMoney,
  formatPercent,
  formatQuantity,
  getDocumentTypeLabel,
  getStatusLabel,
  type BillingDocumentDetail,
  type BillingDocumentLine,
  type BillingStatus,
} from "@/lib/billing/document-view-model";

export function StatusBadge({ status }: { status: BillingStatus }) {
  const { t } = useI18n();
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
      {getStatusLabel(status, t)}
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
  const { t } = useI18n();
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
      aria-label={t("billing.doc.customerAria")}
    >
      <span style={{ color: TOKEN.ink.muted }}>{t("billing.doc.customerPrefix")}</span>
      <span style={{ color: TOKEN.ink.primary, fontWeight: 600 }}>
        {doc.customerNameSnapshot ?? t("billing.doc.notSet")}
      </span>
    </section>
  );
}

export function ReviewSummaryCard({ doc }: { doc: BillingDocumentDetail }) {
  const { t, locale } = useI18n();
  const customer = doc.customerNameSnapshot ?? t("billing.doc.notSet");
  const total = formatMoney(doc.totalAmount, doc.currency, locale);
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
      aria-label={t("billing.doc.reviewAria")}
    >
      <div style={{ fontSize: 15, fontWeight: 600, color: TOKEN.ink.primary }}>
        {t("billing.doc.reviewTitle")}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <ReviewSummaryRow label={t("billing.doc.customer")} value={customer} />
        <ReviewSummaryRow
          label={t("billing.doc.items")}
          value={itemCount === 1 ? t("billing.doc.itemsOne") : t("billing.doc.itemsMany", { count: itemCount })}
        />
        <ReviewSummaryRow label={t("billing.doc.amount")} value={total} emphasized />
      </div>
      <div style={{ fontSize: 12, color: TOKEN.ink.muted, lineHeight: 1.5 }}>
        {isQuote
          ? t("billing.doc.reviewQuoteNote")
          : doc.status === "ISSUED"
          ? t("billing.doc.reviewIssuedNote")
          : t("billing.doc.reviewDraftNote")}
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
          textAlign: "end",
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
  const { t, locale } = useI18n();
  const customer = doc.customerNameSnapshot ?? "—";
  const created = formatDateTime(doc.createdAt, locale);
  const issued = formatDateTime(doc.issuedAt, locale);
  const validUntil =
    doc.documentType === "QUOTE" && doc.validUntil
      ? formatDate(doc.validUntil, locale)
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
        {t("billing.doc.detailsTitle")}
      </h2>
      <dl style={{ display: "grid", gap: 10, margin: 0 }}>
        {hideCustomer ? null : <DetailRow label={t("billing.doc.customer")} value={customer} />}
        <DetailRow
          label={t("billing.doc.docType")}
          value={getDocumentTypeLabel(doc.documentType, t)}
        />
        <DetailRow label={t("billing.doc.status")} value={getStatusLabel(doc.status, t)} />
        {validUntil ? (
          <DetailRow label={t("billing.doc.validUntil")} value={validUntil} />
        ) : null}
        {created ? <DetailRow label={t("billing.doc.created")} value={created} /> : null}
        {issued ? <DetailRow label={t("billing.doc.issued")} value={issued} /> : null}
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
          textAlign: "end",
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
  const { t, locale } = useI18n();
  const subtotal = formatMoney(doc.subtotalAmount, doc.currency, locale);
  const vat = formatMoney(doc.vatAmount, doc.currency, locale);
  const total = formatMoney(doc.totalAmount, doc.currency, locale);

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
        {t("billing.doc.totalsTitle")}
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
          {t("billing.doc.unsavedHint")}
        </div>
      ) : null}
      <div style={{ display: "grid", gap: 8 }}>
        <TotalRow label={t("billing.doc.subtotal")} value={subtotal} />
        <TotalRow label={t("billing.doc.vat")} value={vat} />
        <div
          style={{
            height: 1,
            background: TOKEN.border.DEFAULT,
            margin: "4px 0",
          }}
        />
        <TotalRow label={t("billing.doc.totalDue")} value={total} emphasized />
        <div
          style={{
            fontSize: 12,
            color: TOKEN.ink.meta,
            marginTop: 4,
            textAlign: "end",
          }}
        >
          {t("billing.doc.amountsIn", { currency: doc.currency })}
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
  const { t } = useI18n();
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
        {t("billing.doc.linesTitle", { count: lines.length })}
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
          {t("billing.doc.noLines")}
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
  const { t, locale } = useI18n();
  const qty = formatQuantity(line.quantity, locale);
  const unit = formatMoney(line.unitPrice, currency, locale);
  const subtotal = formatMoney(line.lineSubtotal, currency, locale);
  const vatLabel = formatPercent(line.vatRatePercent, locale);
  const vat = formatMoney(line.vatAmount, currency, locale);
  const total = formatMoney(line.lineTotal, currency, locale);

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
        <span>{t("billing.doc.lineQty", { qty })}</span>
        <span style={{ color: TOKEN.border.hover }}>·</span>
        <span>{t("billing.doc.lineUnitPrice", { price: unit })}</span>
        <span style={{ color: TOKEN.border.hover }}>·</span>
        <span>{t("billing.doc.lineSubtotal", { amount: subtotal })}</span>
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
        <span>{t("billing.doc.lineVat", { rate: vatLabel })}</span>
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
          {t("billing.doc.lineTotal")}
        </span>
        <span style={{ fontSize: 15, fontWeight: 600, color: TOKEN.ink.primary }}>
          {total}
        </span>
      </div>
    </li>
  );
}
