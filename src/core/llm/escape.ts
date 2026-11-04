/**
 * Escaping for document text placed inside prompt wrapper tags, such as <guideline> or <routing>.
 * Keeps the text from closing its own tag or breaking a quoted attribute.
 */

/** Escapes a value for use inside a double-quoted attribute. */
export function escapeAttribute(value: string): string {
  return value.replace(/["<>]/g, (c) => ({ '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

/** Escapes any `</tag` sequence in body text (case-insensitive) so it cannot close the wrapper tag. */
export function escapeTagBody(content: string, tag: string): string {
  return content.replace(new RegExp(`</${tag}`, "gi"), `&lt;/${tag}`);
}
