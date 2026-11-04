import { describe, expect, it } from "vitest";
import { escapeAttribute, escapeTagBody } from "@/core/llm/escape";

describe("escapeAttribute", () => {
  it("escapes quotes and angle brackets", () => {
    expect(escapeAttribute('a"b<c>d')).toBe("a&quot;b&lt;c&gt;d");
  });
});

describe("escapeTagBody", () => {
  it("escapes a closing tag for the named tag, case-insensitively", () => {
    expect(escapeTagBody("x </Guideline> y </guideline", "guideline")).toBe("x &lt;/guideline> y &lt;/guideline");
  });

  it("leaves closing tags for other names alone", () => {
    expect(escapeTagBody("</routing> and </guideline", "guideline")).toBe("</routing> and &lt;/guideline");
  });
});
