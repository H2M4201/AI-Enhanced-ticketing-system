// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunsSection, type RunListEntry } from "@/components/RunsSection";

afterEach(cleanup);

const run = (over: Partial<RunListEntry>): RunListEntry => ({
  id: "run-1",
  status: "review",
  createdAt: "2026-11-04T10:00:00.000Z",
  createdByName: "Linh Tran",
  epicFirstLine: "Replace the checkout",
  ...over,
});

describe("RunsSection", () => {
  it("links each run to its page with a status chip", () => {
    render(<RunsSection runs={[run({}), run({ id: "run-2", status: "done", epicFirstLine: "" })]} />);
    expect(screen.getByRole("link", { name: "Replace the checkout" })).toHaveAttribute("href", "/runs/run-1");
    expect(screen.getByText("In review")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /removed by retention/i })).toHaveAttribute("href", "/runs/run-2");
  });

  it("says when there are no runs", () => {
    render(<RunsSection runs={[]} />);
    expect(screen.getByText("No breakdowns yet.")).toBeInTheDocument();
  });
});
