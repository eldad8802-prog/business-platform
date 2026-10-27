"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import type { SupplierListRow } from "@/lib/api/suppliers";
import { useI18n } from "@/components/i18n/I18nProvider";
import { ContactAction } from "@/components/customers/ContactAction";
import { customerInitials, mailHref, telHref } from "@/components/customers/customer-contact";
import { ChevronIcon, FolderIcon, MailIcon, PhoneIcon } from "@/components/customers/customer-icons";

/**
 * One supplier card in the list — the customers card language (`cust-*`):
 * initials, name, status and the contact lines the supplier actually has, then
 * three equal actions: call, email, open the supplier file.
 *
 * The upper part is a next/link to the file (a client navigation that keeps the
 * stable list mounted). The footer actions are siblings of that link, never
 * children, so a call or an email never also opens the file. A missing or
 * unusable phone / email renders as a visibly unavailable action, not a link.
 * The list API returns phone and email only (no address), so those are the
 * lines shown here; the address lives in the supplier file.
 */
export function SupplierRow({ supplier, selected = false }: { supplier: SupplierListRow; selected?: boolean }) {
  const { t } = useI18n();
  const href = `/suppliers/${supplier.id}`;
  const phone = supplier.phone?.trim() ? supplier.phone : null;
  const email = supplier.email?.trim() ? supplier.email : null;
  const lines: Array<{ key: string; icon: ReactNode; tone: string; value: string }> = [];
  if (phone) lines.push({ key: "phone", icon: <PhoneIcon />, tone: "phone", value: formatPhoneForDisplay(phone) });
  if (email) lines.push({ key: "email", icon: <MailIcon />, tone: "mail", value: email });

  return (
    <article className={`cust-card${selected ? " cust-card--selected" : ""}`}>
      <Link className="cust-card__main" href={href} aria-current={selected ? "true" : undefined}>
        <span className="cust-avatar" aria-hidden>
          {customerInitials(supplier.name)}
        </span>
        <span className="cust-card__body">
          <span className="cust-card__head">
            <span className="cust-card__name">
              <bdi>{supplier.name}</bdi>
            </span>
            {/* Sibling of the name, never inside it: the name is clamped to two
                lines and a badge inside it would be clipped on long names. */}
            <span className={supplier.isActive ? "crm-badge crm-badge--success" : "crm-badge"}>
              {supplier.isActive ? t("customers.suppliers.card.active") : t("customers.suppliers.common.inactiveBadge")}
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
          href={telHref(phone)}
          tone="phone"
          icon={<PhoneIcon />}
          label={t("customers.customer.row.call")}
          ariaLabel={t("customers.customer.row.callAria", { name: supplier.name })}
          unavailableReason={t("customers.customer.row.noPhone")}
        />
        <ContactAction
          href={mailHref(email)}
          tone="mail"
          icon={<MailIcon />}
          label={t("customers.customer.card.quick.email")}
          ariaLabel={`${t("customers.customer.card.quick.email")} · ${supplier.name}`}
          unavailableReason={t("customers.customer.card.quick.noEmail")}
        />
        <Link
          className="cust-action cust-action--row cust-tone--file"
          href={href}
          aria-label={t("customers.suppliers.list.openFileAria", { name: supplier.name })}
        >
          <span className="cust-action__tile" aria-hidden>
            <FolderIcon />
          </span>
          <span className="cust-action__label">{t("customers.suppliers.list.openFile")}</span>
          <ChevronIcon className="cust-action__chev" />
        </Link>
      </div>
    </article>
  );
}
