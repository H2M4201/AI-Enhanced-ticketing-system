import { describe, expect, it } from "vitest";
import { markerFooter, readMarker } from "@/core/ticketing/adapter";
import { adfToText, textToAdf } from "@/integrations/jira/adf";

describe("ADF helpers", () => {
  it("round-trips headings, bullets and checklist", () => {
    const t = "## Clarifications\n- Q1: guests? → No\n\nPara\n- [ ] AC one";
    expect(adfToText(textToAdf(t))).toBe(
      "## Clarifications\n- Q1: guests? → No\n\nPara\n- ☐ AC one",
    );
  });

  it("maps ### headings and * bullets", () => {
    const doc = textToAdf("### Sub\n* a\n* b");
    expect(doc.content[0]).toMatchObject({ type: "heading", attrs: { level: 3 } });
    expect(adfToText(doc)).toBe("### Sub\n- a\n- b");
  });

  it("produces a valid ADF document root", () => {
    expect(textToAdf("hello")).toMatchObject({ type: "doc", version: 1 });
  });

  it("marker footer round-trips", () => {
    expect(readMarker("body\n\n" + markerFooter("abc"))).toBe("abc");
  });

  it("splits CRLF line endings without leaving \\r in text nodes", () => {
    const doc = textToAdf("## Heading\r\nPara one\r\n- item");
    expect(JSON.stringify(doc)).not.toContain("\\r");
    expect(adfToText(doc)).toBe("## Heading\nPara one\n- item");
  });

  it("skips a heading line with no text instead of emitting an empty text node", () => {
    const doc = textToAdf("## \nBody");
    expect(doc.content).toEqual([{ type: "paragraph", content: [{ type: "text", text: "Body" }] }]);
    expect(JSON.stringify(doc)).not.toContain('"text":""');
  });
});
