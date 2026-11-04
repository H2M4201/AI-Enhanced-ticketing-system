import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { draftItems, projects, runs, users } from "@/server/db/schema";
import { testDb } from "../helpers/db";

async function seedUserAndProject() {
  const db = await testDb();
  const [user] = await db
    .insert(users)
    .values({
      atlassianAccountId: "acc-1",
      displayName: "Linh",
      accessTokenEnc: "x",
      refreshTokenEnc: "y",
      accessTokenExpiresAt: new Date(),
    })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({
      ownerUserId: user.id,
      name: "Shop",
      cloudId: "c1",
      siteUrl: "https://x.atlassian.net",
      jiraProjectKey: "CHK",
    })
    .returning();
  return { db, user, project };
}

describe("database schema", () => {
  it("migrates and round-trips a project with files", async () => {
    const { db, user } = await seedUserAndProject();
    const [project] = await db.select().from(projects);
    expect(project.retentionDays).toBe(7);
    expect(project.ownerUserId).toBe(user.id);

    await expect(
      db.insert(projects).values({
        ownerUserId: user.id,
        name: "dup",
        cloudId: "c1",
        siteUrl: "s",
        jiraProjectKey: "CHK",
      }),
    ).rejects.toThrow();
  });

  it("cascades run deletion to draft items", async () => {
    const { db, user, project } = await seedUserAndProject();
    const [run] = await db
      .insert(runs)
      .values({ projectId: project.id, createdBy: user.id, epicText: "Epic" })
      .returning();
    await db.insert(draftItems).values({
      id: crypto.randomUUID(),
      runId: run.id,
      position: 0,
      kind: "epic",
      title: "Checkout",
      description: "",
      acceptanceCriteria: [],
      sourceRefs: [],
      origin: "document",
      shapedBy: {},
    });

    await db.delete(runs).where(eq(runs.id, run.id));

    expect(await db.select().from(draftItems)).toHaveLength(0);
  });

  it("stores the project's assignable users on a run", async () => {
    const { db, user, project } = await seedUserAndProject();
    const assignableUsers = [
      { accountId: "acc-2", displayName: "Minh", email: null },
    ];
    const [run] = await db
      .insert(runs)
      .values({
        projectId: project.id,
        createdBy: user.id,
        epicText: "Epic",
        assignableUsers,
      })
      .returning();
    expect(run.assignableUsers).toEqual(assignableUsers);
    expect(run.status).toBe("inputs");
  });
});
