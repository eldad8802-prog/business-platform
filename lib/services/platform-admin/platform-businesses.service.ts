import { Prisma } from "@prisma/client";
import { getPrismaAdmin } from "@/lib/prisma-admin";
import { ValidationError } from "@/lib/errors";
import { PLATFORM_SYSTEM_BUSINESS_NAME } from "./constants";
import type {
  PlatformAdminBusinessesResponse,
  PlatformAdminBusinessFilter,
  PlatformAdminBusinessListItem,
} from "./types";

const DOCUMENT_NEEDS_REVIEW_STATUS = "needs_review";

/** "New" = joined within this many days. */
export const BUSINESS_NEW_WINDOW_DAYS = 7;
/** "Inactive" = no user session used within this many days. */
export const BUSINESS_INACTIVE_WINDOW_DAYS = 14;
/** Longest accepted search string. Longer input is a typo or an abuse, not a lookup. */
export const BUSINESS_SEARCH_MAX_LENGTH = 120;

const SORT_FIELDS = ["createdAt", "name", "id"] as const;
type SortField = (typeof SORT_FIELDS)[number];

const FILTERS: readonly PlatformAdminBusinessFilter[] = [
  "all",
  "new",
  "inactive",
  "no_onboarding",
];

export type ListPlatformBusinessesInput = {
  page: number;
  limit: number;
  sort: SortField;
  order: "asc" | "desc";
  /** Trimmed search text; null = no search. */
  q: string | null;
  filter: PlatformAdminBusinessFilter;
};

function parseSortField(value: string | null): SortField {
  if (value && SORT_FIELDS.includes(value as SortField)) {
    return value as SortField;
  }
  return "createdAt";
}

function parseOrder(value: string | null): "asc" | "desc" {
  return value === "asc" ? "asc" : "desc";
}

function parseFilter(value: string | null): PlatformAdminBusinessFilter {
  if (value === null || value === "") return "all";
  if (FILTERS.includes(value as PlatformAdminBusinessFilter)) {
    return value as PlatformAdminBusinessFilter;
  }
  throw new ValidationError("filter must be one of all, new, inactive, no_onboarding");
}

function parseSearch(value: string | null): string | null {
  const q = value?.trim() ?? "";
  if (q === "") return null;
  if (q.length > BUSINESS_SEARCH_MAX_LENGTH) {
    throw new ValidationError(`q must be at most ${BUSINESS_SEARCH_MAX_LENGTH} characters`);
  }
  return q;
}

export function parseListPlatformBusinessesQuery(
  searchParams: URLSearchParams
): ListPlatformBusinessesInput {
  const pageParam = searchParams.get("page") ?? "1";
  const limitParam = searchParams.get("limit") ?? "20";
  const page = Number(pageParam);
  const limit = Number(limitParam);

  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError("page must be a positive number");
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError("limit must be a number between 1 and 100");
  }

  return {
    page,
    limit,
    sort: parseSortField(searchParams.get("sort")),
    order: parseOrder(searchParams.get("order")),
    q: parseSearch(searchParams.get("q")),
    filter: parseFilter(searchParams.get("filter")),
  };
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * The WHERE clause for a list request. Pure (the clock is a parameter) so the
 * filter semantics are testable without a database.
 *
 *   - the internal platform business and purged businesses are never listed;
 *   - search: an all-digit query also matches the business id; any query
 *     matches the business name or a user's email (case-insensitive substring);
 *   - new: joined within BUSINESS_NEW_WINDOW_DAYS;
 *   - inactive: no user of the business has used a session within
 *     BUSINESS_INACTIVE_WINDOW_DAYS;
 *   - no_onboarding: no profile, or the profile has no completion stamp.
 */
export function buildBusinessListWhere(
  input: Pick<ListPlatformBusinessesInput, "q" | "filter">,
  now: Date
): Prisma.BusinessWhereInput {
  const and: Prisma.BusinessWhereInput[] = [
    { name: { not: PLATFORM_SYSTEM_BUSINESS_NAME } },
    { deletedAt: null },
  ];

  if (input.q) {
    const or: Prisma.BusinessWhereInput[] = [
      { name: { contains: input.q, mode: "insensitive" } },
      { users: { some: { email: { contains: input.q, mode: "insensitive" } } } },
    ];
    if (/^\d{1,9}$/.test(input.q)) {
      or.unshift({ id: Number(input.q) });
    }
    and.push({ OR: or });
  }

  switch (input.filter) {
    case "new":
      and.push({ createdAt: { gte: daysBefore(now, BUSINESS_NEW_WINDOW_DAYS) } });
      break;
    case "inactive":
      and.push({
        users: {
          none: {
            authSessions: {
              some: { lastUsedAt: { gte: daysBefore(now, BUSINESS_INACTIVE_WINDOW_DAYS) } },
            },
          },
        },
      });
      break;
    case "no_onboarding":
      and.push({
        OR: [{ profile: { is: null } }, { profile: { is: { onboardingCompletedAt: null } } }],
      });
      break;
    case "all":
      break;
  }

  return { AND: and };
}

export function businessLifecycle(row: {
  archivedAt: Date | null;
  deletionRequestedAt: Date | null;
}): PlatformAdminBusinessListItem["lifecycle"] {
  if (row.deletionRequestedAt) return "DELETION_REQUESTED";
  if (row.archivedAt) return "ARCHIVED";
  return "ACTIVE";
}

export async function listPlatformBusinesses(
  input: ListPlatformBusinessesInput,
  now: Date = new Date()
): Promise<PlatformAdminBusinessesResponse> {
  const db = getPrismaAdmin();
  const skip = (input.page - 1) * input.limit;
  const orderBy: Prisma.BusinessOrderByWithRelationInput = {
    [input.sort]: input.order,
  };
  const where = buildBusinessListWhere(input, now);

  const [rows, total] = await Promise.all([
    db.business.findMany({
      where,
      orderBy: [orderBy, { id: "desc" }],
      skip,
      take: input.limit,
      select: {
        id: true,
        name: true,
        createdAt: true,
        archivedAt: true,
        deletionRequestedAt: true,
        profile: { select: { onboardingCompletedAt: true } },
        users: {
          orderBy: { id: "asc" },
          select: { id: true, email: true },
        },
        _count: {
          select: {
            users: true,
            billingDocuments: true,
            documentsV2: {
              where: { status: DOCUMENT_NEEDS_REVIEW_STATUS },
            },
            conversations: true,
            contentRuns: true,
          },
        },
      },
    }),
    db.business.count({ where }),
  ]);

  // Last activity = the most recent use of any session of any user of the
  // business. One grouped read for the whole page, never one per row.
  const userIds = rows.flatMap((row) => row.users.map((u) => u.id));
  const sessionGroups =
    userIds.length === 0
      ? []
      : await db.authSession.groupBy({
          by: ["userId"],
          where: { userId: { in: userIds } },
          _max: { lastUsedAt: true },
        });
  const lastUsedByUser = new Map<number, Date>();
  for (const group of sessionGroups) {
    if (group._max.lastUsedAt) lastUsedByUser.set(group.userId, group._max.lastUsedAt);
  }

  const items: PlatformAdminBusinessListItem[] = rows.map((row) => {
    let lastActiveAt: Date | null = null;
    for (const user of row.users) {
      const used = lastUsedByUser.get(user.id);
      if (used && (!lastActiveAt || used > lastActiveAt)) lastActiveAt = used;
    }
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      usersCount: row._count.users,
      ownerEmail: row.users[0]?.email ?? null,
      lastActiveAt: lastActiveAt?.toISOString() ?? null,
      onboardingCompletedAt: row.profile?.onboardingCompletedAt?.toISOString() ?? null,
      lifecycle: businessLifecycle(row),
      counts: {
        billingDocuments: row._count.billingDocuments,
        documentsNeedsReview: row._count.documentsV2,
        conversations: row._count.conversations,
        contentRuns: row._count.contentRuns,
      },
    };
  });

  return {
    items,
    query: { q: input.q, filter: input.filter },
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.ceil(total / input.limit) || 0,
    },
  };
}
