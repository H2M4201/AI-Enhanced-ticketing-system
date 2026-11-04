import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { DocumentParseError, parseDocument } from "@/core/ingest/parse";
import { splitMarkdown, splitPlainText } from "@/core/ingest/sections";

const enc = (s: string) => new TextEncoder().encode(s);
const read = (rel: string) => new Uint8Array(readFileSync(join(process.cwd(), rel)));

async function blankPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  return pdf.save();
}

describe("parseDocument", () => {
  it("splits markdown into numbered sections", async () => {
    const d = await parseDocument("r.md", enc("# Intro\nhi\n## Scope\nx\n# Payments\ny"));
    expect(d.kind).toBe("md");
    expect(d.sections.map((s) => s.ref)).toEqual(["r.md §1", "r.md §1.1", "r.md §2"]);
  });

  it("parses the sample docx with heading refs", async () => {
    const d = await parseDocument("requirements.docx", read("samples/checkout-revamp/requirements.docx"));
    expect(d.kind).toBe("docx");
    expect(d.sections.some((s) => s.ref === "requirements.docx §3.2" && /logged-in/i.test(s.text))).toBe(true);
    const goals = d.sections.find((s) => s.ref === "requirements.docx §1");
    expect(goals?.text).toMatch(/fast/i);
    expect(d.sections.some((s) => s.ref === "requirements.docx §2.1")).toBe(true);
  });

  it("parses the sample pptx one section per slide", async () => {
    const d = await parseDocument("design.pptx", read("samples/checkout-revamp/design.pptx"));
    expect(d.kind).toBe("pptx");
    expect(d.sections.map((s) => s.ref)).toEqual([1, 2, 3, 4, 5].map((n) => `design.pptx slide ${n}`));
    expect(d.sections[0].heading).toBe("Architecture");
    expect(d.sections[0].text.length).toBeGreaterThan(0);
  });

  it.each([
    ["bad.docx", "docx"],
    ["bad.pptx", "pptx"],
    ["bad.pdf", "pdf"],
  ])("rejects random bytes named %s as an unreadable %s file", async (filename) => {
    const junk = new Uint8Array(Array.from({ length: 512 }, (_, i) => (i * 97 + 13) % 256));
    const error = await parseDocument(filename, junk).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DocumentParseError);
    expect((error as Error).message).toMatch(new RegExp(`${filename.replace(".", "\\.")}.*could not read file`));
    expect((error as Error).cause).toBeDefined();
  });

  it("parses the sample pdf per page", async () => {
    const d = await parseDocument("api-spec.pdf", read("samples/checkout-revamp/api-spec.pdf"));
    expect(d.kind).toBe("pdf");
    expect(d.sections).toHaveLength(3);
    expect(d.sections.map((s) => s.ref)).toEqual(["api-spec.pdf p.1", "api-spec.pdf p.2", "api-spec.pdf p.3"]);
    expect(d.sections.every((s) => s.heading === null)).toBe(true);
  });

  it("parses txt by extension, case-insensitively", async () => {
    const d = await parseDocument("NOTES.TXT", enc("1 Scope\nA shop.\n\nMore detail."));
    expect(d.kind).toBe("txt");
    expect(d.sections[0]).toMatchObject({ ref: "NOTES.TXT §1", heading: "1 Scope" });
  });

  it("rejects an empty txt naming the file", async () => {
    await expect(parseDocument("empty.txt", new Uint8Array())).rejects.toThrow(/empty\.txt.*file is empty/);
  });

  it("rejects a textless pdf as possibly scanned", async () => {
    await expect(parseDocument("blank.pdf", await blankPdf())).rejects.toThrow(/no readable text/);
  });

  it("rejects unsupported types", async () => {
    await expect(parseDocument("x.xlsx", enc("a"))).rejects.toThrow(DocumentParseError);
  });
});

describe("splitMarkdown", () => {
  it("puts text before the first heading in §0 only when non-empty", () => {
    expect(splitMarkdown("a.md", "intro\n# One\nx").map((s) => s.ref)).toEqual(["a.md §0", "a.md §1"]);
    expect(splitMarkdown("a.md", "# One\nx").map((s) => s.ref)).toEqual(["a.md §1"]);
  });

  it("numbers siblings and nested headings from the nesting", () => {
    const refs = splitMarkdown("a.md", "# A\n## A1\n### A1a\n## A2\n# B\n## B1").map((s) => s.ref);
    expect(refs).toEqual(["a.md §1", "a.md §1.1", "a.md §1.1.1", "a.md §1.2", "a.md §2", "a.md §2.1"]);
  });
});

describe("splitPlainText", () => {
  it("starts sections at numbered or ALL CAPS heading lines", () => {
    const sections = splitPlainText(
      "t.txt",
      "1 Goals\nFast checkout.\n\n2.1 Saving cards\nGuests can save.\n\nPAYMENTS\nCards only.",
    );
    expect(sections.map((s) => [s.ref, s.heading])).toEqual([
      ["t.txt §1", "1 Goals"],
      ["t.txt §2", "2.1 Saving cards"],
      ["t.txt §3", "PAYMENTS"],
    ]);
    expect(sections[1].text).toBe("Guests can save.");
  });

  it("groups blank-line blocks up to about 1500 characters", () => {
    const para = "x".repeat(600);
    const sections = splitPlainText("t.txt", [para, para, para, para].join("\n\n"));
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((s) => s.text.length <= 1500)).toBe(true);
    expect(sections.map((s) => s.ref)).toEqual(sections.map((_, i) => `t.txt §${i + 1}`));
  });
});
