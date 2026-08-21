import { describe, expect, it } from "vitest";
import { activitySpecSchema } from "../server/types.js";
import { commandWordIssues, resolveCommandPolicy } from "../server/commands.js";

const source = { file: "Lecture.pdf", location: "page 2", note: "Direct source wording for the expected answer." };
const base = {
  topic: "Periodicity", audience: "Students",
  instructions: ["Work in groups.", "Use one lifeline."],
  design: { primary: "#000000", secondary: "#000000", accent: "#FFF200", background: "#FFFFFF", headingFont: "Arial", bodyFont: "Arial" },
  questions: Array.from({ length: 3 }, (_, index) => ({
    number: index + 1, curriculumTargetId: "atomic-radius", concept: "Atomic radius", pairingMethod: "complementary examples", responseType: "text" as const,
    sharedPromptMode: "summary" as const, sharedPrompt: "Atomic size changes periodically.",
    setATasks: [{ prompt: "Explain the trend across Period 3.", answer: "Supported A answer.", commandWord: "Explain" }],
    setBTasks: [{ prompt: "Explain the trend down Group 2.", answer: "Supported B answer.", commandWord: "Explain" }],
    commonAnswer: "Both concern atomic size.",
    sources: [source], evidence: { common: [source], setA: [source], setB: [source] }, warnings: [],
  })), warnings: [],
};

describe("syllabus command-word policy", () => {
  it("uses an explicit syllabus glossary instead of the fallback list", () => {
    const policy = resolveCommandPolicy([{ term: "Explain", definition: "Give reasons why.", location: "page 46" }]);
    expect(policy.source).toBe("syllabus-glossary");
    expect(policy.entries).toHaveLength(1);
  });

  it("rejects Analyse when it is absent from the syllabus glossary", () => {
    const policy = resolveCommandPolicy([{ term: "Explain", definition: "Give reasons why.", location: "page 46" }]);
    const spec = activitySpecSchema.parse(base);
    spec.questions[0].setATasks[0].commandWord = "Analyse";
    spec.questions[0].setBTasks[0].commandWord = "Analyse";
    spec.questions[0].setATasks[0].prompt = "Analyse the Period 3 trend.";
    spec.questions[0].setBTasks[0].prompt = "Analyse the Group 2 trend.";
    expect(commandWordIssues(spec, policy).join(" ")).toMatch(/Analyse|analyse/i);
  });

  it("requires the same allowed command wording in Set A and Set B", () => {
    const policy = resolveCommandPolicy([
      { term: "Explain", definition: "Give reasons why.", location: "page 46" },
      { term: "Predict", definition: "Give an expected outcome.", location: "page 46" },
    ]);
    const spec = activitySpecSchema.parse(base);
    spec.questions[0].setBTasks[0].prompt = "Predict the trend down Group 2.";
    expect(commandWordIssues(spec, policy).join(" ")).toContain("do not use the same allowed command words");
  });

  it("rejects an unlisted multi-word command phrase", () => {
    const policy = resolveCommandPolicy([{ term: "Explain", definition: "Give reasons why.", location: "page 44" }]);
    const spec = activitySpecSchema.parse(base);
    spec.questions[0].sharedPromptMode = "task";
    spec.questions[0].sharedPrompt = "Account for the trend in atomic radius.";
    expect(commandWordIssues(spec, policy).join(" ")).toContain("account for");
  });
});
