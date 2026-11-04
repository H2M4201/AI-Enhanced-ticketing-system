// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputsStep } from "@/components/run/InputsStep";
import { currentStep } from "@/components/run/Stepper";

afterEach(cleanup);

describe("currentStep", () => {
  it("maps each run status to its step", () => {
    expect(currentStep("inputs", false)).toBe("Inputs");
    expect(currentStep("checked", false)).toBe("Questions");
    expect(currentStep("questions", false)).toBe("Questions");
    expect(currentStep("review", false)).toBe("Review");
    expect(currentStep("creating", false)).toBe("Review");
    expect(currentStep("done", false)).toBe("Done");
  });

  it("shows the checks step while the user is looking at check results", () => {
    expect(currentStep("inputs", true)).toBe("Checks");
    expect(currentStep("checked", true)).toBe("Checks");
    expect(currentStep("questions", true)).toBe("Questions");
  });
});

describe("InputsStep without a provider", () => {
  it("says a breakdown can't start, disables Run checks and links to the project page", async () => {
    const onRunChecks = vi.fn();
    render(
      <InputsStep
        projectId="project-1"
        runId="run-1"
        epicText="Checkout redesign"
        existingEpicKey={null}
        documents={[]}
        provider={null}
        guidelines={[]}
        routing={[]}
        busy={null}
        onRunChecks={onRunChecks}
        onDocumentsChanged={async () => undefined}
      />,
    );
    expect(screen.getByText("No provider configured. A breakdown can't start.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run checks/i })).toBeDisabled();
    expect(screen.getByRole("link", { name: /set up a provider/i })).toHaveAttribute("href", "/projects/project-1");
    await userEvent.setup().click(screen.getByRole("button", { name: /run checks/i }));
    expect(onRunChecks).not.toHaveBeenCalled();
  });

  it("accepts the document types the server reads", () => {
    render(
      <InputsStep
        projectId="project-1"
        runId="run-1"
        epicText="Checkout redesign"
        existingEpicKey={null}
        documents={[]}
        provider={{ source: "env", name: "Local", model: "m", baseUrlHost: "localhost:1234" }}
        guidelines={[]}
        routing={[]}
        busy={null}
        onRunChecks={() => undefined}
        onDocumentsChanged={async () => undefined}
      />,
    );
    expect(screen.getByLabelText(/upload documents/i)).toHaveAttribute("accept", ".docx,.pptx,.pdf,.txt,.md");
  });
});
