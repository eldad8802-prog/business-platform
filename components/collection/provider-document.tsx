"use client";

/**
 * The document CardCom states it issued for a foreign-currency payment — its
 * type and number, and a link to CardCom's OWN copy of it.
 *
 * Shown only when the read model carries a verified `providerDocument` (a
 * foreign-currency request on a connection where CardCom issues the documents;
 * see payment-verification.service). The link opens CardCom's URL directly in
 * a new tab — Dubiz never fetches or proxies the document — and only an https
 * link on CardCom's own hosts ever reaches here (cardcom.provider →
 * cardComDocumentUrl, payment-evidence → verifiedProviderDocument).
 */
import { TOKEN } from "@/lib/design/tokens";
import type { MessageKey, Translator } from "@/lib/i18n/translate";
import type { ProviderIssuedDocument } from "@/lib/services/payments/providers/payment-provider.types";

const W = TOKEN.warm;

/** CardCom document types with an owner-facing name; any other type is shown as CardCom states it. */
export const PROVIDER_DOCUMENT_TYPES = ["TaxInvoiceAndReceipt", "Receipt", "TaxInvoice", "ReceiptForTaxInvoice"] as const;

export function providerDocumentText(doc: ProviderIssuedDocument, t: Translator): string {
  const known = (PROVIDER_DOCUMENT_TYPES as readonly string[]).includes(doc.type);
  const type = known ? t(`money.collection.providerDocumentType.${doc.type}` as MessageKey) : doc.type;
  return t("money.collection.shared.providerDocument", { type, number: doc.number });
}

export function ProviderDocumentNote({ doc, t }: { doc: ProviderIssuedDocument | null | undefined; t: Translator }) {
  if (!doc) return null;
  return (
    <span data-provider-document={doc.number}>
      {providerDocumentText(doc, t)}
      {doc.url ? (
        <>
          {" · "}
          <a href={doc.url} target="_blank" rel="noopener noreferrer" style={{ color: W.tealDeep }}>
            {t("money.collection.shared.providerDocumentOpen")}
          </a>
        </>
      ) : null}
    </span>
  );
}
