import { z } from "zod";

export const sourceRefSchema = z.object({ file: z.string(), location: z.string(), note: z.string().optional() });
export const evidenceRefSchema = sourceRefSchema.extend({ note: z.string().min(8) });
export const graphSchema = z.object({
  xLabel: z.string(), yLabel: z.string(),
  xTickLabels: z.array(z.string()).max(8).optional(),
  series: z.array(z.object({
    name: z.string(), audience: z.enum(["A", "B", "both"]).default("both"),
    xLabel: z.string().optional(), yLabel: z.string().optional(),
    xTickLabels: z.array(z.string()).max(8).optional(),
    points: z.array(z.object({ x: z.number(), y: z.number() })).min(2),
  })).max(3),
}).optional();
export const diagramSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(), label: z.string(),
    x: z.preprocess((value) => typeof value === "number" && value > 1 && value <= 100 ? value / 100 : value, z.number().min(0).max(1)).describe("Horizontal position from 0.0 to 1.0"),
    y: z.preprocess((value) => typeof value === "number" && value > 1 && value <= 100 ? value / 100 : value, z.number().min(0).max(1)).describe("Vertical position from 0.0 to 1.0"),
  })).min(2).max(7),
  connectors: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })).max(10),
}).optional();
export const tableSchema = z.object({
  rowHeader: z.string().min(1).max(40).default("Item"),
  columns: z.array(z.string()).min(1).max(4),
  setARowLabels: z.array(z.string()).min(1).max(6),
  setBRowLabels: z.array(z.string()).min(1).max(6),
  setAInputRows: z.array(z.array(z.string().max(180)).min(1).max(4)).max(6).default([]),
  setBInputRows: z.array(z.array(z.string().max(180)).min(1).max(4)).max(6).default([]),
  setAAnswerRows: z.array(z.array(z.string().max(180)).min(1).max(4)).min(1).max(6),
  setBAnswerRows: z.array(z.array(z.string().max(180)).min(1).max(4)).min(1).max(6),
}).optional();
export const questionTaskSchema = z.object({
  prompt: z.string().min(3).max(420),
  answer: z.string().min(1).max(700),
  commandWord: z.string().default("Explain"),
});
export const questionSchema = z.object({
  number: z.number().int().min(1), curriculumTargetId: z.string().min(1), concept: z.string(), pairingMethod: z.string(),
  responseType: z.enum(["text", "graph", "table", "diagram"]),
  sharedPromptMode: z.enum(["context", "summary"]).default("context"),
  sharedStimulusRequired: z.boolean().default(false),
  sharedPrompt: z.string(),
  setATasks: z.array(questionTaskSchema).min(1).max(2),
  setBTasks: z.array(questionTaskSchema).min(1).max(2),
  commonAnswer: z.string().max(360),
  difficulty: z.enum(["introductory", "standard", "challenging"]).default("standard"),
  expectedMinutes: z.number().min(1).max(30).default(4),
  sources: z.array(sourceRefSchema).min(1),
  evidence: z.object({
    common: z.array(evidenceRefSchema).min(1),
    setA: z.array(evidenceRefSchema).min(1),
    setB: z.array(evidenceRefSchema).min(1),
  }),
  warnings: z.array(z.string()).default([]), graph: graphSchema,
  diagram: diagramSchema, table: tableSchema,
});
export const activitySpecSchema = z.object({
  topic: z.string(), audience: z.string().default("Students"),
  instructions: z.array(z.string()).min(2),
  design: z.object({
    primary: z.string().regex(/^#[0-9A-Fa-f]{6}$/), secondary: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/), background: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    headingFont: z.string(), bodyFont: z.string(),
    layoutFamily: z.enum(["reference-split", "clean-academic", "modern"]).default("reference-split"),
    promptHighlight: z.boolean().default(true),
  }),
  questions: z.array(questionSchema).min(3).max(8), warnings: z.array(z.string()).default([]),
});
export type ActivitySpec = z.infer<typeof activitySpecSchema>;

export type Stage = "Preparing files" | "Analysing syllabus" | "Mapping content" | "Creating paired questions" | "Building decks" | "Checking slides" | "Ready";
export type JobStatus = "queued" | "running" | "ready" | "failed" | "cancelled";
export type Job = {
  id: string; userId: string; dir: string; status: JobStatus; stage: Stage; progress: number;
  warnings: string[]; error?: string; createdAt: number; abort: AbortController;
  artifacts: Partial<Record<"setA" | "setB" | "answers" | "bundle", string>>;
  events: Set<(payload: object) => void>;
  cleanup?: () => Promise<void>;
  onProgress?: (payload: { status: JobStatus; stage: Stage; progress: number; warnings: string[]; error?: string }) => void | Promise<void>;
};
