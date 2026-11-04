/**
 * Minimal Atlassian Document Format helpers for issue descriptions.
 * Supports headings, bullet lists, checklists (rendered as bullets with a ☐ prefix)
 * and paragraphs. A blank line becomes an empty paragraph so text round-trips exactly.
 * Imports nothing from src/core.
 */

export type AdfNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
};

export type AdfDoc = { type: "doc"; version: 1; content: AdfNode[] };

const CHECKBOX_OPEN = "☐ ";

function paragraph(text: string): AdfNode {
  return text === "" ? { type: "paragraph", content: [] } : { type: "paragraph", content: [{ type: "text", text }] };
}

export function textToAdf(text: string): AdfDoc {
  const content: AdfNode[] = [];
  let list: AdfNode | null = null;

  const bullet = (itemText: string) => {
    if (!list) {
      list = { type: "bulletList", content: [] };
      content.push(list);
    }
    list.content!.push({ type: "listItem", content: [paragraph(itemText)] });
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("- [ ] ")) {
      bullet(CHECKBOX_OPEN + line.slice(6));
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      bullet(line.slice(2));
      continue;
    }
    list = null;
    if (line.startsWith("### ")) {
      if (line.length > 4) content.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: line.slice(4) }] });
    } else if (line.startsWith("## ")) {
      if (line.length > 3) content.push({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: line.slice(3) }] });
    } else {
      content.push(paragraph(line));
    }
  }

  return { type: "doc", version: 1, content };
}

function textOf(node: AdfNode): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(textOf).join("");
}

function blockToText(node: AdfNode): string {
  switch (node.type) {
    case "heading": {
      const level = Number(node.attrs?.level ?? 2);
      return "#".repeat(level) + " " + textOf(node);
    }
    case "paragraph":
      return textOf(node);
    case "bulletList":
      return (node.content ?? []).map((item) => "- " + (item.content ?? []).map(blockToText).join("\n")).join("\n");
    default:
      return textOf(node);
  }
}

export function adfToText(doc: AdfDoc): string {
  return doc.content.map(blockToText).join("\n");
}
