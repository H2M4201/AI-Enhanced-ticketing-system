// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionsStep } from "@/components/run/QuestionsStep";
import type { QuestionView } from "@/components/run/types";
import type { Resolution } from "@/core/domain";
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
function Harness({
  initial,
  status = "questions",
  onBackToInputs = () => undefined,
  onRerunChecks = () => undefined,
}: {
  initial: QuestionView[];
  status?: "checked" | "questions";
  onBackToInputs?: () => void;
  onRerunChecks?: () => void;
}) {
  const [questions, setQuestions] = useState(initial);
  return (
    <QuestionsStep
      runId="run-1"
      status={status}
      questions={questions}
      busy={null}
      onResolved={(id: string, resolution: Resolution | null) =>
        setQuestions((current) => current.map((q) => (q.id === id ? { ...q, resolution } : q)))
      }
      onGenerateQuestions={() => undefined}
      onGenerateDraft={() => undefined}
      onBackToInputs={onBackToInputs}
      onRerunChecks={onRerunChecks}
    />
  );
}

function draftButton() {
  return screen.getByRole("button", { name: /generate draft/i });
}

const PUT_Q1 = "/api/runs/run-1/questions/Q1";

describe("QuestionsStep", () => {
  it("Generate draft is disabled until every question is resolved", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[question("Q1", 1), question("Q2", 2)]} />);
    expect(draftButton()).toBeDisabled();

    await user.click(screen.getAllByRole("button", { name: /out of scope/i })[0]);
    await user.click(screen.getAllByRole("button", { name: /use your judgment/i })[1]);

    // Saves finish asynchronously, so the button enables once both choices have been written.
    await waitFor(() => expect(draftButton()).toBeEnabled());
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
    expect(apiFetchMock).toHaveBeenCalledWith(PUT_Q1, {
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
    expect(apiFetchMock).toHaveBeenCalledWith(PUT_Q1, {
      method: "PUT",
      body: JSON.stringify({ kind: "answered", answer: "abc" }),
    });
  });

  it("saves the Answer immediately on blur", async () => {
    render(<Harness initial={[question("Q1", 1)]} />);
    const answer = screen.getByRole("textbox", { name: /answer/i });
    fireEvent.change(answer, { target: { value: "Use PostgreSQL" } });
    fireEvent.blur(answer);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    expect(apiFetchMock).toHaveBeenCalledWith(PUT_Q1, {
      method: "PUT",
      body: JSON.stringify({ kind: "answered", answer: "Use PostgreSQL" }),
    });
  });

  it("flushes a pending Answer when the card unmounts", async () => {
    const { unmount } = render(<Harness initial={[question("Q1", 1)]} />);
    fireEvent.change(screen.getByRole("textbox", { name: /answer/i }), { target: { value: "Keep me" } });
    unmount();
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(PUT_Q1, {
        method: "PUT",
        body: JSON.stringify({ kind: "answered", answer: "Keep me" }),
      }),
    );
  });

  it("disables Generate draft while an Answer is pending or saving", async () => {
    apiFetchMock.mockReturnValue(new Promise(() => undefined));
    render(<Harness initial={[question("Q1", 1, { kind: "judgment" })]} />);
    expect(draftButton()).toBeEnabled();

    fireEvent.change(screen.getByRole("textbox", { name: /answer/i }), { target: { value: "Typing" } });
    expect(draftButton()).toBeDisabled();

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(draftButton()).toBeDisabled();
  });

  it("ends with the choice when a choice is clicked while the Answer has focus", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[question("Q1", 1)]} />);
    await user.click(screen.getByRole("textbox", { name: /answer/i }));
    await user.keyboard("Use PostgreSQL");
    await user.click(screen.getByRole("button", { name: /out of scope/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    const last = apiFetchMock.mock.calls.at(-1);
    expect(last).toEqual([PUT_Q1, { method: "PUT", body: JSON.stringify({ kind: "out_of_scope" }) }]);
  });

  it("sends the choice only after the Answer save has finished, so the choice is written last", async () => {
    let finishAnswer: () => void = () => undefined;
    apiFetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (finishAnswer = () => resolve({ ok: true }))),
    );
    const user = userEvent.setup();
    render(<Harness initial={[question("Q1", 1)]} />);
    await user.click(screen.getByRole("textbox", { name: /answer/i }));
    await user.keyboard("Use PostgreSQL");
    await user.click(screen.getByRole("button", { name: /out of scope/i }));

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    finishAnswer();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    expect(apiFetchMock.mock.calls[1]).toEqual([PUT_Q1, { method: "PUT", body: JSON.stringify({ kind: "out_of_scope" }) }]);
  });

  it("never sends an empty answer; clearing the Answer makes the question unresolved", async () => {
    render(<Harness initial={[question("Q1", 1, { kind: "answered", answer: "Old" })]} />);
    expect(draftButton()).toBeEnabled();

    const answer = screen.getByRole("textbox", { name: /answer/i });
    fireEvent.change(answer, { target: { value: "" } });
    fireEvent.blur(answer);

    await waitFor(() => expect(draftButton()).toBeDisabled());
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

  it("offers Back to inputs and Re-run checks while the run is checked", async () => {
    const user = userEvent.setup();
    const onBackToInputs = vi.fn();
    const onRerunChecks = vi.fn();
    render(<Harness initial={[]} status="checked" onBackToInputs={onBackToInputs} onRerunChecks={onRerunChecks} />);
    await user.click(screen.getByRole("button", { name: /back to inputs/i }));
    await user.click(screen.getByRole("button", { name: /re-run checks/i }));
    expect(onBackToInputs).toHaveBeenCalledTimes(1);
    expect(onRerunChecks).toHaveBeenCalledTimes(1);
  });
});
