import type { ActivitySpec } from "./types.js";

export type CommandGlossaryEntry = { term: string; definition: string; location: string };
export type CommandPolicy = { source: "syllabus-glossary" | "fallback"; entries: CommandGlossaryEntry[] };

export const FALLBACK_COMMAND_GLOSSARY: CommandGlossaryEntry[] = [
  { term: "State", definition: "Give a concise answer without explanation.", location: "Application fallback" },
  { term: "Identify", definition: "Name or select the required item.", location: "Application fallback" },
  { term: "Describe", definition: "Give the main features or observations.", location: "Application fallback" },
  { term: "Explain", definition: "Give reasons or show why something happens.", location: "Application fallback" },
  { term: "Compare", definition: "Give relevant similarities and differences.", location: "Application fallback" },
  { term: "Contrast", definition: "Give relevant differences.", location: "Application fallback" },
  { term: "Calculate", definition: "Obtain a numerical answer and show relevant working.", location: "Application fallback" },
  { term: "Determine", definition: "Obtain the required answer from the supplied information.", location: "Application fallback" },
  { term: "Predict", definition: "Give an expected result using the supplied information or pattern.", location: "Application fallback" },
  { term: "Deduce", definition: "Reach a conclusion from the supplied information.", location: "Application fallback" },
  { term: "Justify", definition: "Support an answer with evidence or reasoning.", location: "Application fallback" },
  { term: "Sketch", definition: "Draw the essential shape or trend with appropriate labels.", location: "Application fallback" },
  { term: "Plot", definition: "Mark data accurately on suitable labelled axes.", location: "Application fallback" },
];

const KNOWN_COMMANDS = [
  "account for", "analyse", "analyze", "assess", "calculate", "classify", "comment", "compare", "complete", "construct", "contrast", "deduce", "define", "describe",
  "determine", "discuss", "draw", "estimate", "evaluate", "explain", "find", "identify", "interpret", "justify",
  "list", "measure", "outline", "plot", "predict", "recognise", "recognize", "relate", "show", "sketch", "state", "suggest",
];

export const normalizeCommand = (value: string) => value.toLowerCase().replace(/[^a-z]+/g, " ").trim();

export function resolveCommandPolicy(glossary: CommandGlossaryEntry[]): CommandPolicy {
  const expanded = glossary.flatMap((entry) => entry.term.includes("/") ? entry.term.split("/").map((term) => ({ ...entry, term: term.trim() })) : [entry])
    .map((entry) => ({ ...entry, term: entry.term.replace(/\s*\(.*$/, "").trim() }));
  const unique = expanded
    .filter((entry) => entry.term.trim() && entry.definition.trim())
    .filter((entry, index, all) => all.findIndex((candidate) => normalizeCommand(candidate.term) === normalizeCommand(entry.term)) === index);
  return unique.length ? { source: "syllabus-glossary", entries: unique } : { source: "fallback", entries: FALLBACK_COMMAND_GLOSSARY };
}

const commandsIn = (value: string) => KNOWN_COMMANDS.filter((term) => new RegExp(`\\b${term}\\b`, "i").test(value));

export function commandWordIssues(spec: ActivitySpec, policy: CommandPolicy) {
  const issues: string[] = [];
  const allowed = new Set(policy.entries.map((entry) => normalizeCommand(entry.term)));
  for (const question of spec.questions) {
    for (const task of [...question.setATasks, ...question.setBTasks]) {
      const declared = commandsIn(task.commandWord);
      const declaredExact = allowed.has(normalizeCommand(task.commandWord));
      if (!declared.length && !declaredExact) issues.push(`Q${question.number}: commandWord "${task.commandWord}" is not a recognised command term.`);
      for (const term of declared) if (!allowed.has(normalizeCommand(term))) issues.push(`Q${question.number}: command word "${term}" is not permitted by the ${policy.source === "syllabus-glossary" ? "syllabus glossary" : "fallback command list"}.`);
    }
    const visible = `${question.sharedPrompt}\n${question.setATasks.map((task) => task.prompt).join("\n")}\n${question.setBTasks.map((task) => task.prompt).join("\n")}`;
    for (const term of commandsIn(visible)) if (!allowed.has(normalizeCommand(term))) issues.push(`Q${question.number}: visible prompt uses disallowed command word "${term}".`);
    const a = question.setATasks.flatMap((task) => commandsIn(task.prompt).filter((term) => allowed.has(normalizeCommand(term))));
    const b = question.setBTasks.flatMap((task) => commandsIn(task.prompt).filter((term) => allowed.has(normalizeCommand(term))));
    if (a.join("|") !== b.join("|")) issues.push(`Q${question.number}: Set A and Set B do not use the same allowed command words (${a.join(", ") || "none"} vs ${b.join(", ") || "none"}).`);
  }
  return [...new Set(issues)];
}
