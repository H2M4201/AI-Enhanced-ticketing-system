// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewScreen } from "@/components/review/ReviewScreen";
import { Tree } from "@/components/review/Tree";
import type { DraftItem } from "@/core/domain";
import { ApiError, apiFetch } from "@/lib/api";
import type { ReviewView } from "@/server/runs/service";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);
const SITE = "https://acme.atlassian.net";
const DRAFT = "/api/runs/run-1/draft";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  apiFetchMock.mockReset();
});

function item(id: string, kind: DraftItem["kind"], over: Partial<DraftItem> = {}): DraftItem {
  return {
    id,
    parentId: null,
    position: 0,
    kind,
    title: id,
    description: "",
    acceptanceCriteria: [],
    estimate: null,
    sourceRefs: [],
    origin: "from_docs",
    assumption: false,
    shapedBy: [],
    suggestionStatus: null,
    routing: null,
    fieldValues: {},
    jiraKey: null,
    createError: null,
    ...over,
  };
}

const ASSIGNED = {
  status: "assigned" as const,
  accountId: "acc-1",
  displayName: "An",
  teamName: "Payments",
  reason: "Anything touching payments",
  ruleId: "r1",
  ruleQuote: "anything touching payments",
  ruleLine: 4,
  overridden: false,
};

/** Epic e1 > story s1 (> task t1), and an AI-suggested story s2 that is still pending. */
function sampleItems(): DraftItem[] {
  return [
    item("e1", "epic", { title: "Checkout Revamp" }),
    item("s1", "story", { parentId: "e1", title: "Guest checkout", routing: ASSIGNED }),
    item("t1", "task", { parentId: "s1", title: "Guest session API", routing: ASSIGNED }),
    item("s2", "story", {
      parentId: "e1",
      position: 1,
      title: "Save card for later",
      origin: "ai_suggestion",
      suggestionStatus: "pending",
      routing: ASSIGNED,
    }),
  ];
}

function review(items: DraftItem[], over: Partial<ReviewView> = {}): ReviewView {
  return {
    status: "review",
    draftVersion: 3,
    items,
    blockers: [],
    requiredFields: { epic: [], story: [], task: [] },
    provider: { source: "env", name: "Server default", model: "test-model", baseUrlHost: "localhost:11434" },
    existingEpic: null,
    clarificationsPreview: "",
    assignableUsers: [
      { accountId: "acc-1", displayName: "An", email: null },
      { accountId: "acc-2", displayName: "Bao", email: null },
    ],
    ...over,
  };
}

/** Serves the review on GET and answers every PATCH with the review it is given. */
function serve(initial: ReviewView, patched: ReviewView = initial) {
  apiFetchMock.mockImplementation(async (_path, init) => (init?.method === "PATCH" ? patched : initial));
}

function patchBodies(): { op: Record<string, unknown>; expectedVersion: number }[] {
  return apiFetchMock.mock.calls
    .filter(([, init]) => init?.method === "PATCH")
    .map(([, init]) => JSON.parse(String(init?.body)));
}

function renderScreen(onRunChanged = () => undefined) {
  return render(<ReviewScreen runId="run-1" siteUrl={SITE} onRunChanged={onRunChanged} />);
}

function treeHandlers() {
  return { onSelect: vi.fn(), onSuggestion: vi.fn(), onAdd: vi.fn(), onMove: vi.fn(), onDelete: vi.fn() };
}

describe("Tree", () => {
  it("renders title before tags", () => {
    const items = sampleItems();
    render(<Tree items={items} status="review" selectedId={null} aiOnly={false} siteUrl={SITE} {...treeHandlers()} />);
    const story = items.find((i) => i.id === "s1")!;
    const row = screen.getByTestId(`row-${story.id}`);
    expect(row.textContent!.indexOf(story.title)).toBeLessThan(row.textContent!.indexOf("STORY"));
  });

  it("sends a suggestion op when an AI suggestion is accepted", async () => {
    const handlers = treeHandlers();
    const user = userEvent.setup();
    render(<Tree items={sampleItems()} status="review" selectedId={null} aiOnly={false} siteUrl={SITE} {...handlers} />);
    await user.click(within(screen.getByTestId("row-s2")).getByRole("button", { name: /accept/i }));
    expect(handlers.onSuggestion).toHaveBeenCalledWith("s2", "accepted");
  });

  it("shows a created item's key as a link to the Jira browse page", () => {
    const items = sampleItems().map((i) => (i.id === "t1" ? { ...i, jiraKey: "PROJ-7" } : i));
    render(<Tree items={items} status="creating" selectedId={null} aiOnly={false} siteUrl={SITE} {...treeHandlers()} />);
    expect(screen.getByRole("link", { name: "PROJ-7" })).toHaveAttribute("href", `${SITE}/browse/PROJ-7`);
  });
});

describe("ReviewScreen", () => {
  it("Create is disabled while blockers exist and shows the count", async () => {
    serve(
      review(sampleItems(), {
        blockers: [{ itemId: "s2", type: "pending_suggestion", message: '"Save card for later" is an AI suggestion' }],
      }),
    );
    renderScreen();
    expect(await screen.findByRole("button", { name: /create 4 tickets in jira/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /1 blocker/i })).toBeInTheDocument();
  });

  it("Accept on an AI suggestion sends a suggestion op at the latest version", async () => {
    serve(review(sampleItems()), review(sampleItems().map((i) => (i.id === "s2" ? { ...i, suggestionStatus: "accepted" } : i)), { draftVersion: 4 }));
    const user = userEvent.setup();
    renderScreen();
    await user.click(await within(await screen.findByTestId("row-s2")).findByRole("button", { name: /accept/i }));
    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).toEqual({ op: { type: "suggestion", id: "s2", status: "accepted" }, expectedVersion: 3 });
  });

  it("Create stays disabled while a save is in flight", async () => {
    apiFetchMock.mockImplementation(async (_path, init) =>
      init?.method === "PATCH" ? new Promise(() => undefined) : review(sampleItems()),
    );
    const user = userEvent.setup();
    renderScreen();
    await user.click(await within(await screen.findByTestId("row-s2")).findByRole("button", { name: /accept/i }));
    expect(screen.getByRole("button", { name: /create 4 tickets in jira/i })).toBeDisabled();
  });

  it("Regenerate is hidden once any item has a Jira key", async () => {
    const items = sampleItems().map((i) => (i.id === "s1" ? { ...i, jiraKey: "PROJ-2" } : i));
    serve(review(items, { status: "creating" }));
    renderScreen();
    await screen.findByRole("link", { name: "PROJ-2" });
    expect(screen.queryByRole("button", { name: /regenerate/i })).not.toBeInTheDocument();
  });

  it("Regenerate asks for confirmation with the exact text, then posts a regenerate", async () => {
    serve(review(sampleItems()));
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole("button", { name: /regenerate/i }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        "Regenerate replaces the whole draft. Your edits, Accept/Reject decisions and routing changes will be lost. Clarification answers are kept.",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^regenerate$/i }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(DRAFT, { method: "POST" }));
  });

  it("failed items show the Jira error and the button becomes Retry failed", async () => {
    const items = sampleItems().map((i) =>
      i.id === "s1"
        ? { ...i, jiraKey: "PROJ-2", createError: "Created as PROJ-2 but linking to the epic failed" }
        : i.id === "t1"
          ? { ...i, createError: "User cannot be assigned" }
          : i,
    );
    serve(review(items, { status: "creating" }));
    renderScreen();
    expect(await screen.findByText("User cannot be assigned")).toBeInTheDocument();
    expect(screen.getByText("Created as PROJ-2 but linking to the epic failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry failed \(2\)/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^create \d+ tickets/i })).not.toBeInTheDocument();
  });

  it("keeps Retry disabled for 10 seconds after a failed create, then enables it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const items = sampleItems().map((i) => (i.id === "t1" ? { ...i, createError: "User cannot be assigned" } : i));
    serve(review(items, { status: "creating" }));
    renderScreen();
    const retry = await screen.findByRole("button", { name: /retry failed \(1\)/i });
    expect(retry).toBeEnabled();

    apiFetchMock.mockImplementation(async (path) =>
      path === "/api/runs/run-1/create" ? { created: 0, failed: 1, skipped: 0 } : review(items, { status: "creating" }),
    );
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole("button", { name: /retry failed \(1\)/i })).toBeDisabled());
    expect(screen.getByText(/retry available in 10s/i)).toBeInTheDocument();

    // Let the countdown's effect start its timer before the clock moves.
    await act(async () => undefined);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole("button", { name: /retry failed \(1\)/i })).toBeEnabled();
  });

  it("a version conflict shows the server message as text and Reload re-fetches, without retrying the edit", async () => {
    const user = userEvent.setup();
    serve(review(sampleItems()));
    apiFetchMock.mockImplementation(async (_path, init) => {
      if (init?.method === "PATCH") throw new ApiError(409, "run_state", "Draft changed in another tab — reload");
      return review(sampleItems());
    });
    renderScreen();
    await user.click(await within(await screen.findByTestId("row-s2")).findByRole("button", { name: /accept/i }));
    expect(await screen.findByText("Draft changed in another tab — reload")).toBeInTheDocument();
    expect(patchBodies()).toHaveLength(1);

    const gets = apiFetchMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /^reload$/i }));
    await waitFor(() => expect(apiFetchMock.mock.calls.length).toBeGreaterThan(gets));
    expect(apiFetchMock.mock.calls.slice(gets).every(([path, init]) => path === DRAFT && !init?.method)).toBe(true);
    expect(patchBodies()).toHaveLength(1);
  });

  it("saves a title on blur, and not before", async () => {
    const user = userEvent.setup();
    serve(review(sampleItems()));
    renderScreen();
    await user.click(await screen.findByTestId("row-t1"));
    const detailTitle = await screen.findByRole("textbox", { name: /^title$/i });
    await user.clear(detailTitle);
    await user.type(detailTitle, "Session API");
    expect(patchBodies()).toHaveLength(0);
    fireEvent.blur(detailTitle);
    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0].op).toMatchObject({ type: "update", id: "t1", patch: { title: "Session API" } });
  });

  it("a blank title is put back to the saved title on blur, and nothing blank is sent", async () => {
    const user = userEvent.setup();
    serve(review(sampleItems()));
    renderScreen();
    await user.click(await screen.findByTestId("row-t1"));
    const detailTitle = await screen.findByRole("textbox", { name: /^title$/i });
    await user.clear(detailTitle);
    fireEvent.blur(detailTitle);
    expect(detailTitle).toHaveValue("Guest session API");
    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0].op).toMatchObject({ type: "update", id: "t1", patch: { title: "Guest session API" } });
  });

  it("Delete asks for confirmation and then sends a delete op", async () => {
    const user = userEvent.setup();
    serve(review(sampleItems()));
    renderScreen();
    await user.click(await screen.findByTestId("row-t1"));
    await user.click(within(screen.getByTestId("row-t1")).getByRole("button", { name: /^delete$/i }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0].op).toEqual({ type: "delete", id: "t1" });
  });

  it("the move picker lists only stories for a task, not the task's current story", async () => {
    const user = userEvent.setup();
    serve(review(sampleItems()));
    renderScreen();
    await user.click(await within(await screen.findByTestId("row-t1")).findByRole("button", { name: /move to/i }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Save card for later" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Guest checkout" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Checkout Revamp" })).not.toBeInTheDocument();
  });

  it("after a successful create the run shows Done with a link to the epic", async () => {
    const items = sampleItems().map((i) => ({ ...i, jiraKey: i.id === "e1" ? "PROJ-1" : `PROJ-${i.id}` }));
    serve(review(items, { status: "done" }));
    renderScreen();
    expect(await screen.findByRole("link", { name: /view epic in jira/i })).toHaveAttribute(
      "href",
      `${SITE}/browse/PROJ-1`,
    );
  });
});
