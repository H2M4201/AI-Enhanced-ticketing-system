import JSZip from "jszip";
import type { Section } from "@/core/domain";

const SLIDE_FILE = /^ppt\/slides\/slide(\d+)\.xml$/;

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g, (_, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return XML_ENTITIES[entity];
  });
}

/** One string per paragraph (<a:p>), made of its <a:t> runs. */
function slideParagraphs(xml: string): string[] {
  return [...xml.matchAll(/<a:p[\s>][\s\S]*?<\/a:p>/g)].map((paragraph) =>
    [...paragraph[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((run) => decodeXml(run[1])).join(""),
  );
}

export async function parsePptxSections(filename: string, bytes: Uint8Array): Promise<Section[]> {
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files)
    .flatMap((name) => {
      const match = SLIDE_FILE.exec(name);
      return match ? [{ name, number: Number(match[1]) }] : [];
    })
    .sort((a, b) => a.number - b.number);

  const sections: Section[] = [];
  for (const slide of slides) {
    const file = zip.file(slide.name);
    if (!file) continue;
    const paragraphs = slideParagraphs(await file.async("string"))
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph !== "");
    if (paragraphs.length === 0) continue;
    sections.push({
      ref: `${filename} slide ${slide.number}`,
      heading: paragraphs[0],
      text: paragraphs.join("\n"),
    });
  }
  return sections;
}
