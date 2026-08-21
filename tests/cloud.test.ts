import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudJobSchema } from "../server/cloud/contracts.js";
import { normalize } from "../server/pipeline.js";
import { readJsonBody } from "../server/cloud/http.js";
import type { VercelRequest } from "@vercel/node";
import { Readable } from "node:stream";

const jobId = "11111111-1111-4111-8111-111111111111";
const input = (kind: "material" | "syllabus" | "reference", name: string) => ({
  kind,
  path: `22222222-2222-4222-8222-222222222222/${jobId}/${kind}/${name}`,
  name,
  role: kind === "syllabus" ? "Syllabus" : "Lecture",
  size: 1024,
  mime: kind === "syllabus" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation",
});

describe("serverless job contract", () => {
  it("accepts one syllabus, teaching material, and up to three template decks", () => {
    const parsed = createCloudJobSchema.parse({
      id: jobId,
      inputs: [input("syllabus", "syllabus.pdf"), input("material", "lecture.pptx"), input("reference", "template.pptx")],
      designPrompt: "Create a source-grounded paired classroom activity.",
      additionalPrompt: "",
      useDefaultReferences: false,
    });
    expect(parsed.inputs).toHaveLength(3);
  });

  it("rejects missing or duplicate syllabi and oversized files", () => {
    const base = { id: jobId, designPrompt: "Create a source-grounded paired classroom activity.", additionalPrompt: "" };
    expect(() => createCloudJobSchema.parse({ ...base, inputs: [input("material", "lecture.pptx"), input("material", "tutorial.pptx")] })).toThrow(/syllabus/i);
    expect(() => createCloudJobSchema.parse({ ...base, inputs: [input("syllabus", "one.pdf"), input("syllabus", "two.pdf"), input("material", "lecture.pptx")] })).toThrow(/syllabus/i);
    expect(() => createCloudJobSchema.parse({ ...base, inputs: [{ ...input("syllabus", "one.pdf"), size: 50 * 1024 * 1024 + 1 }, input("material", "lecture.pptx")] })).toThrow();
  });
});

describe("Vercel request-body compatibility", () => {
  it("accepts parsed JSON, text, Buffer, and raw request streams", async () => {
    const payload = { id: jobId, value: "ok" };
    for (const body of [payload, JSON.stringify(payload), Buffer.from(JSON.stringify(payload))]) {
      expect(await readJsonBody({ body } as VercelRequest)).toEqual(payload);
    }
    const stream = Readable.from([Buffer.from(JSON.stringify(payload))]) as VercelRequest;
    Object.defineProperty(stream, "body", { value: undefined });
    expect(await readJsonBody(stream)).toEqual(payload);
  });

  it("reports an actionable error for an empty body", async () => {
    const stream = Readable.from([]) as VercelRequest;
    Object.defineProperty(stream, "body", { value: undefined });
    await expect(readJsonBody(stream)).rejects.toThrow(/body is empty/i);
  });
});

describe("serverless Office fallback", () => {
  const previous = process.env.SERVERLESS_MODE;
  afterEach(() => { if (previous === undefined) delete process.env.SERVERLESS_MODE; else process.env.SERVERLESS_MODE = previous; });

  it("extracts editable PPTX text without Windows Office automation", async () => {
    process.env.SERVERLESS_MODE = "1";
    const dir = await mkdtemp(join(tmpdir(), "activity-cloud-normalize-"));
    try {
      const result = await normalize({
        path: join(process.cwd(), "assets", "templates", "Set A.pptx"),
        originalname: "Set A.pptx",
        role: "Reference format",
      }, dir);
      expect(result.mime).toBe("text/plain");
      expect(result.pages).toBeGreaterThan(0);
      expect(result.warning).toMatch(/Office conversion is unavailable/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
