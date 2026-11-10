/**
 * Lab infrastructure only (copied from account-erasure.battery.mts, unchanged): the base lab records some older
 * migrations in the ledger without running them, so an erasure function the purge — or a module of the shared
 * post-commit stage (ACCOUNT_STORAGE_ERASURES) — calls may be missing. Each missing one is created from the REAL
 * definition in the latest migration that creates it, EXECUTE to the runtime alone. No erasure logic is written here,
 * nothing is stubbed: a required function no migration defines is an error.
 *
 * Used by the purchase-order sheet R2 battery and the production-mode run, which delete a real account.
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

type LabMigration = { dir: string; sql: string };

function labMigrations(): LabMigration[] {
  const dir = join(process.cwd(), "prisma/migrations");
  return readdirSync(dir).sort()
    .filter((d) => existsSync(join(dir, d, "migration.sql")))
    .map((d) => ({ dir: d, sql: readFileSync(join(dir, d, "migration.sql"), "utf8") }));
}

/** The real CREATE OR REPLACE FUNCTION public.<fn>(<args>) … $fn$; of the latest migration that creates it; throws if none. */
function definitionFromMigrations(fn: string, migrations: LabMigration[]): string {
  const re = new RegExp(String.raw`CREATE OR REPLACE FUNCTION public\.${fn}\([^)]*\)[\s\S]*?\$fn\$;`);
  for (const m of [...migrations].reverse()) {
    const d = m.sql.match(re)?.[0];
    if (d) return d;
  }
  throw new Error(`${fn}() not found in any migration`);
}

/** Every public.<fn>( called by the purge adapter and by the erasure code of each registered storage-erasure module. */
function requiredEraseFunctions(): string[] {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  const registry = read("lib/services/account/account-storage-erasure.ts");
  const moduleFiles = [...registry.matchAll(/from "@\/(lib\/services\/[^"]+\/erasure\/[^"]+)"/g)].map((m) => `${m[1]}.ts`);
  const sources = [read("lib/services/account/account-deletion.prisma-store.ts"), ...moduleFiles.map(read)];
  return [...new Set(sources.flatMap((s) => [...s.matchAll(/\bpublic\.([a-z_]+)\(/g)].map((m) => m[1])))].sort();
}

/** public.<fn>(<types>) of a definition's header — parameter names dropped, so to_regprocedure() can match it exactly. */
function signatureOf(fn: string, definition: string): string {
  const args = definition.match(new RegExp(String.raw`^CREATE OR REPLACE FUNCTION public\.${fn}\(([^)]*)\)`))?.[1] ?? "";
  const types = args.split(",").map((a) => a.trim()).filter(Boolean).map((a) => {
    const t = a.split(/\s+/);
    return t.length > 1 ? t.slice(1).join(" ") : t[0];
  });
  return `public.${fn}(${types.join(", ")})`;
}

/** Installs, from their migrations, the erase functions the lab is missing. Returns the signatures it installed. */
export async function mirrorMissingEraseFunctions(ownerUrl: string, superUrl: string): Promise<string[]> {
  const migrations = labMigrations();
  const own = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
  const mirrored: string[] = [];
  try {
    for (const fn of requiredEraseFunctions()) {
      const body = definitionFromMigrations(fn, migrations);
      const sig = signatureOf(fn, body);
      const ok = ((await own.$queryRawUnsafe(`SELECT to_regprocedure($1) IS NOT NULL AS ok`, sig)) as { ok: boolean }[])[0].ok;
      if (ok) continue;
      const sup = new PrismaClient({ datasources: { db: { url: superUrl } } });
      try {
        await sup.$executeRawUnsafe(body);
        await sup.$executeRawUnsafe(`ALTER FUNCTION ${sig} OWNER TO lab_owner`);
        await sup.$executeRawUnsafe(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC`);
        await sup.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION ${sig} TO app_runtime`);
      } finally {
        await sup.$disconnect();
      }
      mirrored.push(sig);
    }
  } finally {
    await own.$disconnect();
  }
  return mirrored;
}

/**
 * Moves the Business id sequence to a random high value (lab superuser), so this run's businesses — and therefore
 * their object prefixes biz/<id>/business-docs/ in the shared test bucket — can never meet another run's.
 */
export async function uniqueBusinessIds(superUrl: string): Promise<number> {
  const start = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  const sup = new PrismaClient({ datasources: { db: { url: superUrl } } });
  try {
    await sup.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"Business"', 'id'), $1::bigint)`, start);
  } finally {
    await sup.$disconnect();
  }
  return start;
}
