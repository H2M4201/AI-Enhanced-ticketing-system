import { afterEach, describe, expect, it, vi } from "vitest";
import { safeLog } from "@/lib/log";

afterEach(() => {
  vi.restoreAllMocks();
});

function captureLine(fn: () => void): Record<string, unknown> {
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  fn();
  expect(spy).toHaveBeenCalledTimes(1);
  const line = String(spy.mock.calls[0][0]);
  expect(line.endsWith("\n")).toBe(true);
  return JSON.parse(line);
}

describe("safeLog", () => {
  it("writes one JSON line with the event and allowlisted fields", () => {
    const entry = captureLine(() =>
      safeLog("run.started", { runId: "r1", count: 5, status: "ok" }),
    );
    expect(entry).toMatchObject({ event: "run.started", runId: "r1", count: 5, status: "ok" });
    expect(typeof entry.time).toBe("string");
  });

  it("drops keys that are not on the allowlist, such as document content", () => {
    const entry = captureLine(() =>
      safeLog("draft.generated", {
        runId: "r1",
        content: "SECRET REQUIREMENT TEXT",
        prompt: "SECRET PROMPT",
      } as Record<string, string>),
    );
    expect(entry.runId).toBe("r1");
    expect(entry).not.toHaveProperty("content");
    expect(entry).not.toHaveProperty("prompt");
    expect(JSON.stringify(entry)).not.toContain("SECRET");
  });

  it("truncates string values to 120 characters", () => {
    const entry = captureLine(() => safeLog("x", { model: "m".repeat(500) }));
    expect(String(entry.model)).toHaveLength(120);
  });
});
