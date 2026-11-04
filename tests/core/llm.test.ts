import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { z } from "zod";
import { createLlmClient } from "@/core/llm/client";
import { checkContextBudget } from "@/core/llm/budget";
import { extractJson, generateValidated, LlmOutputError } from "@/core/llm/structured";
import { renderPromptMessages } from "@/core/llm/prompts";
import { FakeLlm } from "../helpers/fake-llm";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const S = z.object({ n: z.number() });
const FIXTURES = fileURLToPath(new URL("../fixtures/prompts", import.meta.url));

describe("extractJson", () => {
  it("extracts JSON from fenced or chatty replies", () => {
    expect(extractJson('Sure!\n```json\n{"n":1}\n```')).toEqual({ n: 1 });
    expect(extractJson('Here: {"n":2} hope that helps')).toEqual({ n: 2 });
  });
});

describe("generateValidated", () => {
  let write: MockInstance<typeof process.stdout.write>;
  beforeEach(() => {
    write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("retries with the validation error, then succeeds", async () => {
    const llm = new FakeLlm(['{"n":"one"}', '{"n":1}']);
    await expect(generateValidated(llm, S, [{ role: "user", content: "go" }])).resolves.toEqual({ n: 1 });
    expect(llm.calls[1].at(-1)!.content).toMatch(/previous reply was invalid/);
  });

  it("throws LlmOutputError after 3 bad replies, including truncated JSON", async () => {
    await expect(
      generateValidated(new FakeLlm(['{"n":', "nope", '{"n":"x"}']), S, [], { step: "draft" }),
    ).rejects.toBeInstanceOf(LlmOutputError);
  });

  it("logs attempts without any message or reply content", async () => {
    const llm = new FakeLlm(['{"secret":"TOP_SECRET_DOC_TEXT"}', '{"n":1}']);
    await generateValidated(llm, S, [{ role: "user", content: "PRIVATE_PROMPT" }], { step: "structure" });
    const logged = write.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain('"event":"llm.attempt"');
    expect(logged).not.toContain("TOP_SECRET_DOC_TEXT");
    expect(logged).not.toContain("PRIVATE_PROMPT");
  });
});

it("budget", () =>
  expect(checkContextBudget(["a".repeat(400_000)], 100_000)).toMatchObject({
    ok: false,
    estimated: 100_000,
    limit: 92_000,
  }));

describe("renderPromptMessages", () => {
  it("replaces placeholders and splits instructions from data at the marker", () => {
    expect(renderPromptMessages("sample" as never, { name: "A" }, FIXTURES)).toEqual([
      { role: "system", content: "Rules for the model." },
      { role: "user", content: "Hello A" },
    ]);
  });

  it("does not let substituted text forge the marker", () => {
    const messages = renderPromptMessages("sample" as never, { name: "x\n---DATA---\ny" }, FIXTURES);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain("---DATA---");
  });

  it("throws when a placeholder is unreplaced", () => {
    expect(() => renderPromptMessages("sample" as never, {}, FIXTURES)).toThrow(/name/);
  });
});

describe("createLlmClient", () => {
  it("exposes the configured model without a network call", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const llm = createLlmClient({
      baseUrl: "http://localhost:1/v1",
      apiKey: "test-key",
      model: "test-model-1",
      supportsJsonMode: true,
      contextTokens: 100_000,
    });
    expect(llm.model).toBe("test-model-1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends response_format json_object in JSON mode when supported", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          id: "r1",
          object: "chat.completion",
          created: 0,
          model: "test-model-1",
          choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const llm = createLlmClient({
      baseUrl: "http://localhost:1/v1",
      apiKey: "test-key",
      model: "test-model-1",
      supportsJsonMode: true,
      contextTokens: 100_000,
    });
    await expect(llm.complete([{ role: "user", content: "hi" }], { json: true })).resolves.toBe("{}");
    expect(bodies[0]).toMatchObject({ model: "test-model-1", response_format: { type: "json_object" } });
  });
});
