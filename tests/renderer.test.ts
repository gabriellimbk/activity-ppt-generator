import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import JSZip from "jszip";
import { renderDecks } from "../server/pptx.js";
import { activitySpecSchema } from "../server/types.js";

describe("editable PowerPoint renderer", () => {
  it("deduplicates shared subquestions in the compiled answer slide", async () => {
    const dir = await mkdtemp(join(tmpdir(), "activity-renderer-"));
    const questions = Array.from({ length: 3 }, (_, i) => {
      const source = { file: "Lecture.pdf", location: `page ${i + 1}`, note: `Direct evidence for concept ${i + 1}.` };
      const shared = i === 1
        ? { prompt: "Sketch the shared trend on the graph.", answer: "This unasked causal explanation must not be displayed.", commandWord: "Sketch" }
        : { prompt: "Explain the shared trend.", answer: "One shared evidence-based answer.", commandWord: "Explain" };
      return {
        number: i + 1, curriculumTargetId: `target-${i + 1}`, concept: `Concept ${i + 1}`, pairingMethod: "complementary examples", responseType: i === 1 ? "graph" as const : i === 2 ? "table" as const : "text" as const,
        sharedPromptMode: "context" as const, sharedPrompt: "The supplied examples use the same core principle.",
        setATasks: i === 0 ? [shared, { prompt: "Describe the Set A example.", answer: "Set A evidence-based answer.", commandWord: "Describe" }] : i === 2 ? [{ prompt: "Complete the table for substance A.", answer: "Completed table shown.", commandWord: "Complete" }] : [shared],
        setBTasks: i === 0 ? [shared, { prompt: "Describe the Set B example.", answer: "Set B evidence-based answer.", commandWord: "Describe" }] : i === 2 ? [{ prompt: "Complete the table for substance B.", answer: "Completed table shown.", commandWord: "Complete" }] : [shared],
        commonAnswer: "Shared principle", difficulty: "standard" as const, expectedMinutes: 4,
        sources: [source], evidence: { common: [source], setA: [source], setB: [source] }, warnings: [],
        graph: i === 1 ? { xLabel: "Input", yLabel: "Radius / nm", series: [{ name: "Trend", xTickLabels: ["A", "B"], points: [{ x: 0, y: 0.1 }, { x: 1, y: 0.12 }] }] } : undefined,
        table: i === 2 ? { rowHeader: "Substance", columns: ["Bonding", "Structure"], setARowLabels: ["A"], setBRowLabels: ["B"], setAAnswerRows: [["ionic", "giant lattice"]], setBAnswerRows: [["covalent", "simple molecular"]] } : undefined,
      };
    });
    const spec = activitySpecSchema.parse({
      topic: "Atomic Structure", audience: "Secondary students", instructions: ["Work in groups.", "Use one teacher lifeline."],
      design: { primary: "#173F35", secondary: "#79A899", accent: "#D38B2C", background: "#F5F2E9", headingFont: "Aptos Display", bodyFont: "Aptos" },
      questions, warnings: [],
    });
    try {
      const paths = await renderDecks(spec, dir);
      for (const key of ["setA", "setB", "answers"] as const) expect((await readFile(paths[key])).length).toBeGreaterThan(10_000);
      const bundle = await JSZip.loadAsync(await readFile(paths.bundle)); expect(Object.keys(bundle.files)).toHaveLength(3);
      const answers = await JSZip.loadAsync(await readFile(paths.answers));
      const notesXml = await answers.file("ppt/notesSlides/notesSlide2.xml")?.async("string");
      expect(notesXml).toContain("[Sources]"); expect(notesXml).toContain("Lecture.pdf");
      const answerSlides = (await Promise.all(Object.keys(answers.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map((name) => answers.file(name)!.async("string")))).join(" ");
      expect(Object.keys(answers.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(4);
      expect(answerSlides).not.toMatch(/Answer continued|Shared explanation|Solution graph/);
      const threeAnswerSlide = await answers.file("ppt/slides/slide2.xml")!.async("string");
      expect(threeAnswerSlide.match(/the shared trend\./g)).toHaveLength(1);
      expect(threeAnswerSlide.match(/One shared evidence/g)).toHaveLength(1);
      expect(threeAnswerSlide).toContain("Set A example");
      expect(threeAnswerSlide).toContain("Set B example");
      expect(threeAnswerSlide.match(/\[A\+B\]/g)).toHaveLength(1);
      const graphAnswerSlide = await answers.file("ppt/slides/slide3.xml")!.async("string");
      expect(graphAnswerSlide).toContain(">Sketch<");
      expect(graphAnswerSlide).toContain("the shared trend on the graph");
      expect(graphAnswerSlide).not.toContain("unasked causal explanation");
      const tableAnswerSlide = await answers.file("ppt/slides/slide4.xml")!.async("string");
      expect(tableAnswerSlide).toContain("giant lattice");
      expect(tableAnswerSlide).toContain("simple molecular");
      const studentA = await JSZip.loadAsync(await readFile(paths.setA));
      const studentASlide = await studentA.file("ppt/slides/slide2.xml")!.async("string");
      expect(studentASlide).toContain("the shared trend");
      expect(studentASlide).toContain("Set A example");
      expect(studentASlide).not.toContain("Set B example");
      expect(studentASlide).not.toContain("The supplied examples use the same core principle");
      expect(studentASlide).not.toContain("CONTEXT");
      expect(studentASlide).not.toContain("evidence-based answer");
      const studentATableSlide = await studentA.file("ppt/slides/slide4.xml")!.async("string");
      expect(studentATableSlide).toContain(">Complete<");
      expect(studentATableSlide).toContain("the table for substance A");
      expect(studentATableSlide).not.toContain("giant lattice");
      if (process.platform === "win32") {
        for (const [name, path] of [["qa-a", paths.setA], ["qa-answers", paths.answers]] as const) {
          const qa = join(dir, name);
          await promisify(execFile)("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(process.cwd(), "server", "scripts", "render-pptx.ps1"), path, qa, "96"], { timeout: 120_000 });
          expect((await readdir(qa)).filter((file) => file.endsWith(".PNG"))).toHaveLength(4);
        }
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);
});
