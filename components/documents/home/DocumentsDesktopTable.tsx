"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { InboxListItem } from "@/lib/documents/inbox-types";
import { formatMoney } from "./home-format";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";
import { categoryLabel } from "@/lib/documents/category-label";

function kindLabel(t: Translator, item: InboxListItem): string {
  if (item.preview.kind === "pdf") return "PDF";
  if (item.preview.kind === "image") return t("documents.common.kindImage");
  return t("documents.common.kindFile");
}

function statusLabel(t: Translator, status: string): { text: string; ok: boolean } {
  if (status === "needs_review") return { text: t("documents.inbox.statusPending"), ok: false };
  if (status === "approved" || status === "verified") return { text: t("documents.inbox.statusApproved"), ok: true };
  return { text: status || "—", ok: false };
}

/**
 * Dense document list for the desktop workspace. Hidden below 1200px by
 * `.dz-docs-table { display: none }` — mobile keeps the station/card flow.
 */
export default function DocumentsDesktopTable({
  items,
  loading,
  error,
  onRetry,
}: {
  items: InboxListItem[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const router = useRouter();
  const { t, locale, formatDate } = useI18n();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = items.find((item) => item.documentId === selectedId) ?? null;

  return (
    <div className="dz-docs-work">
    <section className="dz-docs-table" aria-label={t("documents.home.tableAria")}>
      {loading ? <p className="dz-docs-empty">{t("documents.home.loadingDocs")}</p> : null}
      {!loading && error ? (
        <div className="dz-docs-empty">
          <p>{error}</p>
          <button type="button" onClick={onRetry}>
            {t("documents.common.retry")}
          </button>
        </div>
      ) : null}
      {!loading && !error && items.length === 0 ? (
        <p className="dz-docs-empty">{t("documents.home.emptyMonth")}</p>
      ) : null}
      {!loading && !error && items.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t("documents.home.colDocument")}</th>
              <th>{t("documents.home.colType")}</th>
              <th>{t("documents.home.colParty")}</th>
              <th>{t("documents.review.fields.date")}</th>
              <th>{t("documents.review.fields.amount")}</th>
              <th>{t("documents.home.colStatus")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const vendor =
                item.financial?.vendorName ?? item.extracted?.vendorName ?? t("documents.common.notSpecified");
              const amountRaw = item.financial?.amount ?? item.extracted?.amount ?? null;
              const dateIso = item.financial?.date ?? item.extracted?.date ?? item.createdAt;
              const status = statusLabel(t, item.status);
              return (
                <tr
                  key={item.documentId}
                  className={item.documentId === selectedId ? "is-selected" : undefined}
                  onClick={() => setSelectedId(item.documentId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedId(item.documentId);
                    }
                  }}
                  tabIndex={0}
                >
                  <td>{vendor}</td>
                  <td>{kindLabel(t, item)}</td>
                  <td>{vendor}</td>
                  <td className="num">{formatDate(dateIso, "date")}</td>
                  <td className="num">
                    {amountRaw != null && Number.isFinite(amountRaw) ? formatMoney(amountRaw, locale) : "—"}
                  </td>
                  <td>
                    <span className={status.ok ? "dz-docs-pill dz-docs-pill--ok" : "dz-docs-pill"}>
                      {status.text}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </section>
    <aside className="dz-docs-inspector" aria-label={t("documents.home.inspectorAria")}>
      {selected ? (
        <HubInspector item={selected} onOpen={() => router.push(`/documents/review/${selected.documentId}`)} />
      ) : (
        <p>
          {items.length === 0
            ? t("documents.home.inspectorEmpty")
            : t("documents.home.inspectorHint")}
        </p>
      )}
    </aside>
    </div>
  );
}

function HubInspector({ item, onOpen }: { item: InboxListItem; onOpen: () => void }) {
  const { t, locale, formatDate } = useI18n();
  const vendor = item.financial?.vendorName ?? item.extracted?.vendorName ?? t("documents.common.notSpecified");
  const amountRaw = item.financial?.amount ?? item.extracted?.amount ?? null;
  const dateIso = item.financial?.date ?? item.extracted?.date ?? item.createdAt;
  const categoryRaw = item.financial?.category ?? item.extracted?.category ?? "";
  const category = categoryRaw ? categoryLabel(t, categoryRaw) : t("documents.common.general");
  const status = statusLabel(t, item.status);
  return (
    <>
      <h2>{vendor}</h2>
      <dl>
        <dt>{t("documents.review.fields.date")}</dt>
        <dd>{formatDate(dateIso, "date")}</dd>
        <dt>{t("documents.review.fields.category")}</dt>
        <dd>{category}</dd>
        <dt>{t("documents.review.fields.amount")}</dt>
        <dd>{amountRaw != null && Number.isFinite(amountRaw) ? formatMoney(amountRaw, locale) : "—"}</dd>
        <dt>{t("documents.home.colStatus")}</dt>
        <dd>{status.text}</dd>
        <dt>{t("documents.inbox.source")}</dt>
        <dd>{item.source || "—"}</dd>
      </dl>
      <button type="button" onClick={onOpen}>
        {t("documents.inbox.openForReview")}
      </button>
    </>
  );
}
