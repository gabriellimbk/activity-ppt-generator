type RunOptions = { bold?: boolean; subscript?: boolean; superscript?: boolean };
export type RichRun = { text: string; options: RunOptions };

const subscriptMap: Record<string, string> = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9", "₊": "+", "₋": "-", "₍": "(", "₎": ")" };
const superscriptMap: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "-", "⁽": "(", "⁾": ")" };

function normalizeMarkup(value: string) {
  return value
    .replace(/\$+/g, "")
    .replace(/\\(?:ce|mathrm|text)\{([^{}]*)\}/g, "$1")
    .replace(/\\rightleftharpoons|\\leftrightharpoons/g, "⇌")
    .replace(/\\rightarrow|\\to/g, "→")
    .replace(/\\leftarrow/g, "←")
    .replace(/\\Delta/g, "Δ")
    .replace(/E\^?\{?\\(?:ominus|circ|degree)\}?/gi, "E°")
    .replace(/\\theta/g, "θ")
    .replace(/E\^?\{?(?:θ|ϴ|ᶿ|⊖|⌀)\}?/g, "E°")
    .replace(/\bE0\b/g, "E°")
    .replace(/E°_?\{?cell\}?/gi, "E°_{cell}")
    .replace(/E°\s+cell\b/gi, "E°_{cell}")
    .replace(/\b((?:Be|Mg|Ca|Sr|Ba))2-(?=\b|[\s,.;)])/g, "$1^{2+}")
    .replace(/\bM2-(?=[\s-]+(?:ion|cation)\b)/gi, "M^{2+}")
    .replace(/\b([A-Z][a-z]?)["”]\s*\+/g, "$1^{2+}")
    .replace(/\b([A-Z][a-z]?)#\s*\+/g, "$1^{3+}")
    .replace(/\b([A-Z][a-z]?)(\d*)([+-])(?=\b|[\s,.;()])/g, (_m, element, magnitude, sign) => `${element}^{${magnitude}${sign}}`)
    .replace(/\b((?:[A-Z][a-z]?\d*)+)\s+(\d+)([+-])(?=\s|$|[.,;:)])/g, "$1^{$2$3}")
    .replace(/\be([+-])(?=\b|[\s,.;)])/g, "e^{$1}")
    .replace(/\bmol-(\d+)\b/g, "mol^{-$1}")
    .replace(/\b((?:[A-Z][a-z]?){1,6}\d+(?:[A-Z][a-z]?\d*)*)\b/g, (formula) => formula.replace(/(\d+)/g, "_{$1}"));
}

export function scienceRuns(value: string, options: { bold?: boolean; boldFirstWords?: number } = {}): RichRun[] {
  const input = normalizeMarkup(value);
  const runs: RichRun[] = []; let buffer = ""; let bold = Boolean(options.bold);
  const push = (text: string, extra: RunOptions = {}) => {
    if (!text) return;
    const runOptions = { bold, ...extra };
    const previous = runs.at(-1);
    if (previous && JSON.stringify(previous.options) === JSON.stringify(runOptions)) previous.text += text;
    else runs.push({ text, options: runOptions });
  };
  const flush = () => { push(buffer); buffer = ""; };
  for (let i = 0; i < input.length;) {
    if (input.startsWith("**", i)) { flush(); bold = !bold; i += 2; continue; }
    const marker = input[i];
    if (marker === "_" || marker === "^") {
      const script = marker === "_" ? { subscript: true } : { superscript: true };
      flush(); i++;
      if (input[i] === "{") { const end = input.indexOf("}", i + 1); if (end >= 0) { push(input.slice(i + 1, end), script); i = end + 1; continue; } }
      if (i < input.length) { push(input[i], script); i++; continue; }
    }
    if (subscriptMap[marker]) { flush(); push(subscriptMap[marker], { subscript: true }); i++; continue; }
    if (superscriptMap[marker]) { flush(); push(superscriptMap[marker], { superscript: true }); i++; continue; }
    buffer += marker; i++;
  }
  flush();
  if (!options.boldFirstWords) return runs;
  let remaining = options.boldFirstWords; const refined: RichRun[] = [];
  for (const run of runs) {
    if (remaining <= 0 || run.options.bold || run.options.subscript || run.options.superscript) { refined.push(run); continue; }
    const matches = [...run.text.matchAll(/\b[\p{L}\p{N}]+\b/gu)];
    if (!matches.length) { refined.push(run); continue; }
    const selected = matches[Math.min(remaining, matches.length) - 1]; const cut = (selected.index ?? 0) + selected[0].length;
    refined.push({ text: run.text.slice(0, cut), options: { ...run.options, bold: true } });
    if (cut < run.text.length) refined.push({ text: run.text.slice(cut), options: run.options });
    remaining -= Math.min(remaining, matches.length);
  }
  return refined;
}

export function plainScienceText(value: string) { return scienceRuns(value).map((run) => run.text).join(""); }

const unicodeSubscript: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "(": "₍", ")": "₎" };
const unicodeSuperscript: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "(": "⁽", ")": "⁾" };
export function unicodeScienceText(value: string) {
  return scienceRuns(value).map((run) => run.options.subscript ? [...run.text].map((char) => unicodeSubscript[char] ?? char).join("") : run.options.superscript ? [...run.text].map((char) => unicodeSuperscript[char] ?? char).join("") : run.text).join("");
}
