// Commit bodies are conventionally hard-wrapped at ~72 columns. Shown as-is in
// a narrow panel, every hard break lands mid-line and the text goes ragged.
// Reflow joins wrapped lines back into their paragraph, keeping the breaks that
// carry structure: blank lines, list items, trailers, and indented code.

const LIST_ITEM = /^\s*([-*+•]|\d+[.)])\s+/;
const TRAILER = /^[A-Za-z][A-Za-z0-9-]*: \S/;
const CODE = /^( {4}|\t)/;

export function reflowCommitBody(body: string): string {
  const out: string[] = [];
  let inList = false;

  for (const raw of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const prev = out.length > 0 ? out[out.length - 1] : null;

    if (line === "") {
      out.push("");
      inList = false;
      continue;
    }

    const isListItem = LIST_ITEM.test(line);
    const startsBlock =
      prev === null ||
      prev === "" ||
      isListItem ||
      TRAILER.test(line) ||
      TRAILER.test(prev) ||
      // Indented code outside a list; inside a list, indentation is just the
      // continuation of the item above.
      (!inList && (CODE.test(line) || CODE.test(prev)));

    if (isListItem) inList = true;

    if (startsBlock) out.push(line);
    else out[out.length - 1] = `${prev} ${line.trim()}`;
  }

  return out.join("\n").trim();
}
