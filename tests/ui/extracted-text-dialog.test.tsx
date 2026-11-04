// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtractedTextDialog } from "@/components/run/ExtractedTextDialog";
import { apiFetch } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);
const HOSTILE = "<img src=x onerror=alert(1)>";

afterEach(cleanup);
beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({
    id: "doc-1",
    filename: "brief.md",
    kind: "md",
    sections: [{ ref: "S1", heading: "Scope", text: HOSTILE }],
  });
});

describe("ExtractedTextDialog", () => {
  it("shows extracted text as literal text, never as markup", async () => {
    const { container } = render(
      <ExtractedTextDialog runId="run-1" documentId="doc-1" filename="brief.md" onClose={() => undefined} />,
    );
    expect(await screen.findByText(HOSTILE)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("moves focus into the dialog when it opens", () => {
    render(<ExtractedTextDialog runId="run-1" documentId="doc-1" filename="brief.md" onClose={() => undefined} />);
    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ExtractedTextDialog runId="run-1" documentId="doc-1" filename="brief.md" onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
