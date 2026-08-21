import { basename, join } from "node:path";
import PptxGenJSImport from "pptxgenjs";
import JSZip from "jszip";
import { readFile, writeFile } from "node:fs/promises";
import type { ActivitySpec } from "./types.js";
import { plainScienceText, scienceRuns, unicodeScienceText } from "./notation.js";

// PptxGenJS 4's declaration is interpreted as a module namespace under NodeNext,
// while its ESM runtime default export is the presentation constructor.
const PptxGenJS = PptxGenJSImport as unknown as new () => any;

const clean = (hex: string) => hex.replace("#", "").toUpperCase();
const safeTopic = (topic: string) => plainScienceText(topic).replace(/[<>:"/\\|?*\x00-\x1F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 70) || "Collaborative_Activity";
const notes = (sources: { file: string; location: string; note?: string }[], warnings: string[], metadata?: string) =>
  `[Sources]\n${sources.map((s) => `- ${s.file} — ${s.location}${s.note ? ` (${s.note})` : ""}`).join("\n") || "- No source reference supplied"}\n\n[Warnings]\n${warnings.map((w) => `- ${w}`).join("\n") || "- None"}${metadata ? `\n\n[Activity metadata]\n${metadata}` : ""}`;

type Region = { x: number; y: number; w: number; h: number };

function makeDeck(spec: ActivitySpec, mode: "A" | "B" | "answers") {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Collaborative Activity Generator";
  pptx.subject = plainScienceText(spec.topic);
  pptx.title = mode === "answers" ? `${plainScienceText(spec.topic)} — Compiled answers` : `${plainScienceText(spec.topic)} — Set ${mode}`;
  pptx.lang = "en-SG";
  pptx.theme = { headFontFace: spec.design.headingFont, bodyFontFace: spec.design.bodyFont, lang: "en-SG" };
  const reference = spec.design.layoutFamily === "reference-split";
  const c = {
    bg: reference ? "FFFFFF" : clean(spec.design.background),
    ink: reference ? "000000" : clean(spec.design.primary),
    muted: reference ? "303030" : "586760",
    line: reference ? "111111" : clean(spec.design.secondary),
    highlight: reference ? "FFF200" : clean(spec.design.accent),
    answerLine: reference ? "C00000" : clean(spec.design.primary),
    white: "FFFFFF",
  };

  const addRich = (slide: any, value: string, box: Record<string, unknown>, rich: { bold?: boolean; boldFirstWords?: number } = {}) =>
    slide.addText(scienceRuns(value, rich), { fontFace: spec.design.bodyFont, color: c.ink, margin: 0, breakLine: false, ...box });
  const addWrappingScienceText = (slide: any, value: string, box: Record<string, unknown>) =>
    slide.addText(unicodeScienceText(value).replace(/(?<=\p{L})-(?=\p{L})/gu, "‑"), { fontFace: spec.design.bodyFont, color: c.ink, margin: 0, breakLine: false, ...box });
  const addDashedDivider = (slide: any, x: number, y = 0.75, h = 6.35) =>
    slide.addShape(pptx.ShapeType.line, { x, y, w: 0, h, line: { color: c.line, width: 1.4, dashType: "lgDash" } });
  const addQuestionTag = (slide: any, q: number, answer = false) =>
    slide.addText(`[Q${q}${answer ? " Ans" : ""}]`, { x: 10.75, y: 0.18, w: 2.05, h: 0.46, fontFace: spec.design.headingFont, fontSize: answer ? 24 : 26, bold: true, align: "right", valign: "mid", color: c.ink, margin: 0, fit: "shrink" });
  const questionNotes = (q: ActivitySpec["questions"][number]) => {
    const evidenceSources = [...q.evidence.common, ...q.evidence.setA, ...q.evidence.setB];
    const uniqueSources = [...q.sources, ...evidenceSources].filter((source, index, all) => all.findIndex((candidate) => candidate.file === source.file && candidate.location === source.location && candidate.note === source.note) === index);
    return notes(uniqueSources, q.warnings, `${q.expectedMinutes} minutes; ${q.difficulty}; pairing method: ${q.pairingMethod}; shared panel: ${q.sharedPromptMode}`);
  };

  const instructionSlide = pptx.addSlide();
  instructionSlide.background = { color: c.bg };
  instructionSlide.addText("Instructions", { x: 3.45, y: 0.78, w: 6.45, h: 0.72, fontFace: spec.design.headingFont, fontSize: 42, bold: true, align: "center", color: c.ink, margin: 0 });
  const instructions = [
    "Work within your group to answer as many questions as you can, correctly, within the time limit.",
    "Online materials and lecture notes are not allowed.",
    "Each group has one true/false teacher lifeline.",
  ];
  instructions.forEach((text, index) => {
    instructionSlide.addShape(index === 2 ? pptx.ShapeType.heart : pptx.ShapeType.ellipse, { x: 2.85, y: 2.05 + index * 1.02, w: index === 2 ? 0.43 : 0.34, h: index === 2 ? 0.43 : 0.34, fill: { color: index === 2 ? "FF1A1A" : c.ink }, line: { color: c.ink, width: 1 } });
    addRich(instructionSlide, text, { x: 3.72, y: 1.94 + index * 1.02, w: 6.85, h: 0.62, fontSize: 20, color: c.ink, valign: "mid" });
  });
  instructionSlide.addNotes(notes([], spec.warnings));

  const drawBlankGraph = (slide: any, q: ActivitySpec["questions"][number], audience: "A" | "B", region: Region) => {
    const left = region.x + 0.72, top = region.y + 0.22, bottom = region.y + region.h - 0.67, right = region.x + region.w - 0.18;
    const series = q.graph?.series.find((item) => item.audience === audience) ?? q.graph?.series.find((item) => item.audience === "both") ?? q.graph?.series[0];
    const values = series?.points.map((point) => point.x) ?? [];
    const labels = series?.xTickLabels ?? q.graph?.xTickLabels ?? values.map(String);
    const minX = Math.min(...values), maxX = Math.max(...values);
    for (let i = 1; i <= 4; i++) {
      const y = bottom - ((bottom - top) * i) / 5;
      slide.addShape(pptx.ShapeType.line, { x: left, y, w: right - left, h: 0, line: { color: "D9D9D9", width: 0.65 } });
      slide.addShape(pptx.ShapeType.line, { x: left - 0.08, y, w: 0.08, h: 0, line: { color: c.ink, width: 1 } });
    }
    slide.addShape(pptx.ShapeType.line, { x: left, y: top, w: 0, h: bottom - top, line: { color: c.ink, width: 1.5 } });
    slide.addShape(pptx.ShapeType.line, { x: left, y: bottom, w: right - left, h: 0, line: { color: c.ink, width: 1.5 } });
    labels.forEach((label, index) => {
      const value = values[index] ?? index;
      const x = values.length > 1 ? left + ((value - minX) / (maxX - minX || 1)) * (right - left) : (left + right) / 2;
      slide.addShape(pptx.ShapeType.line, { x, y: bottom, w: 0, h: 0.1, line: { color: c.ink, width: 1 } });
      const dense = labels.length >= 6, labelW = dense ? 0.54 : 0.7;
      addRich(slide, label, { x: x - labelW / 2, y: bottom + 0.13, w: labelW, h: 0.25, fontSize: dense ? 8.5 : 10.5, align: "center", color: c.ink, fit: "shrink" });
    });
    addRich(slide, series?.yLabel ?? q.graph?.yLabel ?? "Response", { x: region.x - 0.65, y: top + (bottom - top) / 2 - 0.18, w: 1.7, h: 0.35, fontSize: 12.5, align: "center", color: c.ink, rotate: 270, fit: "shrink" });
    addRich(slide, series?.xLabel ?? q.graph?.xLabel ?? "Input", { x: left + 0.55, y: bottom + 0.39, w: Math.max(2, right - left - 1.1), h: 0.26, fontSize: 13, align: "center", color: c.ink });
  };

  const drawSolutionGraphSeries = (slide: any, q: ActivitySpec["questions"][number], seriesList: NonNullable<ActivitySpec["questions"][number]["graph"]>["series"], region: Region, panelLabel?: string) => {
    if (!q.graph || !seriesList.length) return;
    const all = seriesList.flatMap((series) => series.points); const xs = all.map((point) => point.x), ys = all.map((point) => point.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), rawMinY = Math.min(...ys), rawMaxY = Math.max(...ys);
    const yRange = rawMaxY - rawMinY, yMagnitude = Math.max(Math.abs(rawMinY), Math.abs(rawMaxY));
    const pad = Math.max(yRange * 0.08, yMagnitude * 0.025, 0.001);
    const minY = rawMinY >= 0 && rawMinY - pad < 0 ? 0 : rawMinY - pad, maxY = rawMaxY + pad;
    const gx = region.x + 0.65, gy = region.y + 0.48, gw = region.w - 0.9, gh = region.h - 1.03;
    if (panelLabel) slide.addText(`[${panelLabel}]`, { x: region.x + 0.02, y: region.y, w: 0.5, h: 0.32, fontFace: spec.design.headingFont, fontSize: 15, bold: true, color: c.ink, margin: 0 });
    for (let i = 1; i <= 4; i++) {
      const fraction = i / 5, y = gy + gh - gh * fraction, value = minY + (maxY - minY) * fraction;
      slide.addShape(pptx.ShapeType.line, { x: gx, y, w: gw, h: 0, line: { color: "D9D9D9", width: 0.6 } });
      const tickLabel = Math.abs(value) >= 100 ? String(Math.round(value)) : Number.isInteger(value) ? String(value) : Number(value.toPrecision(3)).toString();
      slide.addText(tickLabel, { x: gx - 0.62, y: y - 0.11, w: 0.5, h: 0.22, fontFace: spec.design.bodyFont, fontSize: 8.5, align: "right", color: c.muted, margin: 0 });
    }
    slide.addShape(pptx.ShapeType.line, { x: gx, y: gy, w: 0, h: gh, line: { color: c.ink, width: 1.4, endArrowType: "triangle" } });
    slide.addShape(pptx.ShapeType.line, { x: gx, y: gy + gh, w: gw, h: 0, line: { color: c.ink, width: 1.4, endArrowType: "triangle" } });
    const first = seriesList[0];
    if (panelLabel) addRich(slide, first.yLabel ?? q.graph.yLabel, { x: region.x + 0.5, y: region.y + 0.02, w: Math.max(1.1, region.w - 0.6), h: 0.22, fontSize: 7.5, align: "center", color: c.muted, fit: "shrink" });
    else addRich(slide, first.yLabel ?? q.graph.yLabel, { x: region.x - 0.66, y: gy + gh / 2 - 0.17, w: 1.65, h: 0.34, fontSize: 11.5, align: "center", color: c.ink, rotate: 270, fit: "shrink" });
    addRich(slide, first.xLabel ?? q.graph.xLabel, { x: gx + 0.45, y: gy + gh + 0.25, w: Math.max(1.4, gw - 0.75), h: 0.25, fontSize: panelLabel ? 10 : 13, align: "center", color: c.ink, fit: "shrink" });
    const palette = [c.answerLine, clean(spec.design.secondary), clean(spec.design.accent)];
    seriesList.forEach((series, seriesIndex) => {
      const plotted = series.points.map((point) => ({ x: gx + ((point.x - minX) / (maxX - minX || 1)) * (gw - 0.18), y: gy + gh - ((point.y - minY) / (maxY - minY || 1)) * (gh - 0.15) }));
      plotted.slice(1).forEach((point, index) => { const prior = plotted[index]; const dx = point.x - prior.x, dy = point.y - prior.y; slide.addShape(pptx.ShapeType.line, { x: Math.min(prior.x, point.x), y: Math.min(prior.y, point.y), w: Math.max(0.001, Math.abs(dx)), h: Math.max(0.001, Math.abs(dy)), flipV: dx * dy < 0, line: { color: palette[seriesIndex], width: 2.2 } }); });
      plotted.forEach((point) => slide.addShape(pptx.ShapeType.ellipse, { x: point.x - 0.045, y: point.y - 0.045, w: 0.09, h: 0.09, fill: { color: palette[seriesIndex] }, line: { color: palette[seriesIndex] } }));
    });
    const tickValues = first?.points.map((point) => point.x) ?? [];
    tickValues.forEach((value, index) => { const x = gx + ((value - minX) / (maxX - minX || 1)) * (gw - 0.18); slide.addShape(pptx.ShapeType.line, { x, y: gy + gh, w: 0, h: 0.12, line: { color: c.ink, width: 1 } }); slide.addText(first?.xTickLabels?.[index] ?? q.graph?.xTickLabels?.[index] ?? String(value), { x: x - 0.38, y: gy + gh + 0.12, w: 0.76, h: 0.2, fontFace: spec.design.bodyFont, fontSize: panelLabel ? 7.5 : 9, align: "center", color: c.ink, margin: 0, fit: "shrink" }); });
  };

  const drawSolutionGraph = (slide: any, q: ActivitySpec["questions"][number], region: Region) => {
    if (!q.graph) return;
    const setA = q.graph.series.filter((series) => series.audience === "A");
    const setB = q.graph.series.filter((series) => series.audience === "B");
    const shared = q.graph.series.filter((series) => series.audience === "both");
    if (setA.length && setB.length) {
      const dense = Math.max(...setA.map((series) => series.points.length), ...setB.map((series) => series.points.length)) >= 6;
      if (dense) {
        const gap = 0.14, panelH = (region.h - gap) / 2;
        drawSolutionGraphSeries(slide, q, setA, { x: region.x, y: region.y, w: region.w, h: panelH }, "A");
        drawSolutionGraphSeries(slide, q, setB, { x: region.x, y: region.y + panelH + gap, w: region.w, h: panelH }, "B");
      } else {
        const gap = 0.18, panelW = (region.w - gap) / 2;
        drawSolutionGraphSeries(slide, q, setA, { x: region.x, y: region.y, w: panelW, h: region.h }, "A");
        drawSolutionGraphSeries(slide, q, setB, { x: region.x + panelW + gap, y: region.y, w: panelW, h: region.h }, "B");
      }
    } else drawSolutionGraphSeries(slide, q, shared.length ? shared : q.graph.series, region);
  };

  const drawSolutionDiagram = (slide: any, q: ActivitySpec["questions"][number], region: Region) => {
    if (!q.diagram) return;
    const byId = new Map(q.diagram.nodes.map((node) => [node.id, node]));
    for (const connector of q.diagram.connectors) {
      const from = byId.get(connector.from), to = byId.get(connector.to); if (!from || !to) continue;
      const x1 = region.x + from.x * region.w, y1 = region.y + from.y * region.h, x2 = region.x + to.x * region.w, y2 = region.y + to.y * region.h; const dx = x2 - x1, dy = y2 - y1;
      slide.addShape(pptx.ShapeType.line, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.max(0.001, Math.abs(dx)), h: Math.max(0.001, Math.abs(dy)), flipV: dx * dy < 0, line: { color: c.ink, width: 1.4, endArrowType: "triangle" } });
      if (connector.label) addRich(slide, connector.label, { x: (x1 + x2) / 2 - 0.55, y: (y1 + y2) / 2 - 0.16, w: 1.1, h: 0.22, fontSize: 10, align: "center", color: c.muted, fill: { color: c.bg } });
    }
    for (const node of q.diagram.nodes) {
      const x = region.x + node.x * region.w - 0.72, y = region.y + node.y * region.h - 0.31;
      slide.addShape(pptx.ShapeType.rect, { x, y, w: 1.44, h: 0.62, fill: { color: c.white }, line: { color: c.ink, width: 1.2 } });
      addRich(slide, node.label, { x: x + 0.08, y: y + 0.08, w: 1.28, h: 0.46, fontSize: 11, bold: true, align: "center", valign: "mid", color: c.ink, fit: "shrink" }, { bold: true });
    }
  };

  const drawBlankTable = (slide: any, q: ActivitySpec["questions"][number], audience: "A" | "B", region: Region) => {
    const columns = q.table?.columns ?? ["Response"];
    const rowLabels = audience === "A" ? q.table?.setARowLabels : q.table?.setBRowLabels;
    const labels = rowLabels?.length ? rowLabels : ["1", "2", "3"];
    const headings = [q.table?.rowHeader ?? "Item", ...columns];
    const header = headings.map((text) => ({ text: unicodeScienceText(text), options: { bold: true, align: "center", fill: { color: "E7E7E7" } } }));
    const rows = labels.map((label) => [({ text: unicodeScienceText(label), options: { bold: true, fill: { color: "F4F4F4" } } }), ...columns.map(() => "")]);
    slide.addTable([header, ...rows], { x: region.x, y: region.y, w: region.w, h: region.h, border: { type: "solid", color: c.ink, pt: 1 }, fill: { color: c.white }, color: c.ink, fontFace: spec.design.bodyFont, fontSize: 13.5, margin: 0.06, valign: "middle" });
  };

  const drawSolutionTable = (slide: any, q: ActivitySpec["questions"][number], region: Region) => {
    if (!q.table) return;
    const header = [q.table.rowHeader, ...q.table.columns].map((value) => ({ text: unicodeScienceText(value), options: { bold: true, align: "center", fill: { color: "E7E7E7" } } }));
    const makeRows = (audience: "A" | "B", labels: string[], answers: string[][]) => labels.map((label, index) => [
      { text: unicodeScienceText(`[${audience}] ${label}`), options: { bold: true, fill: { color: "F4F4F4" } } },
      ...q.table!.columns.map((_, column) => unicodeScienceText(answers[index]?.[column] ?? "—")),
    ]);
    const rows = [...makeRows("A", q.table.setARowLabels, q.table.setAAnswerRows), ...makeRows("B", q.table.setBRowLabels, q.table.setBAnswerRows)];
    slide.addTable([header, ...rows], { x: region.x, y: region.y, w: region.w, h: region.h, border: { type: "solid", color: c.ink, pt: 0.9 }, fill: { color: c.white }, color: c.ink, fontFace: spec.design.bodyFont, fontSize: rows.length > 6 ? 8.5 : 10.5, margin: 0.05, valign: "middle", autoFit: false });
  };

  const meaningfulShared = (value: string) => value.trim().length > 18 && !/^use (?:the )?(?:relevant|same|supplied)/i.test(value.trim());
  const refersToSharedStimulus = (tasks: ActivitySpec["questions"][number]["setATasks"]) =>
    /\b(?:refer(?:ring)? to|shown|displayed|supplied|above|table|graph|diagram|data|passage|extract|image|figure)\b/i.test(tasks.map((task) => task.prompt).join(" "));
  const canonicalText = (value: string) => value.replace(/\*\*/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const commandBoldCount = (value: string, commandWord: string) => {
    const visible = value.replace(/\*\*/g, "").trim().toLowerCase();
    const command = commandWord.replace(/\*\*/g, "").trim().toLowerCase();
    return command && visible.startsWith(command) ? (command.match(/[a-z0-9]+/g)?.length ?? 0) : 0;
  };
  const visualAction = (value: string, type: "graph" | "table") => type === "graph"
    ? /\b(?:sketch|plot|draw|complete|label)\b[^.?!]{0,100}\b(?:graph|curve|trend|axes?)\b|\b(?:graph|curve|axes?)\b[^.?!]{0,100}\b(?:sketch|plot|draw|complete|label)\b/i.test(value)
    : /\b(?:complet(?:e|es|ed|ing)|fill(?:s|ed|ing)?(?: in)?|populat(?:e|es|ed|ing)|construct(?:s|ed|ing)?)\b[^.?!]{0,100}\btable\b|\btable\b[^.?!]{0,100}\b(?:complet(?:e|es|ed|ing)|fill(?:s|ed|ing)?(?: in)?|populat(?:e|es|ed|ing)|construct(?:s|ed|ing)?)\b/i.test(value);
  const isPureVisualTask = (q: ActivitySpec["questions"][number], task: QuestionTask) => {
    if (q.responseType !== "graph" && q.responseType !== "table") return false;
    if (!visualAction(task.prompt, q.responseType)) return false;
    const withoutVisualCommand = task.prompt.replace(/\b(?:sketch|plot|draw|complet(?:e|es|ed|ing)|label|fill(?:s|ed|ing)?(?: in)?|populat(?:e|es|ed|ing)|construct(?:s|ed|ing)?)\b/ig, "");
    return !/\b(?:explain|describe|justify|deduce|predict|compare|contrast|interpret|state|identify|calculate|determine)\b/i.test(withoutVisualCommand);
  };
  const conciseAnswer = (value: string) => {
    const normalized = value.trim().replace(/\s+•\s+/g, "\n• ").replace(/^[-]\s+/gm, "• ");
    if (/^\s*•\s/m.test(normalized)) return normalized;
    const parts = normalized.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/).filter(Boolean);
    return parts.length >= 3 && parts.length <= 6 ? parts.map((part) => `• ${part}`).join("\n") : value;
  };
  type QuestionTask = ActivitySpec["questions"][number]["setATasks"][number];
  type CompiledTask = QuestionTask & { audience: "A" | "B" | "A+B" };
  const taskUnion = (q: ActivitySpec["questions"][number]): CompiledTask[] => {
    const union: CompiledTask[] = q.setATasks.map((task) => ({ ...task, audience: "A" }));
    for (const task of q.setBTasks) {
      const existing = union.find((candidate) => canonicalText(candidate.prompt) === canonicalText(task.prompt));
      if (existing) {
        existing.audience = "A+B";
        if (canonicalText(existing.answer) !== canonicalText(task.answer)) existing.answer = `${existing.answer}\n${task.answer}`;
      } else union.push({ ...task, audience: "B" });
    }
    return union;
  };
  const addAnswerBlock = (slide: any, label: "A" | "B" | "A+B", task: QuestionTask, region: Region, showAnswer = true) => {
    const { prompt, answer, commandWord } = task;
    const compact = region.h < 3.2;
    const promptHeight = compact
      ? Math.min(0.92, Math.max(0.58, 0.46 + prompt.length / 360))
      : Math.min(1.22, Math.max(0.68, 0.55 + prompt.length / 240));
    const labelW = label === "A+B" ? 0.9 : 0.72;
    slide.addText(`[${label}]`, { x: region.x, y: region.y + 0.03, w: labelW, h: 0.46, fontFace: spec.design.headingFont, fontSize: label === "A+B" ? 19 : 25, bold: true, color: c.ink, margin: 0, fit: "shrink" });
    addRich(slide, prompt, { x: region.x + labelW + 0.03, y: region.y, w: region.w - labelW - 0.03, h: promptHeight, fontSize: compact ? 15 : 15.5, color: c.ink, fill: { color: spec.design.promptHighlight ? c.highlight : c.bg }, fit: "shrink", valign: "mid" }, { boldFirstWords: commandBoldCount(prompt, commandWord) });
    // Unicode science glyphs keep a formula or ionic charge in one wrapping run.
    // PowerPoint can otherwise wrap a superscript rich-text run away from its element.
    if (showAnswer) addWrappingScienceText(slide, conciseAnswer(answer), { x: region.x + labelW + 0.03, y: region.y + promptHeight + 0.12, w: region.w - labelW - 0.1, h: Math.max(0.55, region.h - promptHeight - 0.14), fontSize: 16, color: c.ink, valign: "top", fit: "shrink", paraSpaceAfterPt: compact ? 4 : 7 });
  };
  const addUnifiedAnswerBlock = (slide: any, task: QuestionTask, region: Region) => {
    const { prompt, answer, commandWord } = task;
    const promptHeight = Math.min(1.28, Math.max(0.72, 0.58 + prompt.length / 210));
    addRich(slide, prompt, { x: region.x, y: region.y, w: region.w, h: promptHeight, fontSize: 18, color: c.ink, fill: { color: spec.design.promptHighlight ? c.highlight : c.bg }, fit: "shrink", valign: "mid" }, { boldFirstWords: commandBoldCount(prompt, commandWord) });
    addWrappingScienceText(slide, conciseAnswer(answer), { x: region.x, y: region.y + promptHeight + 0.25, w: region.w, h: Math.max(1.2, region.h - promptHeight - 0.25), fontSize: 18, color: c.ink, valign: "top", fit: "shrink", paraSpaceAfterPt: 8 });
  };
  const addStudentTasks = (slide: any, tasks: QuestionTask[], region: Region) => {
    const gap = tasks.length > 1 ? 0.28 : 0;
    const blockH = (region.h - gap * (tasks.length - 1)) / tasks.length;
    tasks.forEach((task, index) => {
      const y = region.y + index * (blockH + gap);
      const labelW = tasks.length > 1 ? 0.5 : 0;
      if (tasks.length > 1) slide.addText(`(${String.fromCharCode(97 + index)})`, { x: region.x, y: y + 0.03, w: labelW, h: 0.38, fontFace: spec.design.headingFont, fontSize: 17, bold: true, color: c.ink, margin: 0 });
      addRich(slide, task.prompt, { x: region.x + labelW, y, w: region.w - labelW, h: Math.min(1.35, blockH * 0.48), fontSize: tasks.length > 1 ? 18 : 20, color: c.ink, valign: "top", fit: "shrink" }, { boldFirstWords: commandBoldCount(task.prompt, task.commandWord) });
      if (tasks.length > 1 && index < tasks.length - 1) slide.addShape(pptx.ShapeType.line, { x: region.x, y: y + blockH + gap / 2, w: region.w, h: 0, line: { color: c.line, width: 0.8, transparency: 35 } });
    });
  };

  for (const q of spec.questions) {
    const tasks = mode === "A" ? q.setATasks : q.setBTasks;
    const slide = pptx.addSlide(); slide.background = { color: c.bg }; addQuestionTag(slide, q.number, mode === "answers");
    if (mode !== "answers") {
      const hasStudentVisual = q.responseType === "graph" || q.responseType === "table";
      const showSharedText = q.sharedStimulusRequired && meaningfulShared(q.sharedPrompt) && refersToSharedStimulus(tasks);
      const split = showSharedText;
      if (split) {
        addDashedDivider(slide, 6.12, 0.7, 6.42);
        if (showSharedText) {
          slide.addText(q.sharedPromptMode === "summary" ? "TOPIC SUMMARY" : "SHARED INFORMATION", { x: 0.62, y: 0.72, w: 2.3, h: 0.28, fontFace: spec.design.headingFont, fontSize: 10, bold: true, charSpacing: 1.1, color: c.muted, margin: 0 });
          addRich(slide, q.sharedPrompt, { x: 0.62, y: 1.08, w: 4.95, h: 1.0, fontSize: 18, color: c.ink, valign: "top" });
        }
        if (q.responseType === "graph") drawBlankGraph(slide, q, mode, { x: 0.68, y: showSharedText ? 2.05 : 0.95, w: 4.95, h: showSharedText ? 4.45 : 5.55 });
        else if (q.responseType === "table") drawBlankTable(slide, q, mode, { x: 0.75, y: showSharedText ? 2.15 : 1.05, w: 4.85, h: showSharedText ? 3.7 : 4.9 });
        addStudentTasks(slide, tasks, { x: 6.62, y: 0.88, w: 5.72, h: 5.85 });
      } else {
        const taskHeight = hasStudentVisual ? (tasks.length > 1 ? 2.15 : 1.5) : 5.95;
        addStudentTasks(slide, tasks, { x: 1.25, y: 0.88, w: 10.8, h: taskHeight });
        const visualY = tasks.length > 1 ? 3.22 : 2.48;
        if (q.responseType === "graph") drawBlankGraph(slide, q, mode, { x: 2.05, y: visualY, w: 9.1, h: 6.72 - visualY });
        else if (q.responseType === "table") drawBlankTable(slide, q, mode, { x: 1.4, y: visualY + 0.18, w: 10.55, h: 6.35 - visualY });
      }
      slide.addNotes(questionNotes(q));
      continue;
    }

    const hasVisual = (q.responseType === "graph" && q.graph) || (q.responseType === "diagram" && q.diagram) || (q.responseType === "table" && q.table);
    const compiled = taskUnion(q);
    const pureGraphDebrief = q.responseType === "graph" && q.graph && compiled.every((task) => isPureVisualTask(q, task));
    if (pureGraphDebrief && compiled.length === 1) {
      addAnswerBlock(slide, compiled[0].audience, compiled[0], { x: 1.05, y: 0.72, w: 11.2, h: 1.35 }, false);
      drawSolutionGraph(slide, q, { x: 2.05, y: 2.18, w: 9.15, h: 4.5 });
    } else if (pureGraphDebrief && compiled.length === 2) {
      addDashedDivider(slide, 6.65, 0.72, 6.02);
      compiled.forEach((task, index) => {
        const x = index === 0 ? 0.55 : 6.95;
        addAnswerBlock(slide, task.audience, task, { x, y: 0.72, w: 5.82, h: 1.38 }, false);
        const series = q.graph!.series.filter((item) => task.audience === "A+B" ? item.audience === "both" : item.audience === task.audience || item.audience === "both");
        drawSolutionGraphSeries(slide, q, series.length ? series : q.graph!.series, { x: x + 0.18, y: 2.28, w: 5.42, h: 4.18 });
      });
    } else if (hasVisual) {
      addDashedDivider(slide, 5.05, 0.72, 6.37);
      const showSharedText = q.sharedStimulusRequired && meaningfulShared(q.sharedPrompt) && refersToSharedStimulus([...q.setATasks, ...q.setBTasks]);
      const allTasksArePureVisual = compiled.every((task) => isPureVisualTask(q, task));
      const leftSummary = [showSharedText ? q.sharedPrompt : "", allTasksArePureVisual ? "" : q.commonAnswer.trim()].filter(Boolean).join("\n\n");
      if (leftSummary) addRich(slide, leftSummary, { x: 0.42, y: 0.52, w: 4.28, h: 1.68, fontSize: 14.5, color: c.ink, valign: "top", fit: "shrink" });
      const visualRegion = { x: 0.42, y: leftSummary ? 2.28 : 0.92, w: 4.3, h: leftSummary ? 4.16 : 5.52 };
      if (q.responseType === "graph") drawSolutionGraph(slide, q, visualRegion);
      else if (q.responseType === "table") drawSolutionTable(slide, q, visualRegion);
      else drawSolutionDiagram(slide, q, visualRegion);
      const gap = 0.1, h = (5.82 - gap * (compiled.length - 1)) / compiled.length;
      compiled.forEach((task, index) => addAnswerBlock(slide, task.audience, task, { x: 5.35, y: 0.68 + index * (h + gap), w: 7.52, h }, !isPureVisualTask(q, task)));
    } else if (compiled.length === 1) {
      addUnifiedAnswerBlock(slide, compiled[0], { x: 1.05, y: 0.92, w: 11.2, h: 5.45 });
    } else if (compiled.length === 2) {
      addDashedDivider(slide, 6.65, 0.78, 5.75);
      addAnswerBlock(slide, compiled[0].audience, compiled[0], { x: 0.42, y: 0.82, w: 5.88, h: 5.62 });
      addAnswerBlock(slide, compiled[1].audience, compiled[1], { x: 6.95, y: 0.82, w: 5.88, h: 5.62 });
    } else if (compiled.length === 3) {
      const rowH = 1.82;
      compiled.forEach((task, index) => addAnswerBlock(slide, task.audience, task, { x: 0.55, y: 0.72 + index * 1.95, w: 12.15, h: rowH }));
    } else {
      const regions = [{ x: 0.42, y: 0.78 }, { x: 6.95, y: 0.78 }, { x: 0.42, y: 3.72 }, { x: 6.95, y: 3.72 }];
      addDashedDivider(slide, 6.65, 0.78, 5.75);
      compiled.slice(0, 4).forEach((task, index) => addAnswerBlock(slide, task.audience, task, { ...regions[index], w: 5.88, h: 2.68 }));
    }
    if (!hasVisual && compiled.length <= 2 && q.commonAnswer.trim()) {
      slide.addShape(pptx.ShapeType.line, { x: 0.6, y: 6.62, w: 12.1, h: 0, line: { color: c.line, width: 0.8, transparency: 45 } });
      addRich(slide, q.commonAnswer, { x: 0.72, y: 6.73, w: 11.85, h: 0.55, fontSize: 14, color: c.muted, align: "center", valign: "mid", fit: "shrink" }, { boldFirstWords: 2 });
    }
    slide.addNotes(questionNotes(q));
  }
  return pptx;
}

export async function renderDecks(spec: ActivitySpec, outputDir: string) {
  const stem = safeTopic(spec.topic).replace(/\s+/g, "_");
  const paths = {
    setA: join(outputDir, `${stem}_Set_A.pptx`), setB: join(outputDir, `${stem}_Set_B.pptx`),
    answers: join(outputDir, `${stem}_Compiled_Answers.pptx`), bundle: join(outputDir, `${stem}_PowerPoints.zip`),
  };
  await makeDeck(spec, "A").writeFile({ fileName: paths.setA });
  await makeDeck(spec, "B").writeFile({ fileName: paths.setB });
  await makeDeck(spec, "answers").writeFile({ fileName: paths.answers });
  const zip = new JSZip();
  for (const key of ["setA", "setB", "answers"] as const) zip.file(basename(paths[key]), await readFile(paths[key]));
  await writeFile(paths.bundle, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  return paths;
}
