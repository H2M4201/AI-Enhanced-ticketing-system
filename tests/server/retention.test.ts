import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectFiles, projects, runDocuments, runs, users } from "@/server/db/schema";
import { createProject, uploadProjectFile } from "@/server/projects";
import { purgeExpired, startRetentionLoop } from "@/server/retention";
import { testDb } from "../helpers/db";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-05T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);
const SECTIONS = [{ ref: "S1", heading: "Scope", text: "Confidential requirement text" }];

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seed(retentionDays = 7) {
  const db = await testDb();
  const [user] = await db
    .insert(users)
    .values({
      atlassianAccountId: "acc-owner",
      displayName: "Owner",
      accessTokenEnc: "x",
      refreshTokenEnc: "y",
      accessTokenExpiresAt: NOW,
    })
    .returning();
  const project = await createProject(db, user.id, {
    name: "Checkout",
    cloudId: "cloud-1",
    siteUrl: "https://example.atlassian.net",
    jiraProjectKey: "CHK",
  });
  await db.update(projects).set({ retentionDays }).where(eq(projects.id, project.id));
  await uploadProjectFile(db, project.id, user.id, "guideline", "guidelines.md", "# Guidelines");
  return { db, user, projectId: project.id };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function addRun(
  db: Seeded["db"],
  s: Seeded,
  values: {
    status?: "inputs" | "done";
    completedAt?: Date | null;
    lastActivityAt: Date;
    createdAt?: Date;
    epicText?: string;
  },
) {
  const [run] = await db
    .insert(runs)
    .values({
      projectId: s.projectId,
      createdBy: s.user.id,
      epicText: values.epicText ?? "Epic text",
      status: values.status ?? "done",
      completedAt: values.completedAt ?? null,
      lastActivityAt: values.lastActivityAt,
      createdAt: values.createdAt,
    })
    .returning();
  await db.insert(runDocuments).values({ runId: run.id, filename: "brief.md", kind: "md", sections: SECTIONS, charCount: 30 });
  return run;
}

async function docOf(db: Seeded["db"], runId: string) {
  const [doc] = await db.select().from(runDocuments).where(eq(runDocuments.runId, runId));
  return doc;
}

describe("purgeExpired", () => {
  it("purges documents of runs done longer than retention ago", async () => {
    const s = await seed(7);
    const old = await addRun(s.db, s, { completedAt: daysAgo(8), lastActivityAt: daysAgo(8), epicText: "secret epic" });

    const result = await purgeExpired(s.db, NOW);

    expect(result).toEqual({ documentsPurged: 1 });
    const doc = await docOf(s.db, old.id);
    expect(doc.sections).toBeNull();
    expect(doc.deletedAt?.toISOString()).toBe(NOW.toISOString());
    const [run] = await s.db.select().from(runs).where(eq(runs.id, old.id));
    expect(run.epicText).toBe("");
  });

  it("purges abandoned runs by lastActivityAt", async () => {
    const s = await seed(7);
    const abandoned = await addRun(s.db, s, { status: "inputs", lastActivityAt: daysAgo(10) });

    expect(await purgeExpired(s.db, NOW)).toEqual({ documentsPurged: 1 });

    expect((await docOf(s.db, abandoned.id)).sections).toBeNull();
    const [run] = await s.db.select().from(runs).where(eq(runs.id, abandoned.id));
    expect(run.epicText).toBe("Epic text");
  });

  it("keeps recent runs and never touches project files", async () => {
    const s = await seed(7);
    const recent = await addRun(s.db, s, { completedAt: daysAgo(2), lastActivityAt: daysAgo(2) });
    const before = await s.db.select().from(projectFiles);

    expect(await purgeExpired(s.db, NOW)).toEqual({ documentsPurged: 0 });

    const doc = await docOf(s.db, recent.id);
    expect(doc.sections).toEqual(SECTIONS);
    expect(doc.deletedAt).toBeNull();
    expect(await s.db.select().from(projectFiles)).toEqual(before);
  });

  it("keeps a run with an old createdAt but recent activity", async () => {
    const s = await seed(7);
    const active = await addRun(s.db, s, {
      status: "inputs",
      createdAt: daysAgo(30),
      lastActivityAt: daysAgo(1),
    });

    expect(await purgeExpired(s.db, NOW)).toEqual({ documentsPurged: 0 });

    const doc = await docOf(s.db, active.id);
    expect(doc.sections).toEqual(SECTIONS);
    expect(doc.deletedAt).toBeNull();
  });

  it("respects per-project retentionDays", async () => {
    const short = await seed(3);
    const long = await seed(30);
    const shortRun = await addRun(short.db, short, { completedAt: daysAgo(4), lastActivityAt: daysAgo(4) });
    const longRun = await addRun(long.db, long, { completedAt: daysAgo(4), lastActivityAt: daysAgo(4) });

    expect(await purgeExpired(short.db, NOW)).toEqual({ documentsPurged: 1 });
    expect((await docOf(short.db, shortRun.id)).sections).toBeNull();

    expect(await purgeExpired(long.db, NOW)).toEqual({ documentsPurged: 0 });
    expect((await docOf(long.db, longRun.id)).sections).toEqual(SECTIONS);
  });

  it("is idempotent: already purged documents are not counted again", async () => {
    const s = await seed(7);
    await addRun(s.db, s, { completedAt: daysAgo(8), lastActivityAt: daysAgo(8) });

    expect(await purgeExpired(s.db, NOW)).toEqual({ documentsPurged: 1 });
    expect(await purgeExpired(s.db, NOW)).toEqual({ documentsPurged: 0 });
  });

  it("logs the purged count only", async () => {
    const s = await seed(7);
    await addRun(s.db, s, { completedAt: daysAgo(8), lastActivityAt: daysAgo(8), epicText: "secret epic" });

    await purgeExpired(s.db, NOW);

    const lines = vi.mocked(process.stdout.write).mock.calls.map(([line]) => String(line));
    const entry = lines.map((line) => JSON.parse(line)).find((e) => e.event === "retention.purge");
    expect(entry).toMatchObject({ event: "retention.purge", count: 1 });
    expect(lines.join("")).not.toContain("secret epic");
    expect(lines.join("")).not.toContain("Confidential");
  });
});

describe("startRetentionLoop", () => {
  afterEach(() => {
    const g = globalThis as typeof globalThis & { __ebcRetentionLoop?: NodeJS.Timeout };
    if (g.__ebcRetentionLoop) clearInterval(g.__ebcRetentionLoop);
    delete g.__ebcRetentionLoop;
  });

  it("starts once and logs a failed tick as an error code without throwing", async () => {
    const getDb = vi.fn(async () => {
      throw new Error("database is unavailable: secret detail");
    });

    startRetentionLoop(getDb);
    startRetentionLoop(getDb);

    await vi.waitFor(() => {
      const lines = vi.mocked(process.stdout.write).mock.calls.map(([line]) => String(line));
      expect(lines.map((line) => JSON.parse(line)).some((e) => e.event === "retention.failed")).toBe(true);
    });
    expect(getDb).toHaveBeenCalledTimes(1);
    const lines = vi.mocked(process.stdout.write).mock.calls.map(([line]) => String(line)).join("");
    expect(lines).not.toContain("secret detail");
  });
});
