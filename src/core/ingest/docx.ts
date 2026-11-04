import mammoth from "mammoth";
import { HTMLElement, parse } from "node-html-parser";
import type { Section } from "@/core/domain";
import { type Block, sectionsFromBlocks } from "@/core/ingest/sections";

const HEADING_LEVELS: Record<string, number> = { h1: 1, h2: 2, h3: 3 };

/** Walks the HTML in document order, keeping h1-h3 as headings and p/li as text. */
function collect(node: HTMLElement, blocks: Block[]): void {
  for (const child of node.childNodes) {
    if (!(child instanceof HTMLElement)) continue;
    const tag = (child.tagName ?? "").toLowerCase();
    const text = child.text.trim();
    if (Object.hasOwn(HEADING_LEVELS, tag)) {
      if (text !== "") blocks.push({ kind: "heading", level: HEADING_LEVELS[tag], title: text });
    } else if (tag === "p" || tag === "li") {
      if (text !== "") blocks.push({ kind: "text", text });
    } else {
      collect(child, blocks);
    }
  }
}

export async function parseDocxSections(filename: string, bytes: Uint8Array): Promise<Section[]> {
  const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  const blocks: Block[] = [];
  collect(parse(html), blocks);
  return sectionsFromBlocks(filename, blocks);
}
