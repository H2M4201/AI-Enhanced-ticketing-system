import { mkdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

/** Drizzle Postgres database; works with both the node-postgres and PGlite drivers. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const MIGRATIONS_FOLDER = path.resolve(process.cwd(), "drizzle");
const PGLITE_DIR = path.resolve(process.cwd(), ".data", "pglite");

/**
 * Creates a database and applies the migrations in `./drizzle`.
 * - `postgres://` or `postgresql://` URL: node-postgres.
 * - `memory://`: in-memory PGlite (tests).
 * - anything else, or undefined: PGlite persisted at `./.data/pglite`.
 */
export async function createDb(url?: string): Promise<Db> {
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const db = drizzleNodePg(new Pool({ connectionString: url }), { schema });
    await migrateNodePg(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db;
  }

  const client = url === "memory://" ? new PGlite() : openPersistentPglite();
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

function openPersistentPglite(): PGlite {
  mkdirSync(PGLITE_DIR, { recursive: true });
  return new PGlite(PGLITE_DIR);
}

let dbPromise: Promise<Db> | undefined;

/** Process-wide database singleton, configured from `DATABASE_URL`. */
export function getDb(): Promise<Db> {
  dbPromise ??= createDb(getEnv().DATABASE_URL).catch((error: unknown) => {
    dbPromise = undefined;
    throw error;
  });
  return dbPromise;
}
