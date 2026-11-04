import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/backdate-run";

const RUN_ID = "3f2c1b4e-8a9d-4c6e-9f10-2b3c4d5e6f70";

describe("parseArgs", () => {
  it("accepts a run ID and a whole number of days", () => {
    expect(parseArgs([RUN_ID, "2"])).toEqual({ runId: RUN_ID, days: 2 });
  });

  it.each([
    ["no run ID", []],
    ["a run ID that is not a UUID", ["not-a-uuid", "2"]],
    ["no days", [RUN_ID]],
    ["zero days", [RUN_ID, "0"]],
    ["fractional days", [RUN_ID, "1.5"]],
    ["days that are not a number", [RUN_ID, "soon"]],
  ])("rejects %s", (_case, argv) => {
    expect(() => parseArgs(argv)).toThrow(/Usage|must be/);
  });
});
