import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { safeLog } from "@/lib/log";
import type { Db } from "@/server/db/client";
import { projects, runDocuments, runs } from "@/server/db/schema";

const TICK_MS = 60 * 60 * 1000;

type GlobalWithLoop = typeof globalThis & { __ebcRetentionLoop?: NodeJS.Timeout };

/** Runs past their project's retention: completed, or without activity, for longer than retentionDays. */
function expiredRunIds(db: Db, now: Date) {
  const cutoff = sql`${now.toISOString()}::timestamptz - make_interval(days => ${projects.retentionDays})`;
  return db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(or(lt(runs.completedAt, cutoff), lt(runs.lastActivityAt, cutoff)));
}

/**
 * Removes the extracted text of expired runs: document sections are nulled and marked deleted,
 * and the epic text of expired done runs is cleared. Already purged documents are skipped.
 * Project files (guidelines and routing) are configuration and are never touched.
 */
export async function purgeExpired(db: Db, now: Date): Promise<{ documentsPurged: number }> {
  const documentsPurged = await db.transaction(async (tx) => {
    const purged = await tx
      .update(runDocuments)
      .set({ sections: null, deletedAt: now })
      .where(and(isNull(runDocuments.deletedAt), inArray(runDocuments.runId, expiredRunIds(tx, now))))
      .returning({ id: runDocuments.id });
    await tx
      .update(runs)
      .set({ epicText: "" })
      .where(and(eq(runs.status, "done"), inArray(runs.id, expiredRunIds(tx, now))));
    return purged.length;
  });
  safeLog("retention.purge", { count: documentsPurged });
  return { documentsPurged };
}

function errorCodeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.name : "UnknownError";
}

/**
 * Purges once now and then every hour. The guard lives on globalThis so dev hot reload does not start a second loop.
 * A failed tick is logged by error code only and never rejects.
 */
export function startRetentionLoop(getDb: () => Promise<Db>): void {
  const g = globalThis as GlobalWithLoop;
  if (g.__ebcRetentionLoop) return;

  const tick = async () => {
    try {
      await purgeExpired(await getDb(), new Date());
    } catch (error) {
      safeLog("retention.failed", { errorCode: errorCodeOf(error) });
    }
  };

  void tick();
  g.__ebcRetentionLoop = setInterval(() => void tick(), TICK_MS).unref();
}
