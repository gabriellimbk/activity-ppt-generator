import { describe, expect, it } from "vitest";
import { curriculumIssues, type CurriculumMap } from "../server/pipeline.js";
import { activitySpecSchema } from "../server/types.js";

const source = { file: "Lecture.pdf", location: "slide 3", note: "Atomic radius decreases across Period 3." };
const curriculumMap: CurriculumMap = {
  topic: "Periodicity", globalExclusions: [], targets: [{
    id: "radius-period-3", syllabusOutcome: "Describe and explain the trend in atomic radius across a period.", syllabusLocation: "page 16",
    lectureEvidence: [{ file: "Lecture.pdf", location: "slide 3", wording: "Atomic radius decreases across Period 3." }],
    taskAnchors: [{ file: "Tutorial.pdf", location: "page 2", wording: "Explain the trend in atomic radius across Period 3.", kind: "tutorial-question" }],
    permittedCommands: ["Explain"], permittedResponseTypes: ["text"], exclusions: ["Do not ask for a definition of periodicity."],
  }],
};

const spec = activitySpecSchema.parse({
  topic: "Periodicity", audience: "Students", instructions: ["Work in groups.", "Use one lifeline."],
  design: { primary: "#000000", secondary: "#000000", accent: "#FFF200", background: "#FFFFFF", headingFont: "Arial", bodyFont: "Arial" },
  questions: Array.from({ length: 3 }, (_, index) => ({
    number: index + 1, curriculumTargetId: "radius-period-3", concept: "Atomic radius", pairingMethod: "shared anchor", responseType: "text",
    sharedPromptMode: "summary", sharedPrompt: "Atomic radius across Period 3.",
    setATasks: [{ prompt: "Explain the trend in atomic radius across Period 3.", answer: "Atomic radius decreases.", commandWord: "Explain" }],
    setBTasks: [{ prompt: "Explain the trend in atomic radius across Period 3.", answer: "Atomic radius decreases.", commandWord: "Explain" }],
    commonAnswer: "Atomic radius decreases.", sources: [source], evidence: { common: [source], setA: [source], setB: [source] }, warnings: [],
  })), warnings: [],
});

describe("curriculum alignment audit", () => {
  it("accepts a question locked to an eligible target", () => expect(curriculumIssues(spec, curriculumMap)).toEqual([]));
  it("rejects invented numbers and response forms", () => {
    const changed = structuredClone(spec);
    changed.questions[0].responseType = "graph";
    changed.questions[0].setATasks[0].prompt = "Explain the trend for a 5.0 g sample.";
    expect(curriculumIssues(changed, curriculumMap).join(" ")).toMatch(/not an allowed response|5.0 g/);
  });
});
