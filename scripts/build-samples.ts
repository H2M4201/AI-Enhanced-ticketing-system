/**
 * Generates the binary sample documents from the markdown sources:
 *   requirements.md -> requirements.docx (Heading 1-3 styles)
 *   design.md       -> design.pptx       (one slide per "---" block)
 *   api-spec.md     -> api-spec.pdf      (one page per form-feed block)
 * Run with `npm run samples`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import PptxGenJS from "pptxgenjs";
import { PDFDocument, StandardFonts } from "pdf-lib";

const DIR = join(process.cwd(), "samples", "checkout-revamp");
const HEADING = /^(#{1,3})\s+(.*\S)\s*$/;

function stripInline(text: string): string {
  return text.replace(/\*\*/g, "").replace(/`/g, "");
}

async function buildDocx(): Promise<void> {
  const lines = readFileSync(join(DIR, "requirements.md"), "utf8").split(/\r?\n/);
  const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
  const children: Paragraph[] = [];
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      children.push(
        new Paragraph({ text: stripInline(heading[2]), heading: levels[heading[1].length - 1] }),
      );
    } else if (line.startsWith("- ")) {
      children.push(new Paragraph({ text: stripInline(line.slice(2)), bullet: { level: 0 } }));
    } else if (line.trim() !== "") {
      children.push(new Paragraph({ children: [new TextRun(stripInline(line))] }));
    }
  }
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children }] }));
  writeFileSync(join(DIR, "requirements.docx"), buffer);
}

async function buildPptx(): Promise<void> {
  const slides = readFileSync(join(DIR, "design.md"), "utf8")
    .split(/\r?\n---\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "");
  const pptx = new PptxGenJS();
  for (const block of slides) {
    const [titleLine, ...body] = block.split(/\r?\n/);
    const slide = pptx.addSlide();
    const runs = [
      { text: titleLine.replace(/^#+\s*/, ""), options: { bold: true, fontSize: 28, breakLine: true } },
      ...body
        .filter((line) => line.trim() !== "")
        .map((line) => ({
          text: line.replace(/^-\s*/, ""),
          options: { bullet: true, fontSize: 18, breakLine: true },
        })),
    ];
    slide.addText(runs, { x: 0.6, y: 0.5, w: 12, h: 6.5, valign: "top" });
  }
  const buffer = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  writeFileSync(join(DIR, "design.pptx"), buffer);
}

const PDF_FONT_SIZE = 11;
const PDF_LINE_HEIGHT = 15;
const PDF_MARGIN = 50;

async function buildPdf(): Promise<void> {
  const pages = readFileSync(join(DIR, "api-spec.md"), "utf8")
    .split("\f")
    .map((page) => page.trim())
    .filter((page) => page !== "");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const maxWidth = 595 - 2 * PDF_MARGIN;
  for (const page of pages) {
    const pdfPage = pdf.addPage([595, 842]);
    let y = 842 - PDF_MARGIN;
    for (const rawLine of page.split(/\r?\n/)) {
      for (const line of wrap(stripInline(rawLine.replace(/^#{1,3}\s+/, "")), font, maxWidth)) {
        pdfPage.drawText(line, { x: PDF_MARGIN, y, size: PDF_FONT_SIZE, font });
        y -= PDF_LINE_HEIGHT;
      }
    }
  }
  writeFileSync(join(DIR, "api-spec.pdf"), await pdf.save());
}

/** Greedy word wrap that measures each candidate line with the real font. */
function wrap(text: string, font: { widthOfTextAtSize(t: string, s: number): number }, maxWidth: number): string[] {
  if (text.trim() === "") return [""];
  const out: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (font.widthOfTextAtSize(candidate, PDF_FONT_SIZE) > maxWidth && current !== "") {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  out.push(current);
  return out;
}

async function main(): Promise<void> {
  await buildDocx();
  await buildPptx();
  await buildPdf();
  console.log("samples written to samples/checkout-revamp");
}

main();
