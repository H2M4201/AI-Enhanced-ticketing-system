// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionsStep } from "@/components/run/QuestionsStep";
import type { QuestionView } from "@/components/run/types";
import { ApiError, apiFetch } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

afterEach(cleanup);
beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ ok: true });
});

function question(id: string, rank: number, resolution: QuestionView["resolution"] = null): QuestionView {
  return {
    id,
    category: "ambiguity",
    text: `Question ${id}?`,
    sourceRefs: ["doc.md#1"],
    rank,
    resolution,
  };
}

/** Holds the questions in state the way the run page does, so resolving one updates the step. */
function Harness({ initial, status = "questions" }: { initial: QuestionView[]; status?: "checked" | "questions" }) {
  const [questions, setQuestions] = useState(initial);
  return (
    <QuestionsStep
      runId="run-1"
      status={status}
      questions={questions}
      busy={null}
      onResolved={(id, resolution) =>
        setQuestions((current) => current.map((q) => (q.id === id ? { ...q, resolution } : q)))
      }
      onGenerateQuestions={() => undefined}
      onGenerateDraft={() => undefined}
    />
  );
}

function draftButton() {
  return screen.getByRole("button", { name: /generate draft/i });
}

describe("QuestionsStep", () => {
  it("Generate draft is disabled until every question is resolved", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[question("Q1", 1), question("Q2", 2)]} />);
    expect(draftButton()).toBeDisabled();

    await user.click(screen.getAllByRole("button", { name: /out of scope/i })[0]);
    await user.click(screen.getAllByRole("button", { name: /use your judgment/i })[1]);

    expect(draftButton()).toBeEnabled();
  });

  it("shows the empty state and an enabled Generate draft when there are no questions", () => {
    render(<Harness initial={[]} />);
    expect(screen.getByText("No open questions found")).toBeInTheDocument();
    expect(draftButton()).toBeEnabled();
  });

  it("offers Generate questions before any questions exist", () => {
    render(<Harness initial={[]} status="checked" />);
    expect(screen.getByRole("button", { name: /generate questions/i })).toBeEnabled();
    expect(draftButton()).toBeDisabled();
  });

  it("saves a choice on click", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[question("Q1", 1)]} />);
    await user.click(screen.getByRole("button", { name: /out of scope/i }));
    expect(apiFetchMock).toHaveBeenCalledWith("/api/runs/run-1/questions/Q1", {
      method: "PUT",
      body: JSON.stringify({ kind: "out_of_scope" }),
    });
  });

  it("debounces the Answer box so typing does not save on every keystroke", async () => {
    render(<Harness initial={[question("Q1", 1)]} />);
    const answer = screen.getByRole("textbox", { name: /answer/i });
    fireEvent.change(answer, { target: { value: "a" } });
    fireEvent.change(answer, { target: { value: "ab" } });
    fireEvent.change(answer, { target: { value: "abc" } });
    expect(apiFetchMock).not.toHaveBeenCalled();

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(apiFetchMock).toHaveBeenCalledWith("/api/runs/run-1/questions/Q1", {
      method: "PUT",
      body: JSON.stringify({ kind: "answered", answer: "abc" }),
    });
  });

  it("saves the Answer immediately on blur", () => {
    render(<Harness initial={[question("Q1", 1)]} />);
    const answer = screen.getByRole("textbox", { name: /answer/i });
    fireEvent.change(answer, { target: { value: "Use PostgreSQL" } });
    fireEvent.blur(answer);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith("/api/runs/run-1/questions/Q1", {
      method: "PUT",
      body: JSON.stringify({ kind: "answered", answer: "Use PostgreSQL" }),
    });
  });

  it("does not save an empty Answer", () => {
    render(<Harness initial={[question("Q1", 1)]} />);
    const answer = screen.getByRole("textbox", { name: /answer/i });
    fireEvent.change(answer, { target: { value: "   " } });
    fireEvent.blur(answer);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("shows a server message as plain text when a save is refused", async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError(409, "run_state", "Draft changed in another tab — reload"));
    const user = userEvent.setup();
    render(<Harness initial={[question("Q1", 1)]} />);
    await user.click(screen.getByRole("button", { name: /use your judgment/i }));
    expect(await screen.findByText("Draft changed in another tab — reload")).toBeInTheDocument();
  });

  it("shows the category, text and source refs of each question", () => {
    render(<Harness initial={[question("Q1", 1)]} />);
    const card = screen.getByText("Question Q1?").closest("li") as HTMLElement;
    expect(within(card).getByText("ambiguity")).toBeInTheDocument();
    expect(within(card).getByText(/doc\.md#1/)).toBeInTheDocument();
  });
});
