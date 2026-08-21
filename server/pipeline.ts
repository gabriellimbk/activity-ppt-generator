import { GoogleGenAI, createPartFromUri, createUserContent } from "@google/genai";
import { PDFDocument } from "pdf-lib";
import mammoth from "mammoth";
import JSZip from "jszip";
import { z } from "zod";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { activitySpecSchema, type ActivitySpec, type Job } from "./types.js";
import { renderDecks } from "./pptx.js";
import { commandWordIssues, resolveCommandPolicy, type CommandGlossaryEntry, type CommandPolicy } from "./commands.js";

const execFileAsync = promisify(execFile);
export type InputFile = { path: string; originalname: string; role: string };
type Normalized = InputFile & { evidencePath: string; mime: string; pages: number; warning?: string };

const setStage = (job: Job, stage: Job["stage"], progress: number) => {
  job.stage = stage; job.progress = progress;
  const payload = { status: job.status, stage, progress, warnings: job.warnings };
  for (const send of job.events) send(payload);
};
const assertActive = (job: Job) => { if (job.abort.signal.aborted) throw new DOMException("Cancelled", "AbortError"); };

export async function normalize(input: InputFile, dir: string): Promise<Normalized> {
  const ext = extname(input.originalname).toLowerCase();
  if (ext === ".pdf") {
    const target = join(dir, `${crypto.randomUUID()}.pdf`); await copyFile(input.path, target);
    const pages = (await PDFDocument.load(await readFile(target), { ignoreEncryption: true })).getPageCount();
    return { ...input, evidencePath: target, mime: "application/pdf", pages };
  }
  const pdf = join(dir, `${crypto.randomUUID()}.pdf`);
  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(process.cwd(), "server", "scripts", "convert-office.ps1"), input.path, pdf], { timeout: 180_000 });
    const pages = (await PDFDocument.load(await readFile(pdf), { ignoreEncryption: true })).getPageCount();
    return { ...input, evidencePath: pdf, mime: "application/pdf", pages };
  } catch {
    let text = "";
    if (ext === ".docx") text = (await mammoth.extractRawText({ path: input.path })).value;
    else {
      const zip = await JSZip.loadAsync(await readFile(input.path));
      const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort();
      for (const name of slides) text += `\n[${name}]\n${((await zip.file(name)?.async("string")) ?? "").replace(/<a:t>(.*?)<\/a:t>/g, "$1 ").replace(/<[^>]+>/g, " ")}`;
    }
    const fallback = join(dir, `${crypto.randomUUID()}.txt`); await writeFile(fallback, text);
    return { ...input, evidencePath: fallback, mime: "text/plain", pages: Math.max(1, Math.ceil(text.length / 3500)), warning: `${input.originalname}: Office-to-PDF conversion failed; text-only evidence was used.` };
  }
}

const locatedEvidenceSchema = z.object({
  location: z.string(),
  evidence: z.string(),
  kind: z.enum(["learning-outcome", "definition", "principle", "worked-example", "tutorial-question", "supplied-answer", "data", "visual"]),
});
const extractionSchema = z.object({
  summary: z.string(), outcomes: z.array(z.string()), concepts: z.array(z.string()), commandWords: z.array(z.string()),
  commandGlossary: z.array(z.object({ term: z.string(), definition: z.string(), location: z.string() })).default([]),
  answerEvidence: z.array(locatedEvidenceSchema), exclusions: z.array(z.string()), conflicts: z.array(z.string()),
  references: z.array(locatedEvidenceSchema),
});
const referenceFormatSchema = z.object({
  summary: z.string(),
  studentDeckPatterns: z.array(z.string()),
  compiledDeckPatterns: z.array(z.string()),
  typography: z.array(z.string()),
  palette: z.array(z.string()),
  densityAndSpacing: z.array(z.string()),
  mandatoryFormatRules: z.array(z.string()),
});
const curriculumTargetSchema = z.object({
  id: z.string().min(1), syllabusOutcome: z.string().min(3), syllabusLocation: z.string().min(1),
  lectureEvidence: z.array(z.object({ file: z.string(), location: z.string(), wording: z.string().min(3) })).min(1).max(5),
  taskAnchors: z.array(z.object({
    file: z.string(), location: z.string(), wording: z.string().min(3),
    kind: z.enum(["tutorial-question", "worked-example", "learning-outcome", "lecture-example"]),
  })).min(1).max(5),
  permittedCommands: z.array(z.string()).min(1),
  permittedResponseTypes: z.array(z.enum(["text", "graph", "table", "diagram"])).min(1),
  exclusions: z.array(z.string()).default([]),
});
const curriculumMapSchema = z.object({
  topic: z.string(), targets: z.array(curriculumTargetSchema).min(3).max(20), globalExclusions: z.array(z.string()).default([]),
});
export type CurriculumMap = z.infer<typeof curriculumMapSchema>;
const geminiSchema = (schema: z.ZodType) => {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !["$schema", "default", "pattern", "minimum", "maximum", "minItems", "maxItems", "additionalProperties"].includes(key)).map(([key, child]) => [key, scrub(child)]));
    return value;
  };
  return scrub(json);
};

async function uploadAndExtract(ai: GoogleGenAI, model: string, file: Normalized, signal: AbortSignal, onUpload: (name: string) => void) {
  let uploaded = await ai.files.upload({ file: file.evidencePath, config: { mimeType: file.mime, displayName: file.originalname } });
  if (uploaded.name) onUpload(uploaded.name);
  for (let attempt = 0; uploaded.name && String(uploaded.state).toUpperCase().includes("PROCESSING") && attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000)); uploaded = await ai.files.get({ name: uploaded.name });
  }
  if (!uploaded.uri || !uploaded.mimeType || String(uploaded.state).toUpperCase().includes("FAILED")) throw new Error(`Gemini did not return a usable file for ${file.originalname}.`);
  const response = await ai.models.generateContent({
    model,
    contents: createUserContent([createPartFromUri(uploaded.uri, uploaded.mimeType), `Extract classroom-activity evidence from this ${file.role} source. Stay source-locked: use only information visibly present in this file and do not complete, correct or enrich it from general knowledge. Preserve exact page or slide references for every evidence item. Record definitions, principles, worked examples, tutorial questions, supplied answers, data and visuals separately. In answerEvidence, include only wording or close faithful paraphrases that could directly support a model answer. If and only if this document contains a glossary or explicit definitions of examination command words, copy every command term into commandGlossary with its faithful definition and exact page or slide location. Do not infer or invent glossary entries. commandWords may list other visibly used task verbs, but commandGlossary must contain only explicitly defined glossary terms. Return structured JSON.`]),
    config: { abortSignal: signal, responseMimeType: "application/json", responseJsonSchema: geminiSchema(extractionSchema) },
  });
  const parsed = extractionSchema.parse(JSON.parse(response.text ?? "{}"));
  return { file: file.originalname, role: file.role, data: parsed, uploadedName: uploaded.name };
}

async function uploadAndAnalyzeReference(ai: GoogleGenAI, model: string, file: Normalized, signal: AbortSignal, onUpload: (name: string) => void) {
  let uploaded = await ai.files.upload({ file: file.evidencePath, config: { mimeType: file.mime, displayName: file.originalname } });
  if (uploaded.name) onUpload(uploaded.name);
  for (let attempt = 0; uploaded.name && String(uploaded.state).toUpperCase().includes("PROCESSING") && attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000)); uploaded = await ai.files.get({ name: uploaded.name });
  }
  if (!uploaded.uri || !uploaded.mimeType || String(uploaded.state).toUpperCase().includes("FAILED")) throw new Error(`Gemini did not return a usable reference file for ${file.originalname}.`);
  const response = await ai.models.generateContent({
    model,
    contents: createUserContent([createPartFromUri(uploaded.uri, uploaded.mimeType), "Analyse this PowerPoint only as a visual and structural reference. Ignore its subject facts. Describe its student-question layouts, compiled-answer layouts, typography, palette, spacing, question-number treatment, dividers, highlighting, graph placement and density. Explicitly state how many slides each question occupies."]),
    config: { abortSignal: signal, responseMimeType: "application/json", responseJsonSchema: geminiSchema(referenceFormatSchema) },
  });
  return { file: file.originalname, data: referenceFormatSchema.parse(JSON.parse(response.text ?? "{}")) };
}

function mockSpec(files: Normalized[], count = 5): ActivitySpec {
  const n = Math.max(3, Math.min(8, count));
  return activitySpecSchema.parse({
    topic: "Collaborative Learning Activity", audience: "Students",
    instructions: ["Work within your assigned group and answer as many questions correctly as possible within the time limit.", "Do not use online or lecture-note references.", "Your group may use one true/false teacher lifeline once."],
    design: { primary: "#000000", secondary: "#000000", accent: "#FFF200", background: "#FFFFFF", headingFont: "Arial", bodyFont: "Arial", layoutFamily: "reference-split", promptHighlight: true },
    questions: Array.from({ length: n }, (_, i) => {
      const source = { file: files[0]?.originalname ?? "source.pdf", location: "page 1", note: `Mock evidence for core concept ${i + 1}.` };
      return {
        number: i + 1, curriculumTargetId: `mock-${i + 1}`, concept: `Core concept ${i + 1}`,
        pairingMethod: i % 2 ? "complementary examples" : "shared anchor", responseType: i === 2 ? "graph" : "text",
        sharedPromptMode: "context", sharedPrompt: "The supplied learning materials establish the relevant principle.",
        setATasks: [{ prompt: `Explain aspect A of core concept ${i + 1}.`, answer: `A complete Set A response for core concept ${i + 1}, supported by the supplied material.`, commandWord: "Explain" }],
        setBTasks: [{ prompt: `Explain aspect B of core concept ${i + 1}.`, answer: `A complete Set B response for core concept ${i + 1}, supported by the supplied material.`, commandWord: "Explain" }],
        commonAnswer: `Both tasks depend on the same underlying principle for core concept ${i + 1}.`, difficulty: "standard", expectedMinutes: 4,
        sources: [source], evidence: { common: [source], setA: [source], setB: [source] }, warnings: ["Mock-generation mode was used; replace with a live Gemini run before classroom use."],
        graph: i === 2 ? { xLabel: "Input", yLabel: "Response", series: [{ name: "Trend", xTickLabels: ["A", "B"], points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] } : undefined,
      };
    }),
    warnings: ["Mock-generation mode was used for local verification."],
  });
}

const requestedCount = (additional: string) => {
  const match = additional.match(/\b(\d+|three|four|five|six|seven|eight|nine|ten)\s+(?:question|pair)/i);
  if (!match) return 5;
  const words: Record<string, number> = { three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  return words[match[1].toLowerCase()] ?? Number(match[1]);
};

type SourceFileMap = { file: string; role: string; data: z.infer<typeof extractionSchema> };
const locationKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const groundingIssues = (spec: ActivitySpec, files: SourceFileMap[]) => {
  const byFile = new Map(files.map((entry) => [entry.file.toLowerCase(), entry]));
  const issues: string[] = [];
  for (const question of spec.questions) {
    for (const [portion, refs] of Object.entries(question.evidence)) {
      for (const ref of refs) {
        const source = byFile.get(ref.file.toLowerCase());
        if (!source) { issues.push(`Q${question.number} ${portion}: unknown evidence file "${ref.file}".`); continue; }
        if (/syllabus/i.test(source.role)) issues.push(`Q${question.number} ${portion}: expected-answer evidence cannot rely only on the syllabus (${ref.file}).`);
        const knownLocations = [...source.data.answerEvidence, ...source.data.references].map((item) => locationKey(item.location));
        const requested = locationKey(ref.location);
        if (!requested || !knownLocations.some((known) => known === requested || known.includes(requested) || requested.includes(known))) issues.push(`Q${question.number} ${portion}: "${ref.location}" is not a located evidence reference in ${ref.file}.`);
      }
    }
  }
  return issues;
};

export const curriculumIssues = (spec: ActivitySpec, curriculumMap: CurriculumMap) => {
  const issues: string[] = [];
  const targets = new Map(curriculumMap.targets.map((target) => [target.id, target]));
  const normal = (value: string) => value.replace(/\*\*/g, "").toLowerCase().replace(/[^a-z0-9°.+−-]+/g, " ").trim();
  const numbers = (value: string) => value.match(/(?<![a-z])\d+(?:\.\d+)?(?:\s*(?:g|kg|mol|cm3|dm3|°c|k|v))?/gi)?.map(normal) ?? [];
  const tokens = (value: string) => new Set(normal(value).split(" ").filter((token) => token.length > 3 && !/^(?:explain|describe|state|identify|question|using|which|their|about)$/.test(token)));
  const anchorOverlap = (prompt: string, anchors: string[]) => {
    const promptTokens = tokens(prompt); if (!promptTokens.size) return 1;
    return Math.max(0, ...anchors.map((anchor) => {
      const anchorTokens = tokens(anchor);
      return [...promptTokens].filter((token) => anchorTokens.has(token)).length / promptTokens.size;
    }));
  };
  for (const question of spec.questions) {
    const target = targets.get(question.curriculumTargetId);
    if (!target) { issues.push(`Q${question.number}: unknown curriculumTargetId "${question.curriculumTargetId}".`); continue; }
    const allowedCommands = new Set(target.permittedCommands.map(normal));
    if (!target.permittedResponseTypes.includes(question.responseType)) issues.push(`Q${question.number}: ${question.responseType} is not an allowed response form for curriculum target ${target.id}.`);
    const sourceWording = [...target.lectureEvidence.map((item) => item.wording), ...target.taskAnchors.map((item) => item.wording)].join(" ");
    const allowedNumbers = new Set(numbers(sourceWording));
    for (const task of [...question.setATasks, ...question.setBTasks]) {
      if (!allowedCommands.has(normal(task.commandWord))) issues.push(`Q${question.number}: command "${task.commandWord}" is not permitted by curriculum target ${target.id}.`);
      if (/^(?:define|what is meant by|what do you understand by)$/i.test(task.commandWord.trim()) && !/\b(?:define|definition|what is meant by|what do you understand by)\b/i.test(target.syllabusOutcome)) issues.push(`Q${question.number}: a definition command is not explicitly required by the mapped syllabus outcome.`);
      if (anchorOverlap(task.prompt, target.taskAnchors.map((anchor) => anchor.wording)) < 0.3) issues.push(`Q${question.number}: prompt is not a close enough adaptation of any task anchor for target ${target.id}.`);
      for (const value of numbers(task.prompt)) if (!allowedNumbers.has(value)) issues.push(`Q${question.number}: numeric value "${value}" is absent from the target's lecture/tutorial anchors.`);
    }
  }
  return issues;
};

const pairingIssues = (spec: ActivitySpec) => {
  const issues: string[] = [];
  const command = (value: string) => value.match(/\b(explain|describe|state|identify|calculate|determine|compare|contrast|predict|deduce|sketch|plot|draw|complete|classify|justify|interpret|analyse|analyze)\b/i)?.[1].toLowerCase();
  const canonical = (value: string) => value.replace(/\*\*/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const startsAsTask = (value: string) => /^(?:what|which|why|how|use|give|write|name|label|show|explain|describe|state|identify|calculate|determine|compare|contrast|predict|deduce|sketch|plot|draw|complete|classify|justify|interpret|analyse|analyze)\b/i.test(value.replace(/\*\*/g, "").trim());
  const calculation = (value: string) => /\b(calculate|determine|moles?|molar mass|mass loss|sample)\b|\d+(?:\.\d+)?\s*(?:g|mol|cm3|dm3)\b/i.test(value);
  const equation = (value: string) => /\b(equation|half-equation|ionic equation)\b|→|⇌/.test(value);
  const answerOverlap = (context: string, answer: string) => {
    const contextTokens = new Set(canonical(context).split(" ").filter((token) => token.length > 3));
    const answerTokens = new Set(canonical(answer).split(" ").filter((token) => token.length > 3));
    if (answerTokens.size < 5) return 0;
    const shared = [...answerTokens].filter((token) => contextTokens.has(token)).length;
    return shared / Math.min(answerTokens.size, Math.max(1, contextTokens.size));
  };
  const refersToStimulus = (value: string) => /\b(?:refer(?:ring)? to|shown|displayed|supplied|above|table|graph|diagram|data|passage|extract|image|figure)\b/i.test(value);
  const graphAction = (value: string) => /\b(?:sketch|plot|draw|complete|label|interpret)\b[^.?!]{0,90}\b(?:graph|curve|trend|axes?)\b|\b(?:graph|curve|axes?)\b[^.?!]{0,90}\b(?:sketch|plot|draw|complete|label|interpret)\b/i.test(value);
  const tableAction = (value: string) => /\b(?:complet(?:e|es|ed|ing)|fill(?:s|ed|ing)?(?: in)?|populat(?:e|es|ed|ing)|construct(?:s|ed|ing)?)\b[^.?!]{0,90}\btable\b|\btable\b[^.?!]{0,90}\b(?:complet(?:e|es|ed|ing)|fill(?:s|ed|ing)?(?: in)?|populat(?:e|es|ed|ing)|construct(?:s|ed|ing)?)\b/i.test(value);
  const verbalAction = (value: string) => /\b(?:explain|describe|justify|deduce|predict|compare|contrast|interpret|state|identify)\b/i.test(value);
  const causalAnswer = (value: string) => /\b(?:because|due to|therefore|hence|as a result|caused by|results? from|increased? nuclear|shielding|attraction)\b/i.test(value);
  for (const question of spec.questions) {
    if (/\?\s*$/.test(question.sharedPrompt) || startsAsTask(question.sharedPrompt)) issues.push(`Q${question.number}: sharedPrompt is an unstructured student task. Move every question into setATasks or setBTasks and keep sharedPrompt declarative.`);
    if (question.setATasks.length !== question.setBTasks.length) issues.push(`Q${question.number}: Set A has ${question.setATasks.length} task(s) while Set B has ${question.setBTasks.length}; balance the numbered item.`);
    for (const task of [...question.setATasks, ...question.setBTasks]) {
      const phrase = task.commandWord.replace(/\*\*/g, "").trim();
      if (phrase) {
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const occurrences = task.prompt.match(new RegExp(`\\b${escaped}\\b`, "gi"))?.length ?? 0;
        if (occurrences > 1) issues.push(`Q${question.number}: "${task.prompt.slice(0, 90)}" contains ${occurrences} separate ${phrase} instructions inside one task. Split them into separate task objects so the compiled union can align and deduplicate them correctly.`);
      }
    }
    const pairedCount = Math.min(question.setATasks.length, question.setBTasks.length);
    for (let index = 0; index < pairedCount; index++) {
      const taskA = question.setATasks[index], taskB = question.setBTasks[index];
      const commandA = command(taskA.prompt), commandB = command(taskB.prompt);
      if (commandA && commandB && commandA !== commandB) issues.push(`Q${question.number}.${index + 1}: Set A uses "${commandA}" while Set B uses "${commandB}"; align the command word and cognitive level.`);
      if (calculation(taskA.prompt) !== calculation(taskB.prompt)) issues.push(`Q${question.number}.${index + 1}: only one set contains a numerical calculation or supplied numerical dataset; replace or rebalance the pair.`);
      if (equation(taskA.prompt) !== equation(taskB.prompt)) issues.push(`Q${question.number}.${index + 1}: only one set requires an equation; make the required outputs equivalent.`);
    }
    if (question.responseType === "graph" && question.graph) {
      for (const task of [...question.setATasks, ...question.setBTasks]) {
        if (!graphAction(task.prompt)) issues.push(`Q${question.number}: responseType is graph, but "${task.prompt.slice(0, 70)}" does not explicitly ask for a graph action.`);
        const pureGraphTask = graphAction(task.prompt) && !verbalAction(task.prompt.replace(/\b(?:sketch|plot|draw|complete|label)\b/ig, ""));
        if (pureGraphTask && (causalAnswer(task.answer) || task.answer.length > 160)) issues.push(`Q${question.number}: a pure graph task has an explanatory prose answer. The plotted graph must be the answer; either reduce answer to a concise trend label or add a separate explicit Describe/Explain task to both sets.`);
      }
      for (const series of question.graph.series) {
        if (!series.xTickLabels?.length) issues.push(`Q${question.number}: graph series "${series.name}" is missing one concise x-axis label for each plotted point.`);
        else if (series.xTickLabels.length !== series.points.length) issues.push(`Q${question.number}: graph series "${series.name}" has ${series.points.length} points but ${series.xTickLabels.length} x-axis labels.`);
      }
    }
    if (question.responseType === "table" && !question.table) issues.push(`Q${question.number}: table response is missing headings, row labels and completed answer cells.`);
    if (question.responseType === "table" && question.table) {
      for (const task of [...question.setATasks, ...question.setBTasks]) if (!tableAction(task.prompt)) issues.push(`Q${question.number}: a table was created for "${task.prompt.slice(0, 70)}", but the question does not explicitly ask students to complete or construct a table; use a text response instead.`);
      const checkRows = (audience: "A" | "B", labels: string[], rows: string[][]) => {
        if (rows.length !== labels.length) issues.push(`Q${question.number}: Set ${audience} has ${labels.length} table row label(s) but ${rows.length} completed answer row(s).`);
        rows.forEach((row, index) => { if (row.length !== question.table!.columns.length) issues.push(`Q${question.number}: Set ${audience} answer row ${index + 1} has ${row.length} cell(s); expected ${question.table!.columns.length}.`); });
      };
      checkRows("A", question.table.setARowLabels, question.table.setAAnswerRows);
      checkRows("B", question.table.setBRowLabels, question.table.setBAnswerRows);
    }
    const allPromptText = [question.sharedPrompt, ...question.setATasks.map((task) => task.prompt), ...question.setBTasks.map((task) => task.prompt)].join(" ");
    const taskPromptText = [...question.setATasks, ...question.setBTasks].map((task) => task.prompt).join(" ");
    if (question.sharedStimulusRequired && !refersToStimulus(taskPromptText) && question.responseType !== "graph" && question.responseType !== "table") issues.push(`Q${question.number}: sharedStimulusRequired is true, but no student task explicitly refers to shared data, a passage, image, equation or other displayed stimulus. Disable explanatory context.`);
    for (const task of [...question.setATasks, ...question.setBTasks]) if (answerOverlap(question.sharedPrompt, task.answer) >= 0.72) issues.push(`Q${question.number}: sharedPrompt substantially reveals the answer to "${task.prompt.slice(0, 70)}". Replace it with neutral context that does not answer the student task.`);
    if (question.responseType === "diagram" && !/\b(draw|sketch|construct|complete|interpret|label)\b.*\b(diagram|representation|structure|cycle|mechanism)\b|\bdiagram\b/i.test(allPromptText)) issues.push(`Q${question.number}: a diagram was specified even though neither set is asked to draw, complete, label or interpret one; use a text response instead.`);
    for (const taskA of question.setATasks) for (const taskB of question.setBTasks) {
      if (canonical(taskA.prompt) === canonical(taskB.prompt) && canonical(taskA.answer) !== canonical(taskB.answer)) issues.push(`Q${question.number}: an identical Set A/Set B question has different answers. Make the answer text identical so the compiled deck can display one question and one answer.`);
    }
    const uniqueTasks = [...question.setATasks, ...question.setBTasks].filter((task, index, all) => all.findIndex((candidate) => canonical(candidate.prompt) === canonical(task.prompt)) === index);
    if (uniqueTasks.length >= 3) for (const task of uniqueTasks) if (task.answer.length > 360) issues.push(`Q${question.number}: the answer to "${task.prompt.slice(0, 60)}" is too long for a ${uniqueTasks.length}-answer debrief slide; condense it to essential source-supported marking points.`);
  }
  return issues;
};

export async function runPipeline(job: Job, materials: InputFile[], syllabus: InputFile, references: InputFile[], designPrompt: string, additionalPrompt: string) {
  job.status = "running";
  const normalizedDir = join(job.dir, "normalized"); await mkdir(normalizedDir, { recursive: true });
  let cleanupAi: GoogleGenAI | undefined; const hostedNames: string[] = [];
  try {
    setStage(job, "Preparing files", 8); assertActive(job);
    const normalized = await Promise.all([syllabus, ...materials].map((file) => normalize(file, normalizedDir)));
    const normalizedReferences = await Promise.all(references.map((file) => normalize(file, normalizedDir)));
    const totalPages = [...normalized, ...normalizedReferences].reduce((sum, file) => sum + file.pages, 0);
    if (totalPages > 1000) throw new Error(`The job contains ${totalPages} pages; the maximum is 1,000.`);
    for (const warning of normalized.flatMap((file) => file.warning ? [file.warning] : [])) job.warnings.push(warning);
    const rawCount = requestedCount(additionalPrompt); const count = Math.max(3, Math.min(8, rawCount));
    if (rawCount !== count) job.warnings.push(`Requested ${rawCount} questions; adjusted to the supported range (${count}).`);
    additionalPrompt = `IMMUTABLE TASK-UNION, RESPONSE-CONTRACT AND LAYOUT RULE: Each numbered item may contain one or two questions for Set A and the same number for Set B. Store them individually in setATasks and setBTasks, in counterpart order. Set sharedStimulusRequired=false by default. Set it true only when students must actually inspect shared data, a passage, quotation, image, equation, graph, table or diagram displayed on the slide and the task wording explicitly refers to that stimulus. Never create a context column merely for a topic description, orientation, summary or general background; without essential shared stimulus, use the full slide for questions and working space. sharedPrompt must not contain an instruction, command word, question mark, hidden task, model answer, definition, conclusion or wording that substantially reveals any task answer. A question may be identical across Set A and Set B. In that case, make its prompt and answer text exactly identical. The compiled answer slide must display the union of unique questions: shared identical questions once, plus each Set-specific question once. For example, two questions in A and two in B with one identical question produce three questions and three answers in the compiled slide. When a compiled slide contains three or more unique questions, condense every answer to essential source-supported marking points (normally no more than about 45 words). The response form must match the visible command exactly. For a pure Sketch, Plot or Draw task, the completed visual is the answer; never attach unasked Describe or Explain prose. If explanation is required, add a separate explicit counterpart task in both sets. Use responseType=table only when every displayed task explicitly asks students to complete, fill, populate or construct the table. Store the label-column heading in rowHeader, response headings only in columns, and complete every answer cell in setAAnswerRows and setBAnswerRows. A plain Describe or Explain task must use responseType=text.\n\n${additionalPrompt}`;
    let spec: ActivitySpec; let appliedCommandPolicy: CommandPolicy | undefined; let appliedCurriculumMap: CurriculumMap | undefined;
    if (process.env.GEMINI_FAKE === "1") {
      setStage(job, "Analysing syllabus", 24); spec = mockSpec(normalized, count);
      setStage(job, "Mapping content", 42); setStage(job, "Creating paired questions", 60);
    } else {
      const apiKey = process.env.GEMINI_API_KEY; if (!apiKey) throw new Error("GEMINI_API_KEY is missing from the server environment.");
      const ai = new GoogleGenAI({ apiKey }); cleanupAi = ai; const model = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
      setStage(job, "Analysing syllabus", 22);
      const concurrency = Math.max(1, Number(process.env.CROP_CONCURRENCY ?? 5));
      const results: Awaited<ReturnType<typeof uploadAndExtract>>[] = [];
      for (let i = 0; i < normalized.length; i += concurrency) results.push(...await Promise.all(normalized.slice(i, i + concurrency).map((file) => uploadAndExtract(ai, model, file, job.abort.signal, (name) => hostedNames.push(name)))));
      const referenceFormats: Awaited<ReturnType<typeof uploadAndAnalyzeReference>>[] = [];
      for (let i = 0; i < normalizedReferences.length; i += concurrency) referenceFormats.push(...await Promise.all(normalizedReferences.slice(i, i + concurrency).map((file) => uploadAndAnalyzeReference(ai, model, file, job.abort.signal, (name) => hostedNames.push(name)))));
      assertActive(job); setStage(job, "Mapping content", 42);
      const sourceFiles = results.map(({ uploadedName: _name, ...result }) => result);
      const groundingPolicy = [
        "Each numbered item contains one or two structured questions in setATasks and the same number of counterpart questions in setBTasks; sharedPrompt is declarative context only and never a task.",
        "Shared context or a topic summary must not state, paraphrase or substantially reveal the answer to any student task.",
        "Set sharedStimulusRequired false by default. A visible shared-information column is allowed only when the task explicitly requires students to inspect displayed data, a passage, quotation, image, equation, graph, table or diagram.",
        "The compiled debrief is the union of unique questions across both sets. Identical questions and answers appear once; Set-specific questions each appear once.",
        "The visible command, response artifact and compiled answer must request and show the same output. A pure Sketch, Plot or Draw task is answered by its completed visual, without unasked prose explanation.",
        "Use a table only for an explicit Complete, Fill, Populate or Construct-the-table task. Provide source-supported completed cells for every row; use text for plain Describe or Explain questions.",
        "The syllabus controls scope and outcomes, but it is not sufficient evidence for an expected answer.",
        "Lecture notes, worked examples, tutorials and supplied answers control question wording, facts, terminology, reasoning steps and marking points.",
        "Use no general subject knowledge to complete, improve, broaden or creatively extend the uploaded sources.",
        "Prefer minimal adaptations of explicitly taught concepts, examples, tutorial questions and supplied answers.",
        "Every fact, comparison, example, value, equation, mechanism and marking point must be supported by a located source item.",
        "Warnings may describe missing, ambiguous or conflicting evidence, but must not introduce a new subject claim or safety fact that is absent from the sources.",
        "Do not introduce a new substance, scenario, dataset, example or inference merely because it is plausible.",
        "If direct evidence is insufficient for both A and B, select another well-supported question pair.",
        "Populate evidence.common, evidence.setA and evidence.setB with exact filenames, exact page/slide locations and short faithful supporting wording.",
        "Never use vague locations such as source overview, lecture notes or throughout.",
        "Every question must name one curriculumTargetId from curriculumMap and remain a close adaptation of that target's taskAnchors.",
        "A content heading or lecture definition is not an assessable question target unless the mapped syllabus learning outcome explicitly requires definition.",
        "Do not merge separate curriculum targets, syllabus outcomes or source rows into one synthetic compound task.",
        "Do not introduce numerical values absent from the selected target's lecture evidence or task anchors.",
        "Reusing a central curriculum target is preferable to broadening into a weakly supported topic.",
      ];
      const syllabusSource = sourceFiles.find((file) => /syllabus/i.test(file.role));
      const commandPolicy = resolveCommandPolicy((syllabusSource?.data.commandGlossary ?? []) as CommandGlossaryEntry[]);
      appliedCommandPolicy = commandPolicy;
      const rawSourceMap = { groundingPolicy, commandPolicy, files: sourceFiles };
      const curriculumResponse = await ai.models.generateContent({
        model,
        contents: `Build a binding curriculum eligibility map before any classroom questions are written.

GLOBAL RULES:
- A target is eligible only when an explicit syllabus learning outcome intersects explicit lecture-note teaching.
- A syllabus content heading or a definition in lecture notes is not by itself an assessable target. Include Define/What is meant only when the syllabus learning outcome explicitly requires definition.
- Tutorial questions and worked examples may supply task wording and response form only when they map to that syllabus/lecture intersection.
- Preserve close source wording. Do not invent numerical values, substances, scenarios, comparisons or examples.
- Do not merge separate syllabus outcomes or separate source rows into a synthetic compound task.
- Breadth is not a goal. Several activity questions may legitimately assess the same central target using distinct source-supported anchors.
- Each target must cite its exact syllabus outcome/location, at least one exact lecture evidence item, and at least one exact task anchor.
- permittedCommands must be drawn from commandPolicy and be appropriate to the exact syllabus outcome. permittedResponseTypes must be demonstrated by the sources, not imagined.

SOURCE MAP:
${JSON.stringify(rawSourceMap)}

Return only the CurriculumMap JSON.`,
        config: { abortSignal: job.abort.signal, responseMimeType: "application/json", responseJsonSchema: geminiSchema(curriculumMapSchema) },
      });
      const curriculumMap = curriculumMapSchema.parse(JSON.parse(curriculumResponse.text ?? "{}"));
      appliedCurriculumMap = curriculumMap;
      const sourceMap = { ...rawSourceMap, curriculumMap };
      setStage(job, "Creating paired questions", 58);
      const generation = await ai.models.generateContent({ model, contents: `You are designing a subject-agnostic paired classroom activity.\n\nIMMUTABLE REQUIREMENTS: output exactly three editable PPTX decks downstream; provide complete source references and warnings; never make unsupported claims. Each deck has exactly one instruction slide plus one slide per question. The compiled deck must contain exactly one complete debrief slide per question. Never plan a continuation, separate solution, shared-explanation or answer-continued slide. Keep each Set A answer and Set B answer under about 90 words and the common synthesis under 35 words while preserving all essential marking points. Write answers as compact marking points, short bullets, equations or brief linked statements rather than dense prose. Visible slide strings must be audience-facing. Never include difficulty, minutes, pairing-method names, source commentary, layout instructions, or production metadata in question/answer text.\n\nSHARED PANEL: Set sharedPromptMode to task by default and write a concise action completed by both groups. You may use summary for selected questions only when a short declarative topic summary genuinely helps orient students before the paired tasks. Across five questions, use no more than two summaries; scale this proportion for other counts. Never use summary for graph or table questions, never use summaries consecutively, and never merely restate the set prompts. A summary should normally be under 25 words.\n\nPAIR PARITY: Each A/B pair must match command word, response form, number of requested outputs, number of equations/diagrams, expected marking points, workload and time. If one set must calculate from numerical data, write an equation, make observations, justify a trend, or draw a representation, the other set must perform the equivalent amount of work at the same cognitive level. Never pair an explanation with a multi-step calculation.\n\nCOMMAND-WORD AUTHORITY: The commandPolicy in SOURCE MAP is binding. When its source is syllabus-glossary, use only terms explicitly present in that glossary and apply each term according to its supplied definition. When its source is fallback, use only the listed conservative terms. Never use Analyse/Analyze, Discuss, Evaluate or any other unlisted command. Put the exact leading command phrase in commandWord. Set A and Set B must use the same command word or command phrase. Do not disguise an unlisted command as ordinary wording later in the prompt.\n\nREFERENCE AUTHORITY: reference-format files control visual hierarchy, composition and density only; never use their subject content as evidence. Follow their one-question-per-slide structure, compact answer style, question-number placement, split layouts and highlighting unless Additional Requirements explicitly override a flexible visual choice.\nREFERENCE FORMAT ANALYSIS:\n${JSON.stringify(referenceFormats)}\n\nNOTATION: For science and mathematics, use correct Unicode or LaTeX-style markup for subscripts and superscripts (H₂O or H_2O; SO₄²⁻ or SO_4^{2-}; x² or x^2), correct arrows, state symbols, units and E°. Never use theta or circled-minus as a degree-symbol substitute. You may wrap only genuinely important phrases in **double asterisks**; never bold a whole paragraph.\n\nVISUALS: Select graph, table or diagram only when required by the learning task. A graph response must explicitly ask students to plot, sketch, complete, label or interpret the displayed graph. In each graph series set audience to A, B or both. Use both only when both student decks genuinely use the same axes, domain and tick labels. When A and B graph different domains or categories, create one A series and one B series, each with its own xLabel, yLabel and one short xTickLabel per point. For every table response, provide concise table.columns plus setARowLabels and setBRowLabels so the student grid has meaningful editable headings and the correct items for that set. For a diagram answer, supply 2–7 concise nodes and non-crossing connectors, with normalized positions spaced across the canvas. Do not create decorative, generic or redundant diagrams.\n\nINSTRUCTIONS: Address each set as a group. Do not say that individual Student A completes Set A or Student B completes Set B.\n\nADDITIONAL REQUIREMENTS (higher precedence):\n${additionalPrompt || "None"}\n\nEDITABLE DESIGN PROMPT:\n${designPrompt}\n\nQUESTION COUNT: exactly ${count}.\n\nSOURCE MAP:\n${JSON.stringify(sourceMap)}\n\nCreate an ActivitySpec. Set design.layoutFamily to reference-split when following the default template PowerPoints. Sources must name real files and page/slide locations. Return only JSON.`, config: { abortSignal: job.abort.signal, responseMimeType: "application/json", responseJsonSchema: geminiSchema(activitySpecSchema) } });
      spec = activitySpecSchema.parse(JSON.parse(generation.text ?? "{}"));
      const verify = await ai.models.generateContent({ model, contents: `Verify and, where evidence supports it, correct this ActivitySpec against its source map. Preserve unresolved problems in warnings. Ensure student prompts contain no answers and compiled answers cover every common/A/B task. Enforce one complete debrief slide per question: keep each A/B answer under about 90 words, the common synthesis under 35 words, and prefer compact marking points, short bullets and equations over paragraphs. Never rely on continuation or separate solution slides. Remove visible production metadata and irrelevant display information. Correct every scientific and mathematical symbol, subscript, superscript, charge, state symbol, arrow, unit and degree sign using Unicode or LaTeX-style markup; specifically replace any theta or circled-minus used for E° or a degree symbol. Keep bold markup selective.\n\nAudit sharedPromptMode: task is the default; summary is allowed only when it adds concise orientation, never for a graph/table task, never consecutively, and no more than two times in a five-question activity. Audit A/B parity explicitly: command word, response form, requested outputs, equation/diagram requirements and marking-point workload must match. Repair mismatched pairs using only source-supported content. Enforce SOURCE MAP commandPolicy exactly: use only its listed command terms, honour their definitions, record the leading phrase in commandWord, and give both sets the same command wording. Remove Analyse/Analyze or any other command absent from the policy. Reject decorative visuals. Every graph specification must be necessary, accurate, have one xTickLabel per categorical x value, and correspond to an explicit graph action in the student prompt. Every table task must include meaningful columns and Set-specific row labels. Diagrams must be necessary, readable and simple. Return the complete corrected ActivitySpec only.\nREFERENCE FORMAT ANALYSIS:\n${JSON.stringify(referenceFormats)}\nSOURCE MAP:\n${JSON.stringify(sourceMap)}\nACTIVITY SPEC:\n${JSON.stringify(spec)}`, config: { abortSignal: job.abort.signal, responseMimeType: "application/json", responseJsonSchema: geminiSchema(activitySpecSchema) } });
      spec = activitySpecSchema.parse(JSON.parse(verify.text ?? "{}"));
      let unresolvedGrounding = groundingIssues(spec, sourceFiles);
      let unresolvedPairing = pairingIssues(spec);
      let unresolvedCommands = commandWordIssues(spec, commandPolicy);
      let unresolvedCurriculum = curriculumIssues(spec, curriculumMap);
      if (unresolvedGrounding.length || unresolvedPairing.length || unresolvedCommands.length || unresolvedCurriculum.length) {
        unresolvedPairing = [...unresolvedPairing, ...unresolvedCurriculum.map((issue) => `CURRICULUM ALIGNMENT: ${issue}`)];
        const repair = await ai.models.generateContent({ model, contents: `Repair this ActivitySpec so it is strictly source-locked, every A/B pair has equivalent work, and every question follows the binding commandPolicy. The syllabus may define scope but may not serve as the sole evidence for expected answers. Use only the located evidence in SOURCE MAP files. Remove unsupported elaboration instead of replacing it with general knowledge. If a question pair cannot be fully supported or balanced, replace it with a pair that can. Keep exactly ${count} pairs and preserve the one-debrief-slide-per-question format. Every common, Set A and Set B answer must have its own evidence reference with an exact filename, exact page/slide location and a short faithful supporting quotation or paraphrase in note.\n\nDETERMINISTIC GROUNDING PROBLEMS:\n${unresolvedGrounding.join("\n") || "None"}\n\nDETERMINISTIC PAIRING PROBLEMS:\n${unresolvedPairing.join("\n") || "None"}\n\nDETERMINISTIC COMMAND-WORD PROBLEMS:\n${unresolvedCommands.join("\n") || "None"}\n\nUse only command terms listed in SOURCE MAP commandPolicy and apply each according to its glossary definition. Set A and Set B must use the same leading command phrase and commandWord must record it exactly. For graph pairs with different domains, create audience A and audience B series with independent labels; never force them onto one shared student scaffold. Every table task must provide meaningful columns and Set-specific row labels.\n\nSOURCE MAP:\n${JSON.stringify(sourceMap)}\n\nACTIVITY SPEC:\n${JSON.stringify(spec)}\nReturn the complete corrected ActivitySpec only.`, config: { abortSignal: job.abort.signal, responseMimeType: "application/json", responseJsonSchema: geminiSchema(activitySpecSchema) } });
        spec = activitySpecSchema.parse(JSON.parse(repair.text ?? "{}"));
        unresolvedGrounding = groundingIssues(spec, sourceFiles);
        unresolvedPairing = pairingIssues(spec);
        unresolvedCommands = commandWordIssues(spec, commandPolicy);
        unresolvedCurriculum = curriculumIssues(spec, curriculumMap);
      }
      if (unresolvedCurriculum.length) throw new Error(`The curriculum-alignment audit could not be satisfied: ${unresolvedCurriculum.join(" ")}`);
      if (unresolvedGrounding.length) {
        const warning = `Source-grounding audit retained ${unresolvedGrounding.length} unresolved evidence reference issue(s).`;
        spec.warnings.push(warning);
        job.warnings.push(warning, ...unresolvedGrounding);
      }
      if (unresolvedPairing.length) {
        const warning = `Pairing audit retained ${unresolvedPairing.length} unresolved workload or graph issue(s).`;
        spec.warnings.push(warning);
        job.warnings.push(warning, ...unresolvedPairing);
      }
      if (unresolvedCommands.length) {
        const commandRepair = await ai.models.generateContent({ model, contents: `Correct only the question command wording in this ActivitySpec. Do not alter subject facts, answers, evidence, question count or pair concepts. Use only terms in COMMAND POLICY, follow their definitions, give Set A and Set B the same leading command phrase, set commandWord to that exact phrase, and remove every unlisted command word including Analyse/Analyze.\n\nCOMMAND POLICY:\n${JSON.stringify(commandPolicy)}\n\nISSUES:\n${unresolvedCommands.join("\n")}\n\nACTIVITY SPEC:\n${JSON.stringify(spec)}\nReturn the complete corrected ActivitySpec only.`, config: { abortSignal: job.abort.signal, responseMimeType: "application/json", responseJsonSchema: geminiSchema(activitySpecSchema) } });
        spec = activitySpecSchema.parse(JSON.parse(commandRepair.text ?? "{}"));
        unresolvedCommands = commandWordIssues(spec, commandPolicy);
        if (unresolvedCommands.length) throw new Error(`The syllabus command-word audit could not be satisfied: ${unresolvedCommands.join(" ")}`);
      }
    }
    const actionableWarning = (warning: string) =>
      !/\b(?:does not|do not|did not) affect\b|\bnot applicable to (?:the )?(?:current|selected)\b/i.test(warning)
      && !/^(?:ensure|verify|check|confirm)\b/i.test(warning.trim())
      && !/^(?:differentiate|render|use|label|include)\b/i.test(warning.trim())
      && !/\bas per (?:the )?.*command definition\b/i.test(warning)
      && !/\bshould be\b|\bnot required by (?:the )?syllabus\b/i.test(warning)
      && !/\bE[-\s]?(?:theta|θ|ϴ|ᶿ|⊖)\b/i.test(warning)
      && !/^Grounding is strictly restricted\b|^No general knowledge\b|^All (?:numerical values|facts|formulas|claims)\b/i.test(warning.trim());
    spec.warnings = spec.warnings.filter(actionableWarning);
    for (const question of spec.questions) question.warnings = question.warnings.filter(actionableWarning);
    await writeFile(join(job.dir, "qa-activity-spec.json"), JSON.stringify({ commandPolicy: appliedCommandPolicy, curriculumMap: appliedCurriculumMap, spec }, null, 2));
    assertActive(job); job.warnings.push(...spec.warnings); setStage(job, "Building decks", 76);
    job.artifacts = await renderDecks(spec, job.dir);
    assertActive(job); setStage(job, "Checking slides", 92);
    const verifyDecks = async () => {
      for (const [index, path] of [job.artifacts.setA, job.artifacts.setB, job.artifacts.answers].entries()) {
        if (!path || (await readFile(path)).length < 10_000) throw new Error(`PowerPoint verification failed for ${basename(path ?? "unknown")}.`);
        const renderDir = join(job.dir, `qa-${index}`);
        await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(process.cwd(), "server", "scripts", "render-pptx.ps1"), path, renderDir, String(Math.max(72, Number(process.env.CROP_DPI ?? 150)))], { timeout: 180_000 });
        const rendered = (await readdir(renderDir)).filter((name) => name.toLowerCase().endsWith(".png"));
        const expected = spec.questions.length + 1;
        if (rendered.length !== expected) throw new Error(`${basename(path)} rendered ${rendered.length} slides; expected exactly ${expected}.`);
      }
    };
    try { await verifyDecks(); }
    catch {
      job.warnings.push("Initial PowerPoint render verification failed; the decks were rebuilt once and rechecked.");
      job.artifacts = await renderDecks(spec, job.dir); await verifyDecks();
    }
    job.status = "ready"; setStage(job, "Ready", 100);
  } catch (error) {
    if (job.abort.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) job.status = "cancelled";
    else { job.status = "failed"; job.error = error instanceof Error ? error.message : String(error); }
    for (const send of job.events) send({ status: job.status, stage: job.stage, progress: job.progress, warnings: job.warnings, error: job.error });
  } finally {
    if (cleanupAi) await Promise.allSettled(hostedNames.map((name) => cleanupAi!.files.delete({ name })));
    if (job.status === "cancelled") await job.cleanup?.();
  }
}
