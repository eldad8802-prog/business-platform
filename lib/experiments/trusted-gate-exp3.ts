// EXPERIMENT (Stage D, security/gate-trusted) — throwaway Draft PR, NEVER MERGE. Deleted after the report.
import { prisma } from "@/lib/prisma";
export function exp3Db(o?: { tx?: unknown }) {
  return o?.tx ?? prisma;
}
