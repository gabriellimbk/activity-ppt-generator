import { z } from "zod";

export const inputKindSchema = z.enum(["material", "syllabus", "reference"]);
export const cloudInputSchema = z.object({
  kind: inputKindSchema,
  path: z.string().min(10).max(700),
  name: z.string().min(1).max(180),
  role: z.string().min(1).max(60),
  size: z.number().int().positive().max(50 * 1024 * 1024),
  mime: z.string().min(3).max(160),
});

export const createCloudJobSchema = z.object({
  id: z.string().uuid(),
  inputs: z.array(cloudInputSchema).min(2).max(54),
  useDefaultReferences: z.boolean().default(true),
  designPrompt: z.string().min(20).max(30_000),
  additionalPrompt: z.string().max(10_000).default(""),
}).superRefine((value, context) => {
  const syllabi = value.inputs.filter((input) => input.kind === "syllabus").length;
  const materials = value.inputs.filter((input) => input.kind === "material").length;
  const references = value.inputs.filter((input) => input.kind === "reference").length;
  if (syllabi !== 1) context.addIssue({ code: "custom", message: "Exactly one syllabus is required." });
  if (materials < 1) context.addIssue({ code: "custom", message: "At least one learning material is required." });
  if (references > 3) context.addIssue({ code: "custom", message: "At most three template PowerPoints are allowed." });
});

export type CloudInput = z.infer<typeof cloudInputSchema>;
export type CreateCloudJob = z.infer<typeof createCloudJobSchema>;
export type CloudArtifact = { path: string; filename: string; mime: string; size: number };
export type CloudArtifacts = Partial<Record<"setA" | "setB" | "answers" | "bundle", CloudArtifact>>;

export type CloudJobRow = {
  id: string;
  user_id: string;
  status: "uploading" | "queued" | "running" | "ready" | "failed" | "cancelled";
  stage: string;
  progress: number;
  warnings: string[];
  error: string | null;
  inputs: CloudInput[];
  artifacts: CloudArtifacts;
  use_default_references: boolean;
  design_prompt: string;
  additional_prompt: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
};
