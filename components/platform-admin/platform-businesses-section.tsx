"use client";

import Link from "next/link";
import type { PlatformAdminBusinessesResponse } from "@/lib/services/platform-admin/types";
import { PA } from "./platform-admin-styles";
import { PlatformAdminEmptyState } from "./platform-admin-empty-state";
import { PlatformAdminInlineError } from "./platform-admin-inline-error";

type PlatformBusinessesSectionProps = {
  data: PlatformAdminBusinessesResponse | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  onPageChange: (page: number) => void;
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("he-IL");
  } catch {
    return iso;
  }
}

export function PlatformBusinessesSection({
  data,
  error,
  loading,
  onRetry,
  onPageChange,
}: PlatformBusinessesSectionProps) {
  const pagination = data?.pagination;
  const canPrev = pagination ? pagination.page > 1 : false;
  const canNext = pagination
    ? pagination.page < pagination.totalPages
    : false;

  return (
    <section aria-labelledby="pa-businesses-heading">
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <h2
          id="pa-businesses-heading"
          style={{ margin: 0, fontSize: 15, fontWeight: 600, color: PA.ink }}
        >
          עסקים
        </h2>
        <span style={{ fontSize: 12, color: PA.inkMeta }}>
          חיפוש — בקרוב
        </span>
      </div>

      {error ? (
        <PlatformAdminInlineError message={error} onRetry={onRetry} />
      ) : data && data.items.length === 0 ? (
        <PlatformAdminEmptyState title="אין עסקים להצגה" />
      ) : data ? (
        <>
          <div
            style={{
              overflowX: "auto",
              WebkitOverflowScrolling: "touch",
              border: `1px solid ${PA.border}`,
              borderRadius: PA.radius,
              background: PA.cardBg,
            }}
          >
            <table
              style={{
                width: "100%",
                minWidth: 640,
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr style={{ background: PA.pageBg }}>
                  {[
                    "שם",
                    "נוצר",
                    "משתמשים",
                    "חשבוניות",
                    "מסמכים לבדיקה",
                    "שיחות",
                  ].map((label) => (
                    <th
                      key={label}
                      style={{
                        textAlign: "right",
                        padding: "10px 12px",
                        fontWeight: 600,
                        color: PA.inkSecondary,
                        borderBottom: `1px solid ${PA.border}`,
                      }}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => (
                  <tr key={row.id}>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: `1px solid ${PA.border}`,
                        fontWeight: 600,
                      }}
                    >
                      <Link
                        href={`/admin/businesses/${row.id}`}
                        style={{
                          color: PA.ink,
                          textDecoration: "none",
                        }}
                      >
                        {row.name}
                      </Link>
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: `1px solid ${PA.border}`,
                        color: PA.inkMuted,
                      }}
                    >
                      {formatDate(row.createdAt)}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: `1px solid ${PA.border}`,
                      }}
                    >
                      {row.usersCount}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: `1px solid ${PA.border}`,
                      }}
                    >
                      {row.counts.billingDocuments}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: `1px solid ${PA.border}`,
                      }}
                    >
                      {row.counts.documentsNeedsReview}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: `1px solid ${PA.border}`,
                      }}
                    >
                      {row.counts.conversations}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              marginTop: 12,
            }}
          >
            <span style={{ fontSize: 13, color: PA.inkMuted }}>
              עמוד {pagination?.page ?? 1} מתוך {pagination?.totalPages ?? 1}
              {pagination ? ` · ${pagination.total} עסקים` : ""}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                disabled={!canPrev || loading}
                onClick={() => onPageChange((pagination?.page ?? 1) - 1)}
                style={{
                  border: `1px solid ${PA.border}`,
                  background: PA.cardBg,
                  borderRadius: 8,
                  padding: "6px 12px",
                  fontSize: 13,
                  cursor: canPrev && !loading ? "pointer" : "not-allowed",
                  opacity: canPrev && !loading ? 1 : 0.5,
                }}
              >
                הקודם
              </button>
              <button
                type="button"
                disabled={!canNext || loading}
                onClick={() => onPageChange((pagination?.page ?? 1) + 1)}
                style={{
                  border: `1px solid ${PA.border}`,
                  background: PA.cardBg,
                  borderRadius: 8,
                  padding: "6px 12px",
                  fontSize: 13,
                  cursor: canNext && !loading ? "pointer" : "not-allowed",
                  opacity: canNext && !loading ? 1 : 0.5,
                }}
              >
                הבא
              </button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
