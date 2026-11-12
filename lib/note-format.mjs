/** Plain text plus bold; HTML in a note always remains literal text. */
export function noteRuns(value) {
  const runs = [];
  const pattern = /\*\*([^]*?)\*\*/gu;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    if (!match[1]) continue;
    if (match.index > offset) runs.push({ text: value.slice(offset, match.index), bold: false });
    runs.push({ text: match[1], bold: true });
    offset = match.index + match[0].length;
  }
  if (offset < value.length) runs.push({ text: value.slice(offset), bold: false });
  return runs;
}

export function serializeNoteEditor(root) {
  const serialize = (node) => {
    if (node.nodeType === 3) return node.nodeValue ?? "";
    if (node.nodeName === "BR") return "\n";
    const children = Array.from(node.childNodes);
    if (children.length === 1 && children[0].nodeName === "BR") return "";
    let result = "";
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const isBlock = (item) => /^(DIV|P|LI|H[1-6])$/u.test(item?.nodeName ?? "");
      if (index && (isBlock(child) || isBlock(children[index - 1]))) result += "\n";
      result += serialize(child);
    }
    const weight = node.style?.fontWeight;
    return result && (["B", "STRONG"].includes(node.nodeName) || weight === "bold" || Number(weight) >= 600) ? `**${result}**` : result;
  };
  return serialize(root).replaceAll("\u00a0", " ");
}
