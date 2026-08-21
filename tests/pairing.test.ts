import { describe, expect, it } from "vitest";
import { tableSolvabilityIssues, variationCoverageIssues } from "../server/pipeline.js";
import { activitySpecSchema, type ActivitySpec } from "../server/types.js";

const makeSpec = (count = 5): ActivitySpec => activitySpecSchema.parse({
  topic: "Test activity",
  audience: "Students",
  instructions: ["Work in groups.", "Answer every question."],
  design: {
    primary: "#173F35", secondary: "#79A899", accent: "#D38B2C", background: "#FFFFFF",
    headingFont: "Arial", bodyFont: "Arial",
  },
  questions: Array.from({ length: count }, (_, index) => {
    const evidence = { file: "Lecture.pdf", location: `page ${index + 1}`, note: "Direct source evidence for the expected response." };
    const task = { prompt: `Describe the taught example for concept ${index + 1}.`, answer: "Source-supported response.", commandWord: "Describe" };
    return {
      number: index + 1,
      curriculumTargetId: `target-${index + 1}`,
      concept: `Concept ${index + 1}`,
      pairingMethod: "shared anchor",
      responseType: "text",
      sharedPromptMode: "context",
      sharedStimulusRequired: false,
      sharedPrompt: "",
      setATasks: [task],
      setBTasks: [task],
      commonAnswer: "",
      sources: [evidence],
      evidence: { common: [evidence], setA: [evidence], setB: [evidence] },
      warnings: [],
    };
  }),
  warnings: [],
});

describe("paired activity structural validation", () => {
  it("requires at least 40% of numbered questions to use genuinely different A/B tasks", () => {
    const replica = makeSpec(5);
    expect(variationCoverageIssues(replica)).toEqual([
      expect.stringContaining("at least 2 of 5 (40%)"),
    ]);

    replica.questions[3].setBTasks[0].prompt = "Describe the contrasting source-supported case for concept 4.";
    replica.questions[4].setBTasks[0].prompt = "Describe the alternative source-supported example for concept 5.";
    expect(variationCoverageIssues(replica)).toEqual([]);
  });

  it("rejects a table deduction that omits the observations students need", () => {
    const spec = makeSpec(3);
    spec.questions[0] = activitySpecSchema.shape.questions.element.parse({
      ...spec.questions[0],
      responseType: "table",
      setATasks: [{ prompt: "Deduce the identity of Sample A from the observations provided in the table.", answer: "Sample A is chloride.", commandWord: "Deduce" }],
      setBTasks: [{ prompt: "Deduce the identity of Sample B from the observations provided in the table.", answer: "Sample B is bromide.", commandWord: "Deduce" }],
      table: {
        rowHeader: "Sample",
        columns: ["Observation", "Identity"],
        setARowLabels: ["Sample A"],
        setBRowLabels: ["Sample B"],
        setAAnswerRows: [["white precipitate", "chloride"]],
        setBAnswerRows: [["cream precipitate", "bromide"]],
      },
    });
    expect(tableSolvabilityIssues(spec)).toEqual([
      expect.stringContaining("Set A: the task depends on supplied table data"),
      expect.stringContaining("Set B: the task depends on supplied table data"),
    ]);

    spec.questions[0].table!.setAInputRows = [["white precipitate", ""]];
    spec.questions[0].table!.setBInputRows = [["cream precipitate", ""]];
    expect(tableSolvabilityIssues(spec)).toEqual([]);
  });
});
