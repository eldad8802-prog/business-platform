import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ValidationError } from "@/lib/errors";
import { PLATFORM_SYSTEM_BUSINESS_NAME } from "./constants";
import type {
  PlatformAdminBusinessesResponse,
  PlatformAdminBusinessListItem,
} from "./types";

const DOCUMENT_NEEDS_REVIEW_STATUS = "needs_review";

const SORT_FIELDS = ["createdAt", "name", "id"] as const;
type SortField = (typeof SORT_FIELDS)[number];

export type ListPlatformBusinessesInput = {
  page: number;
  limit: number;
  sort: SortField;
  order: "asc" | "desc";
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

export function parseListPlatformBusinessesQuery(
  searchParams: URLSearchParams
): ListPlatformBusinessesInput {
  const pageParam = searchParams.get("page") ?? "1";
  const limitParam = searchParams.get("limit") ?? "20";
  const page = Number(pageParam);
  const limit = Number(limitParam);

  if (Number.isNaN(page) || page < 1) {
    throw new ValidationError("page must be a positive number");
  }

  if (Number.isNaN(limit) || limit < 1 || limit > 100) {
    throw new ValidationError("limit must be a number between 1 and 100");
  }

  return {
    page,
    limit,
    sort: parseSortField(searchParams.get("sort")),
    order: parseOrder(searchParams.get("order")),
  };
}

const businessListWhere = {
  name: { not: PLATFORM_SYSTEM_BUSINESS_NAME },
} satisfies Prisma.BusinessWhereInput;

export async function listPlatformBusinesses(
  input: ListPlatformBusinessesInput
): Promise<PlatformAdminBusinessesResponse> {
  const skip = (input.page - 1) * input.limit;
  const orderBy: Prisma.BusinessOrderByWithRelationInput = {
    [input.sort]: input.order,
  };

  const [rows, total] = await Promise.all([
    prisma.business.findMany({
      where: businessListWhere,
      orderBy,
      skip,
      take: input.limit,
      select: {
        id: true,
        name: true,
        createdAt: true,
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
    prisma.business.count({ where: businessListWhere }),
  ]);

  const items: PlatformAdminBusinessListItem[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    usersCount: row._count.users,
    counts: {
      billingDocuments: row._count.billingDocuments,
      documentsNeedsReview: row._count.documentsV2,
      conversations: row._count.conversations,
      contentRuns: row._count.contentRuns,
    },
  }));

  return {
    items,
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.ceil(total / input.limit) || 0,
    },
  };
}
