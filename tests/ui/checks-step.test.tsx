// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChecksStep } from "@/components/run/ChecksStep";
import type { ChecksResult } from "@/server/runs/service";

afterEach(cleanup);

const OK_CHECKS: ChecksResult = {
  ok: true,
  budget: { estimated: 1200, limit: 100000, ok: true },
  structure: { errors: [], warnings: [], notes: [] },
  roster: {
    teams: [{ name: "Payments", defaultPerson: "Minh Nguyen", members: ["Minh Nguyen"] }],
    people: [{ name: "Minh Nguyen", role: "Engineer" }],
    rules: [
      {
        id: "R1",
        condition: "payments",
        target: { type: "team", name: "Payments" },
        line: 4,
        quote: "Payments go to Payments",
      },
    ],
    teamDefaults: {
      Payments: { accountId: "acc-1", displayName: "Minh Nguyen", email: null },
    },
    unresolved: [],
  },
  existingEpicError: null,
};

function checks(overrides: Partial<ChecksResult> = {}): ChecksResult {
  return { ...OK_CHECKS, ...overrides };
}

function renderStep(result: ChecksResult) {
  const handlers = { onRerun: vi.fn(), onContinue: vi.fn(), onBack: vi.fn() };
  render(
    <ChecksStep
      projectId="project-1"
      checks={result}
      busy={null}
      onRerun={handlers.onRerun}
      onContinue={handlers.onContinue}
      onBack={handlers.onBack}
    />,
  );
  return handlers;
}

describe("ChecksStep", () => {
  it("shows ambiguous routing names with suggestions and blocks Continue", () => {
    renderStep(
      checks({
        roster: {
          ...OK_CHECKS.roster,
          unresolved: [
            {
              name: "Minh",
              reason: "ambiguous",
              suggestions: [
                { accountId: "a1", displayName: "Minh Nguyen", email: "minh.n@example.com" },
                { accountId: "a2", displayName: "Minh Tran", email: null },
              ],
            },
          ],
        },
      }),
    );
    expect(screen.getByText("Minh")).toBeInTheDocument();
    expect(screen.getByText(/more than one user/i)).toBeInTheDocument();
    expect(screen.getByText("Minh Tran")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /re-run checks/i })).toBeEnabled();
  });

  it("shows an over-budget error with a hint to remove documents", () => {
    renderStep(checks({ ok: false, budget: { estimated: 90000, limit: 50000, ok: false } }));
    expect(screen.getByRole("alert")).toHaveTextContent(/too much text for this model/i);
    expect(screen.getByRole("alert")).toHaveClass("text-red-800");
    expect(screen.getByText(/remove a document/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
  });

  it("shows structure errors and blocks Continue", () => {
    renderStep(checks({ ok: false, structure: { errors: ["Epic type is missing"], warnings: [], notes: [] } }));
    expect(screen.getByText("Epic type is missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
  });

  it("shows the existing epic problem and blocks Continue", () => {
    renderStep(checks({ ok: false, existingEpicError: "ABC-9 is not an epic" }));
    expect(screen.getByText("ABC-9 is not an epic")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
  });

  it("flags a team whose default person is not an assignable user", () => {
    renderStep(
      checks({
        roster: {
          ...OK_CHECKS.roster,
          teams: [{ name: "Ops", defaultPerson: "Lan", members: [] }],
          teamDefaults: { Ops: null },
        },
      }),
    );
    expect(screen.getByText(/not an assignable user/i)).toBeInTheDocument();
    expect(screen.getByText(/Lan/)).toBeInTheDocument();
  });

  it("lets a clean run continue and links to the project page to fix files", async () => {
    const user = userEvent.setup();
    const handlers = renderStep(checks());
    expect(screen.getByRole("link", { name: /project page/i })).toHaveAttribute("href", "/projects/project-1");
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(handlers.onContinue).toHaveBeenCalledTimes(1);
  });
});
