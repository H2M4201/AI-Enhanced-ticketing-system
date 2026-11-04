import type { ParsedDocument, Section } from "@/core/domain";
import { parseDocxSections } from "@/core/ingest/docx";
import { parsePdfSections } from "@/core/ingest/pdf";
import { parsePptxSections } from "@/core/ingest/pptx";
import { splitMarkdown, splitPlainText } from "@/core/ingest/sections";

export class DocumentParseError extends Error {
  readonly filename: string;
  readonly reason: string;

  constructor(filename: string, reason: string, options?: { cause?: unknown }) {
    super(`${filename}: ${reason}`, options);
    this.name = "DocumentParseError";
    this.filename = filename;
    this.reason = reason;
  }
}

type Kind = ParsedDocument["kind"];

const KINDS = new Map<string, Kind>([
  ["docx", "docx"],
  ["pptx", "pptx"],
  ["pdf", "pdf"],
  ["md", "md"],
  ["markdown", "md"],
  ["txt", "txt"],
]);

async function parseSections(kind: Kind, filename: string, bytes: Uint8Array): Promise<Section[]> {
  switch (kind) {
    case "docx":
      return parseDocxSections(filename, bytes);
    case "pptx":
      return parsePptxSections(filename, bytes);
    case "pdf":
      return parsePdfSections(filename, bytes);
    case "md":
      return splitMarkdown(filename, new TextDecoder().decode(bytes));
    case "txt":
      return splitPlainText(filename, new TextDecoder().decode(bytes));
  }
}

/** Wraps low-level parser failures (corrupt or truncated binaries) so the error names the file. */
async function parseSectionsOrExplain(kind: Kind, filename: string, bytes: Uint8Array): Promise<Section[]> {
  try {
    return await parseSections(kind, filename, bytes);
  } catch (error) {
    if (error instanceof DocumentParseError) throw error;
    throw new DocumentParseError(
      filename,
      `could not read file — it may be corrupt or not a real ${kind} file`,
      { cause: error },
    );
  }
}

/** Parses an uploaded document, choosing the parser by its case-insensitive extension. */
export async function parseDocument(filename: string, bytes: Uint8Array): Promise<ParsedDocument> {
  const dot = filename.lastIndexOf(".");
  const extension = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  const kind = KINDS.get(extension);
  if (!kind) throw new DocumentParseError(filename, `unsupported file type ".${extension}"`);

  if (bytes.byteLength === 0) throw new DocumentParseError(filename, "file is empty");

  const sections = await parseSectionsOrExplain(kind, filename, bytes);
  if (sections.every((section) => section.text.trim() === "")) {
    throw new DocumentParseError(
      filename,
      kind === "pdf" ? "no readable text — is it a scanned image?" : "file is empty",
    );
  }
  return { filename, kind, sections };
}
