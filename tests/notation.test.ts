import { describe, expect, it } from "vitest";
import { plainScienceText, scienceRuns, unicodeScienceText } from "../server/notation.js";

describe("scientific notation", () => {
  it("converts LaTeX and Unicode scripts into editable rich-text runs", () => {
    const runs = scienceRuns("MgCO3(s) → MgO(s) + CO₂(g); SO_4^{2-}; x^2; Eθ");
    expect(plainScienceText("MgCO3 + SO_4^{2-} + Eθ + E⌀ + E\\ominus + E^{\\circ}")).toBe("MgCO3 + SO42- + E° + E° + E° + E°");
    expect(runs.some((run) => run.options.subscript && run.text.includes("3"))).toBe(true);
    expect(runs.some((run) => run.options.superscript && run.text.includes("2-"))).toBe(true);
    expect(runs.map((run) => run.text).join("")).toContain("E°");
  });

  it("keeps selective bold separate from scripts", () => {
    const runs = scienceRuns("**Explain** why Cl_2 reacts with Br^-.");
    expect(runs.some((run) => run.options.bold && run.text.includes("Explain"))).toBe(true);
    expect(runs.some((run) => run.options.subscript && run.text === "2")).toBe(true);
    expect(runs.some((run) => run.options.superscript && run.text === "-")).toBe(true);
  });

  it("repairs common custom-font extraction artifacts for ionic charges", () => {
    expect(plainScienceText('Fe"+ and Fe#+')).toBe("Fe2+ and Fe3+");
  });

  it("normalizes standard potentials and impossible alkaline-earth anion artifacts", () => {
    expect(plainScienceText("E⊖cell; E^⊖; E^{⊖}; Mg2- ion; Ca2- cation; M2- cation; Cl-(aq)")).toBe("E°cell; E°; E°; Mg2+ ion; Ca2+ cation; M2+ cation; Cl-(aq)");
    const runs = scienceRuns("E⊖cell; Cl-(aq)");
    expect(runs.some((run) => run.options.subscript && run.text === "cell")).toBe(true);
    expect(runs.some((run) => run.options.superscript && run.text === "-")).toBe(true);
  });

  it("bolds only the requested command word", () => {
    const runs = scienceRuns("Compare the two trends.", { boldFirstWords: 1 });
    expect(runs[0]).toMatchObject({ text: "Compare", options: { bold: true } });
    expect(runs[1].options.bold).toBe(false);
  });

  it("creates Unicode science notation for table cells", () => {
    expect(unicodeScienceText("MgCl_{2}; CO_3^{2-}; Na^{+}")).toBe("MgCl₂; CO₃²⁻; Na⁺");
    expect(unicodeScienceText("CO3 2- anion; kJ mol-1")).toBe("CO₃²⁻ anion; kJ mol⁻¹");
  });
});
