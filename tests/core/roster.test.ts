import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@/core/domain";
import { normalizeName, parseRoster, resolveRoster } from "@/core/pipeline/roster";
import type { AssignableUser } from "@/core/ticketing/adapter";
import { FakeLlm } from "../helpers/fake-llm";

const users: AssignableUser[] = JSON.parse(
  readFileSync(new URL("../../samples/fake-jira-project.json", import.meta.url), "utf8"),
).users;

const routingFile = {
  filename: "routing.md",
  content: readFileSync(new URL("../../samples/checkout-revamp/routing.md", import.meta.url), "utf8"),
};

function rosterWith(people: string[]): Roster {
  return { teams: [], people: people.map((name) => ({ name, role: null })), rules: [] };
}

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeName", () => {
  it("strips diacritics, maps đ to d, lowercases and collapses whitespace", () => {
    expect(normalizeName("  Nguyễn   Văn  An ")).toBe("nguyen van an");
    expect(normalizeName("Đặng Thị")).toBe("dang thi");
  });
});

describe("resolveRoster", () => {
  it("matches ignoring diacritics", () => {
    const r = resolveRoster(rosterWith(["Nguyen Van An"]), users);
    expect(r.accounts[normalizeName("Nguyen Van An")].displayName).toBe("Nguyễn Văn An");
  });

  it("treats a name matching two users as ambiguous", () => {
    const r = resolveRoster(rosterWith(["Minh"]), users);
    expect(r.accounts).toEqual({});
    expect(r.unresolved).toEqual([
      expect.objectContaining({
        name: "Minh",
        reason: "ambiguous",
        suggestions: expect.arrayContaining([
          expect.objectContaining({ displayName: "Minh Nguyen" }),
          expect.objectContaining({ displayName: "Minh Pham" }),
        ]),
      }),
    ]);
  });

  it("first-name-only unique match is NOT accepted (must be exact full name)", () => {
    const r = resolveRoster(rosterWith(["Linh"]), users);
    expect(r.accounts).toEqual({});
    expect(r.unresolved).toEqual([
      { name: "Linh", reason: "not_found", suggestions: [expect.objectContaining({ displayName: "Linh Tran" })] },
    ]);
  });

  it("null team default when the default person is unresolved", () => {
    const roster: Roster = {
      teams: [{ name: "Ops", defaultPerson: "Nobody Here", members: [] }],
      people: [],
      rules: [],
    };
    const r = resolveRoster(roster, users);
    expect(r.teamDefaults).toEqual({ Ops: null });
    expect(r.unresolved).toEqual([expect.objectContaining({ name: "Nobody Here", reason: "not_found" })]);
  });

  it("reports a person-targeted rule whose name is unknown, and a rule targeting an unknown team", () => {
    const roster: Roster = {
      teams: [],
      people: [],
      rules: [
        { id: "R1", condition: "x", target: { type: "team", name: "Legal" }, line: 1, quote: "q" },
        { id: "R2", condition: "y", target: { type: "person", name: "Ghost Person" }, line: 2, quote: "q" },
      ],
    };
    const r = resolveRoster(roster, users);
    expect(r.unresolved).toEqual([
      { name: "Legal", reason: "not_found", suggestions: [] },
      { name: "Ghost Person", reason: "not_found", suggestions: [] },
    ]);
  });
});

describe("parseRoster", () => {
  it("resolves all four team defaults from the sample routing file", async () => {
    const reply = JSON.stringify({
      teams: [
        { name: "Frontend", defaultPerson: "Linh Tran", members: ["Linh Tran", "Minh Nguyen"] },
        { name: "Backend", defaultPerson: "Bao Le", members: ["Bao Le", "Minh Pham", "Nguyễn Văn An"] },
        { name: "QA", defaultPerson: "Mai Pham", members: ["Mai Pham"] },
        { name: "Payments", defaultPerson: "Quang Vo", members: ["Quang Vo"] },
      ],
      people: [
        { name: "Linh Tran", role: "Frontend lead" },
        { name: "Minh Nguyen", role: "Frontend developer" },
        { name: "Bao Le", role: "Backend lead" },
        { name: "Minh Pham", role: "Backend developer" },
        { name: "Nguyễn Văn An", role: "Backend developer" },
        { name: "Mai Pham", role: "QA lead" },
        { name: "Quang Vo", role: "Payments lead" },
      ],
      rules: [
        { condition: "payments or cards", target: { type: "team", name: "Payments" }, line: 22, quote: "Anything touching payments or cards → team Payments" },
        { condition: "QA sub-tasks", target: { type: "team", name: "QA" }, line: 23, quote: "QA sub-tasks → team QA" },
        { condition: "database migrations", target: { type: "person", name: "Bao Le" }, line: 24, quote: "Database migrations → Bao Le" },
        { condition: "cart or checkout UI", target: { type: "team", name: "Frontend" }, line: 25, quote: "Anything touching the cart, checkout page or order summary UI → team Frontend" },
        { condition: "API endpoints", target: { type: "team", name: "Backend" }, line: 26, quote: "API endpoints and order service changes → team Backend" },
        { condition: "confirmation emails", target: { type: "team", name: "Backend" }, line: 27, quote: "Order confirmation email templates → team Backend" },
        { condition: "saved card removal", target: { type: "team", name: "Payments" }, line: 28, quote: "Saved card removal in the account page → team Payments" },
      ],
    });
    const llm = new FakeLlm([reply]);

    const roster = await parseRoster(llm, routingFile);
    expect(llm.calls[0].map((m) => m.content).join("\n")).toContain("22| - Anything touching payments or cards");

    const r = resolveRoster(roster, users);
    expect(Object.fromEntries(Object.entries(r.teamDefaults).map(([team, u]) => [team, u?.displayName]))).toEqual({
      Frontend: "Linh Tran",
      Backend: "Bao Le",
      QA: "Mai Pham",
      Payments: "Quang Vo",
    });
    expect(r.unresolved).toEqual([]);
  });

  it("drops a rule whose quote is not in the file and fixes a wrong line number", async () => {
    const content = "# Routing\n\n- Payments rule → team Payments\n- QA rule → team QA";
    const reply = JSON.stringify({
      teams: [],
      people: [],
      rules: [
        { condition: "payments", target: { type: "team", name: "Payments" }, line: 5, quote: "Payments rule → team Payments" },
        { condition: "invented", target: { type: "team", name: "QA" }, line: 4, quote: "Invented rule → team QA" },
      ],
    });

    const roster = await parseRoster(new FakeLlm([reply]), { filename: "routing.md", content });

    expect(roster.rules).toEqual([
      { id: "R1", condition: "payments", target: { type: "team", name: "Payments" }, line: 3, quote: "Payments rule → team Payments" },
    ]);
  });
});

describe("resolveRoster matching rules", () => {
  it("two users with the same exact display name are ambiguous", () => {
    const twins: AssignableUser[] = [
      { accountId: "acc-1", displayName: "Lan Anh", email: "lan.a@example.com" },
      { accountId: "acc-2", displayName: "Lan Anh", email: "lan.b@example.com" },
    ];
    const r = resolveRoster(rosterWith(["Lan Anh"]), twins);
    expect(r.accounts).toEqual({});
    expect(r.unresolved).toEqual([
      {
        name: "Lan Anh",
        reason: "ambiguous",
        suggestions: [expect.objectContaining({ accountId: "acc-1" }), expect.objectContaining({ accountId: "acc-2" })],
      },
    ]);
  });

  it("resolves an email local part such as minh.nguyen when it is unique", () => {
    const r = resolveRoster(rosterWith(["minh.nguyen"]), users);
    expect(r.accounts[normalizeName("minh.nguyen")]).toEqual(
      expect.objectContaining({ displayName: "Minh Nguyen" }),
    );
    expect(r.unresolved).toEqual([]);
  });

  it("returns at most 3 shared-token suggestions", () => {
    const crowd: AssignableUser[] = ["An Van Hoang", "Tran Van Bo", "Le Van Cuong", "Pham Van Dong", "Vo Van Em"].map(
      (displayName, i) => ({ accountId: `acc-${i}`, displayName, email: null }),
    );
    const r = resolveRoster(rosterWith(["Nguyen Van Tu"]), crowd);
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0].reason).toBe("not_found");
    expect(r.unresolved[0].suggestions).toHaveLength(3);
  });

  it("reports a name appearing in several places once in unresolved", () => {
    const roster: Roster = {
      teams: [{ name: "Ops", defaultPerson: "Ghost Person", members: ["Ghost Person"] }],
      people: [{ name: "Ghost Person", role: null }],
      rules: [{ id: "R1", condition: "x", target: { type: "person", name: "Ghost Person" }, line: 1, quote: "q" }],
    };
    const r = resolveRoster(roster, users);
    expect(r.unresolved).toEqual([{ name: "Ghost Person", reason: "not_found", suggestions: [] }]);
  });
});
