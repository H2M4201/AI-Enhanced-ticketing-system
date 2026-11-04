import { extractText } from "unpdf";
import type { Section } from "@/core/domain";

/** One section per page, referenced as `p.N`. */
export async function parsePdfSections(filename: string, bytes: Uint8Array): Promise<Section[]> {
  // pdf.js may detach the buffer it is given, so pass a copy.
  const { text } = await extractText(bytes.slice(), { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return pages.map((page, index) => ({
    ref: `${filename} p.${index + 1}`,
    heading: null,
    text: page.trim(),
  }));
}
