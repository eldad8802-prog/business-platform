/**
 * The SANCTIONED exchange-rate writer client — the only connection that may append to "FxRate".
 *
 * NARROW APPEND-ONLY WRITER. It authenticates as a LOGIN member of the NOLOGIN role `fx_rate_writer`
 * (migration 20261025090000_currency_settings_fx_rates), which holds exactly INSERT on "FxRate" and USAGE on
 * its sequence — no SELECT, no UPDATE / DELETE, nothing on any tenant table. Every write is a plain INSERT
 * without RETURNING (the role cannot read what it wrote); "FxRate" is append-only for every role by trigger.
 *
 * Boundaries (enforced by ast-security-guard AST-1 / AST-4 and prisma-centralization-guard):
 *   - may be imported ONLY from lib/fx/fx-rate-writer.ts;
 *   - nothing tenant-scoped reaches it.
 *
 * Fail-closed contract: FX_RATE_WRITER_DATABASE_URL missing → the writer is "not configured" and nothing is
 * written. There is deliberately NO fallback to DATABASE_URL / DIRECT_URL / ADMIN_DATABASE_URL, and a value
 * equal to one of those is refused too (that would be the runtime or the owner, not the writer).
 */
import { PrismaClient } from "@prisma/client";

const globalForFxWriter = globalThis as unknown as { prismaFxWriter?: PrismaClient };

export type FxWriterConfig = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: "NOT_CONFIGURED" | "SHARES_ANOTHER_CONNECTION" };

export function fxWriterConfig(env: Readonly<Record<string, string | undefined>> = process.env): FxWriterConfig {
  const url = env.FX_RATE_WRITER_DATABASE_URL?.trim();
  if (!url) return { ok: false, reason: "NOT_CONFIGURED" };
  for (const other of [env.DATABASE_URL, env.DIRECT_URL, env.ADMIN_DATABASE_URL, env.AUTH_DATABASE_URL, env.CONTROL_PLANE_DATABASE_URL]) {
    if (other && other.trim() === url) return { ok: false, reason: "SHARES_ANOTHER_CONNECTION" };
  }
  return { ok: true, url };
}

/** The writer client, or null when not configured (the caller reports "not configured"; nothing is written). */
export function getPrismaFxWriter(): PrismaClient | null {
  if (globalForFxWriter.prismaFxWriter) return globalForFxWriter.prismaFxWriter;
  const config = fxWriterConfig();
  if (!config.ok) return null;
  const client = new PrismaClient({ datasourceUrl: config.url, log: ["warn", "error"] });
  globalForFxWriter.prismaFxWriter = client;
  return client;
}
