import { createDb, type Db } from "@/server/db/client";

/** Fresh in-memory PGlite database with all migrations applied. */
export function testDb(): Promise<Db> {
  return createDb("memory://");
}
