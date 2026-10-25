"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import type { CustomerListRow } from "@/lib/api/customers";
import { useI18n } from "@/components/i18n/I18nProvider";
import { ContactAction } from "@/components/customers/ContactAction";
import { customerInitials, telHref, whatsAppChatHref } from "@/components/customers/customer-contact";
import {
  ChevronIcon,
  FolderIcon,
  MailIcon,
  PhoneIcon,
  PinIcon,
  WhatsappIcon,
} from "@/components/customers/customer-icons";

/**
 * One customer card in the list — initials, name, status and the contact
 * lines the customer actually has (phone · city · email), then a footer of
 * three equal actions: call, WhatsApp, open the customer file.
 *
 * The upper part is a next/link to the file (a client navigation that keeps
 * the stable list mounted). The footer actions are siblings of that link, not
 * children, so a call or a WhatsApp tap never also opens the file. `selected`
 * adds only a subtle marker + `aria-current` for the desktop Master–Detail.
 */

export function CustomerRow({
  customer,
  selected = false,
}: {
  customer: CustomerListRow;
  selected?: boolean;
}) {
  const { t } = useI18n();
  const href = `/customers/${customer.id}`;
  const phone = customer.phone?.trim() ? customer.phone : null;
  const tel = telHref(phone);
  const whatsapp = whatsAppChatHref(phone);
  const lines: Array<{ key: string; icon: ReactNode; tone: string; value: string }> = [];
  if (phone) lines.push({ key: "phone", icon: <PhoneIcon />, tone: "phone", value: formatPhoneForDisplay(phone) });
  if (customer.city?.trim()) lines.push({ key: "city", icon: <PinIcon />, tone: "file", value: customer.city });
  if (customer.email?.trim()) lines.push({ key: "email", icon: <MailIcon />, tone: "mail", value: customer.email });

  return (
    <article className={`cust-card${selected ? " cust-card--selected" : ""}`}>
      <Link className="cust-card__main" href={href} aria-current={selected ? "true" : undefined}>
        <span className="cust-avatar" aria-hidden>
          {customerInitials(customer.name)}
        </span>
        <span className="cust-card__body">
          <span className="cust-card__head">
            <span className="cust-card__name">
              <bdi>{customer.name}</bdi>
            </span>
            {/* Sibling of the name, never inside it: the name is clamped to two
                lines and a badge inside it would be clipped on long names. */}
            <span className={customer.isActive ? "crm-badge crm-badge--success" : "crm-badge"}>
              {customer.isActive ? t("customers.customer.row.active") : t("customers.customer.row.inactive")}
            </span>
          </span>
          {lines.length > 0 ? (
            <span className="cust-lines">
              {lines.map((l) => (
                <span className={`cust-line cust-tone--${l.tone}`} key={l.key}>
                  <span className="cust-line__icon" aria-hidden>
                    {l.icon}
                  </span>
                  <bdi className="cust-line__value">{l.value}</bdi>
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </Link>

      <div className="cust-card__actions">
        <ContactAction
          href={tel}
          tone="phone"
          icon={<PhoneIcon />}
          label={t("customers.customer.row.call")}
          ariaLabel={t("customers.customer.row.callAria", { name: customer.name })}
          unavailableReason={t("customers.customer.row.noPhone")}
        />
        <ContactAction
          href={whatsapp}
          tone="whatsapp"
          icon={<WhatsappIcon />}
          label={t("customers.customer.row.whatsapp")}
          ariaLabel={t("customers.customer.row.whatsappAria", { name: customer.name })}
          unavailableReason={phone ? t("customers.customer.row.noWhatsapp") : t("customers.customer.row.noPhone")}
        />
        <Link
          className="cust-action cust-action--row cust-tone--file"
          href={href}
          aria-label={t("customers.customer.row.openAria", { name: customer.name })}
        >
          <span className="cust-action__tile" aria-hidden>
            <FolderIcon />
          </span>
          <span className="cust-action__label">{t("customers.customer.row.open")}</span>
          <ChevronIcon className="cust-action__chev" />
        </Link>
      </div>
    </article>
  );
}
