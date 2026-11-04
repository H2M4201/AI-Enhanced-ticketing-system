/**
 * Backdates one run's completed_at and last_activity_at, so the next retention purge treats
 * the run as expired. Used by the retention check in docs/smoke-test.md.
 *
 *   npm run backdate -- <runId> <days>
 *
 * Stop the app first. PGlite locks its folder, so this script cannot open it while the app runs.
 * Uses DATABASE_URL when set, otherwise the embedded PGlite database, as the app does.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { createDb } from "@/server/db/client";
import { runs } from "@/server/db/schema";

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A usage problem whose message is fixed text, so it is safe to print. */
class BackdateUsageError extends Error {
  override name = "BackdateUsageError";
}

export function parseArgs(argv: string[]): { runId: string; days: number } {
  const [runId, daysText] = argv;
  if (runId === undefined || !UUID.test(runId)) {
    throw new BackdateUsageError("Usage: npm run backdate -- <runId> <days>. The run ID is a UUID from the run's page URL.");
  }
  const days = Number(daysText);
  if (!Number.isInteger(days) || days < 1) {
    throw new BackdateUsageError("<days> must be a whole number of at least 1");
  }
  return { runId, days };
}

async function main(argv: string[]): Promise<void> {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const { runId, days } = parseArgs(argv);

  const db = await createDb(process.env.DATABASE_URL);
  const past = new Date(Date.now() - days * DAY_MS);
  const updated = await db
    .update(runs)
    .set({ completedAt: past, lastActivityAt: past })
    .where(eq(runs.id, runId))
    .returning({ id: runs.id });
  if (updated.length === 0) throw new BackdateUsageError("No run has that ID");

  console.log(`Backdated run ${runId} by ${days} day(s). Start the app again so the purge runs.`);
  // The database client keeps connections open, so exit explicitly.
  process.exit(0);
}

// Runs only when executed directly, so importing this file has no side effects.
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const detail = error instanceof BackdateUsageError ? error.message : error instanceof Error ? error.name : "UnknownError";
    console.error(`Backdate failed: ${detail}`);
    process.exit(1);
  });
}
