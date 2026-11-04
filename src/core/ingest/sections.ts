import type { Section } from "@/core/domain";

export type Block = { kind: "heading"; level: number; title: string } | { kind: "text"; text: string };

interface Group {
  heading: string | null;
  path: string | null;
  lines: string[];
}

interface StackNode {
  level: number;
  path: string;
  children: number;
}

const MAX_GROUP_CHARS = 1500;
const MARKDOWN_HEADING = /^(#{1,3})\s+(.*\S)\s*$/;
const NUMBERED_HEADING = /^\d+(\.\d+)*\s+\S/;

/** Builds sections from heading and text blocks. Heading refs come from nesting (§1, §1.1, §2). */
export function sectionsFromBlocks(filename: string, blocks: Block[]): Section[] {
  const groups: Group[] = [{ heading: null, path: null, lines: [] }];
  const stack: StackNode[] = [{ level: 0, path: "", children: 0 }];

  for (const block of blocks) {
    if (block.kind === "text") {
      groups[groups.length - 1].lines.push(block.text);
      continue;
    }
    while (stack[stack.length - 1].level >= block.level) stack.pop();
    const parent = stack[stack.length - 1];
    parent.children += 1;
    const path = parent.path === "" ? `${parent.children}` : `${parent.path}.${parent.children}`;
    stack.push({ level: block.level, path, children: 0 });
    groups.push({ heading: block.title, path, lines: [] });
  }

  const sections: Section[] = [];
  for (const group of groups) {
    const text = group.lines.join("\n").trim();
    if (group.path === null && text === "") continue;
    sections.push({ ref: `${filename} §${group.path ?? "0"}`, heading: group.heading, text });
  }
  return sections;
}

/** Splits markdown on #, ## and ### headings. */
export function splitMarkdown(filename: string, text: string): Section[] {
  const blocks = text.split(/\r?\n/).map((line): Block => {
    const match = MARKDOWN_HEADING.exec(line);
    return match ? { kind: "heading", level: match[1].length, title: match[2] } : { kind: "text", text: line };
  });
  return sectionsFromBlocks(filename, blocks);
}

function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  if (NUMBERED_HEADING.test(trimmed)) return true;
  return trimmed.length <= 60 && /[A-Z]/.test(trimmed) && trimmed === trimmed.toUpperCase();
}

/**
 * Splits plain text. Numbered or ALL CAPS lines start a section. Other text is grouped
 * by blank-line paragraphs, up to about 1500 characters per section.
 */
export function splitPlainText(filename: string, text: string): Section[] {
  const out: { heading: string | null; text: string }[] = [];
  let heading: string | null = null;
  let emitted = false;
  let group: string[] = [];
  let groupLength = 0;
  let paragraph: string[] = [];

  const emit = (body: string) => {
    out.push({ heading, text: body });
    emitted = true;
  };
  const flushGroup = () => {
    if (group.length === 0) return;
    emit(group.join("\n\n"));
    group = [];
    groupLength = 0;
  };
  const endParagraph = () => {
    if (paragraph.length === 0) return;
    const value = paragraph.join("\n");
    paragraph = [];
    if (group.length > 0 && groupLength + value.length + 2 > MAX_GROUP_CHARS) flushGroup();
    groupLength += group.length === 0 ? value.length : value.length + 2;
    group.push(value);
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") {
      endParagraph();
      continue;
    }
    if (looksLikeHeading(line)) {
      endParagraph();
      flushGroup();
      if (heading !== null && !emitted) emit("");
      heading = line.trim();
      emitted = false;
      continue;
    }
    paragraph.push(line);
  }
  endParagraph();
  flushGroup();
  if (heading !== null && !emitted) emit("");

  return out.map((section, index) => ({
    ref: `${filename} §${index + 1}`,
    heading: section.heading,
    text: section.text,
  }));
}
