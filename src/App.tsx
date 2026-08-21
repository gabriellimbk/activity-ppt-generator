import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch, serverlessMode, supabase } from "./supabase";
import { acceptedMime, removeCloudInputs, storageSafeName, uploadCloudFile } from "./cloudUploads";

export const DEFAULT_PROMPT = `Create a collaborative classroom activity from the uploaded syllabus, lecture notes, tutorials and answer materials. Treat the syllabus as the authority for scope and learning outcomes. Treat lecture notes and supplied tutorial answers as the authority for facts and expected responses.

Keep the activity source-locked. Questions should be direct restatements or minimal adaptations of concepts, worked examples and tutorial tasks that are explicitly taught in the uploaded materials. Answers must use the terminology, reasoning steps, examples, equations, values and expected level of detail found in the lecture notes or supplied tutorial answers. Do not complete, improve or extend an answer using general subject knowledge. Do not introduce a new example, substance, scenario, dataset, comparison or mechanism merely because it is plausible. If the uploaded materials do not directly support both halves of a proposed pair, select a different well-supported concept instead. Every common, Set A and Set B answer must cite an exact source filename and page or slide in speaker notes, together with the short supporting source wording or a faithful close paraphrase.

Select questions only from the intersection of an explicit syllabus learning outcome, content explicitly taught in the lecture notes, and a source-supported task form or example. A syllabus topic heading or a definition appearing in lecture notes does not by itself justify a definition question; ask for a definition only when the syllabus outcome explicitly requires one. Do not combine separate syllabus outcomes, source-table rows or teaching examples into a new compound question. Preserve all supplied numerical values exactly and never create a new numerical scenario. Breadth is not an objective: it is preferable for several question pairs to revisit a central taught outcome than to introduce loosely related or weakly supported questions.

Produce Set A, Set B and one compiled answer deck. Use five question pairs by default. Additional requirements may request between three and eight. Each numbered question must assess the same concept, command-word level, response form, approximate workload and expected completion time in both sets.

Use the syllabus glossary of examination or command terms as the authority for question command words whenever it is present. Use only terms explicitly listed there and apply each term according to its glossary definition. Set A and Set B must use the same command word or command phrase. Do not introduce alternatives such as Analyse/Analyze, Discuss or Evaluate unless that exact term is present in the uploaded syllabus glossary. If no glossary is present, use a conservative conventional set such as State, Identify, Describe, Explain, Compare, Contrast, Calculate, Determine, Predict, Deduce, Justify, Sketch and Plot.

Use a shared-spine and complementary-coverage design. Suitable pairings include dividing examples along one continuum, applying opposite perspectives or reagents, comparing two categories, giving one group breadth and the other depth on the same principle, or using an identical anchor question. Where questions differ, they must remain on the same underlying concept.

Each numbered item may contain one or two clearly separated questions for Set A and the same number of counterpart questions for Set B. Do not create a context or topic-summary column by default. Use a shared-information column only when students must inspect displayed data, a passage, quotation, image, equation, graph, table or diagram and the question explicitly refers to it. Otherwise, use the full slide for the questions and working space. Shared information must never hide an unstructured question or task, and it must not state, paraphrase or substantially reveal an answer. Keep Set A and Set B matched in number of questions, command words, required outputs, equation or diagram requirements, expected marking points and workload.

One or more questions may be identical across Set A and Set B. Use identical prompt and answer text for each shared question. The compiled answer slide must show the union of unique questions: every shared identical question once, plus every Set-specific question once. For example, if Set A has two questions and Set B has two questions, with one question identical across both sets, the compiled slide must show exactly three questions and three answers.

Prefer concise questions testing concepts, principles, theory, explanation, classification, interpretation, equations, graphs, tables or diagrams. Avoid unnecessarily long contexts, calculations or unfamiliar scenarios unless required by the syllabus or additional prompt. Where a suitable tutorial question exists, follow it closely and make only the minimal changes needed to create the paired Set A and Set B variants.

Begin each student deck with clear activity instructions. By default, tell students to work within their group, answer as many questions correctly as possible within the time limit, avoid online and lecture-note references, and use one one-time true/false teacher lifeline.

The compiled answer deck must follow the same question order, show common material once, clearly label Set A and Set B material, and combine both halves into a coherent whole-class debrief. Answers must be complete, concise and supported by the uploaded materials. Each question must occupy exactly one compiled debrief slide. Never create separate shared-explanation, solution, continuation or answer-continued slides. Condense wording while preserving every marking point so the full common, Set A and Set B answer fits legibly on that one slide.

Format debrief answers as compact marking points, short bullets, equations or brief linked statements rather than dense paragraphs. Keep the question highlight close to the actual question text instead of filling an unnecessarily large block.

Treat the template PowerPoints as the authority for visual hierarchy and slide composition, but not as an authority for subject facts. By default, follow the supplied PowerPoint templates: a clean white canvas, one instruction slide followed by one slide per numbered question, a large [Qn] or [Qn Ans] label at the top-right, sparse black typography, a vertical dashed divider for paired content, and yellow highlighting behind question wording in the compiled answers. Do not add a separate cover slide or large concept-title banner. Use the available canvas for the task and response.

Use native editable PowerPoint text, shapes, tables, charts, axes and lines. Keep titles, prompts, labels, formulas and answers editable. If a graph or simple diagram is required in the compiled answer, place it on the same debrief slide as the answers. Use uploaded images only when they materially support a question.

Make the answer format exactly match the displayed command. For a pure Sketch, Plot or Draw question, the completed editable graph or diagram is the answer; do not place an unasked Describe or Explain answer beside it. If students must also describe or explain the visual, ask that explicitly as a separate structured question in both Set A and Set B. Use a table response only when the visible question explicitly asks students to complete, fill in, populate or construct that table. The compiled debrief must reproduce the same table with every answer cell completed. A Describe or Explain question must use a text answer unless it explicitly asks for a table as well.

For science and mathematics, use correct notation throughout. Write formulae and equations with unambiguous Unicode or LaTeX-style subscript and superscript markup, for example H₂O or H_2O, SO₄²⁻ or SO_4^{2-}, x² or x^2, and E°. Use proper arrows and state symbols. Never substitute lookalike characters such as theta for the degree symbol. Bold only command words and genuinely important terms; do not bold whole paragraphs.

Visible slides must contain only information useful to students or the whole-class debrief. Keep timing, difficulty, pairing method, source provenance, warnings and production commentary in speaker notes. Give student slides generous working space. Include a graph, table or diagram only when it is required to answer or explain the question; labels must be readable and diagrams must be simple, well-spaced and conceptually meaningful.

Add source filenames and page or slide references to speaker notes. If evidence is missing, ambiguous or contradictory, still generate the decks but add a clear warning to the affected slide's notes. Warnings may describe the evidence problem but must not add new subject or safety claims that are absent from the uploaded materials. Do not silently introduce unsupported claims.`;

type PickedFile = { id: string; file: File; role: string; pages?: number; inspecting?: boolean };
type DefaultReference = { name: string; slides: number; size: number };
type JobView = { id: string; status: "uploading" | "queued" | "running" | "ready" | "failed" | "cancelled"; stage: string; progress: number; warnings: string[]; error?: string };
const STAGES = ["Preparing files", "Analysing syllabus", "Mapping content", "Creating paired questions", "Building decks", "Checking slides", "Ready"];
const BUNDLED_REFERENCES: DefaultReference[] = [
  { name: "Set A.pptx", slides: 6, size: 115_523 },
  { name: "Set B.pptx", slides: 6, size: 115_421 },
  { name: "Ans for Set A and B.pptx", slides: 6, size: 136_374 },
];

const inferRole = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes("answer")) return "Answer material";
  if (lower.includes("tutorial") || lower.includes("worksheet")) return "Tutorial";
  if (lower.includes("lecture") || lower.includes("notes")) return "Lecture";
  return "Other";
};

const fileSize = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

export default function App() {
  const [materials, setMaterials] = useState<PickedFile[]>([]);
  const [syllabus, setSyllabus] = useState<File | null>(null);
  const [syllabusPages, setSyllabusPages] = useState<number | null>(null);
  const [defaultReferences, setDefaultReferences] = useState<DefaultReference[]>(BUNDLED_REFERENCES);
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [useDefaultReferences, setUseDefaultReferences] = useState(true);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [locked, setLocked] = useState(true);
  const [additional, setAdditional] = useState("");
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const materialsRef = useRef<HTMLInputElement>(null);
  const syllabusRef = useRef<HTMLInputElement>(null);
  const referenceRef = useRef<HTMLInputElement>(null);
  const generationAbortRef = useRef<AbortController | null>(null);
  const ready = useMemo(() => materials.length > 0 && syllabus && prompt.trim().length > 20 && !busy, [materials, syllabus, prompt, busy]);

  useEffect(() => {
    void authFetch("/api/reference-defaults").then((response) => response.ok ? response.json() : { files: BUNDLED_REFERENCES }).then((data) => setDefaultReferences(data.files?.length ? data.files : BUNDLED_REFERENCES)).catch(() => setDefaultReferences(BUNDLED_REFERENCES));
  }, []);

  const inspect = async (item: PickedFile) => {
    if (serverlessMode) { setMaterials((files) => files.map((file) => file.id === item.id ? { ...file, inspecting: false } : file)); return; }
    const body = new FormData(); body.append("file", item.file);
    try { const result = await authFetch("/api/inspect", { method: "POST", body }); const data = await result.json(); if (result.ok) setMaterials((files) => files.map((file) => file.id === item.id ? { ...file, pages: data.pages, inspecting: false } : file)); else throw new Error(data.error); }
    catch { setMaterials((files) => files.map((file) => file.id === item.id ? { ...file, inspecting: false } : file)); }
  };
  const chooseSyllabus = async (file: File | null) => {
    setSyllabus(file); setSyllabusPages(null); if (!file) return;
    if (serverlessMode) return;
    const body = new FormData(); body.append("file", file);
    try { const response = await authFetch("/api/inspect", { method: "POST", body }); const data = await response.json(); if (response.ok) setSyllabusPages(data.pages); } catch { /* checked again during generation */ }
  };

  const addMaterials = (files: FileList | null) => {
    if (!files) return;
    const valid = Array.from(files).filter((file) => /\.(pdf|docx|pptx)$/i.test(file.name) && file.size <= 50 * 1024 * 1024).map((file) => ({ id: crypto.randomUUID(), file, role: inferRole(file.name), inspecting: true }));
    setMaterials((current) => [...current, ...valid]); valid.forEach((item) => void inspect(item));
  };

  const chooseReferences = (files: FileList | null) => {
    if (!files) return;
    const valid = Array.from(files).filter((file) => /\.pptx$/i.test(file.name) && file.size <= 50 * 1024 * 1024).slice(0, 3);
    if (!valid.length) { setFormError("Template PowerPoints must be editable .pptx files no larger than 50 MB."); return; }
    setReferenceFiles(valid); setUseDefaultReferences(false); setFormError("");
  };

  const pollJob = async (id: string) => {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const progressResponse = await authFetch(`/api/jobs/${id}`); const next = await progressResponse.json();
      if (!progressResponse.ok) throw new Error(next.error ?? "Could not read generation progress.");
      setJob({ id, ...next });
      if (["ready", "failed", "cancelled"].includes(next.status)) { setBusy(false); break; }
    }
  };

  const generateCloud = async () => {
    if (!syllabus || !supabase) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("Your session has expired. Please sign in again.");
    const id = crypto.randomUUID(); const uploadedPaths: string[] = [];
    const uploadAbort = new AbortController(); generationAbortRef.current = uploadAbort;
    setJob({ id, status: "uploading", stage: "Preparing files", progress: 1, warnings: [] });
    const allFiles = [
      ...materials.map((item) => ({ file: item.file, kind: "material" as const, role: item.role })),
      { file: syllabus, kind: "syllabus" as const, role: "Syllabus" },
      ...referenceFiles.map((file) => ({ file, kind: "reference" as const, role: "Reference format" })),
    ];
    const planned = allFiles.map((item) => ({
      ...item,
      path: `${session.user.id}/${id}/${item.kind}/${crypto.randomUUID()}-${storageSafeName(item.file.name)}`,
    }));
    const inputs = planned.map((item) => ({ kind: item.kind, path: item.path, name: item.file.name, role: item.role, size: item.file.size, mime: acceptedMime(item.file) }));
    const totalBytes = allFiles.reduce((sum, item) => sum + item.file.size, 0); let completedBytes = 0; let reserved = false;
    try {
      const reserveResponse = await authFetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, inputs, useDefaultReferences, designPrompt: prompt, additionalPrompt: additional }) });
      const reserveData = await reserveResponse.json(); if (!reserveResponse.ok) throw new Error(reserveData.error ?? "Could not reserve the generation job.");
      reserved = true;
      for (const item of planned) {
        const before = completedBytes;
        await uploadCloudFile(item.file, item.path, (uploaded) => setJob((current) => current ? { ...current, progress: Math.min(18, 1 + Math.round(((before + uploaded) / totalBytes) * 17)) } : current), uploadAbort.signal);
        completedBytes += item.file.size; uploadedPaths.push(item.path);
      }
      const response = await authFetch(`/api/jobs/${id}/start`, { method: "POST" });
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Could not start generation.");
      setJob({ id, status: "queued", stage: "Preparing files", progress: 18, warnings: [] });
      await pollJob(id);
    } catch (error) {
      if (reserved) await authFetch(`/api/jobs/${id}`, { method: "DELETE" }).catch(() => undefined);
      else await removeCloudInputs(uploadedPaths);
      throw error;
    } finally {
      if (generationAbortRef.current === uploadAbort) generationAbortRef.current = null;
    }
  };

  const generate = async () => {
    if (!syllabus) return; setBusy(true); setFormError(""); setJob(null);
    const body = new FormData(); materials.forEach((item) => body.append("materials", item.file)); body.append("syllabus", syllabus); referenceFiles.forEach((file) => body.append("references", file)); body.append("useDefaultReferences", String(useDefaultReferences)); body.append("designPrompt", prompt); body.append("additionalPrompt", additional); body.append("roles", JSON.stringify(Object.fromEntries(materials.map((item) => [item.file.name, item.role]))));
    try {
      if (serverlessMode) { await generateCloud(); return; }
      const response = await authFetch("/api/jobs", { method: "POST", body }); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Could not start generation.");
      const id = data.jobId as string; setJob({ id, status: "queued", stage: STAGES[0], progress: 0, warnings: [] });
      await pollJob(id);
    } catch (error) {
      setBusy(false);
      if (!(error instanceof DOMException && error.name === "AbortError")) setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const cancel = async () => {
    generationAbortRef.current?.abort();
    if (job) await authFetch(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    setJob((current) => current ? { ...current, status: "cancelled", stage: current.stage } : current);
    setBusy(false);
  };

  const downloadArtifact = async (artifact: "setA" | "setB" | "answers" | "bundle") => {
    if (!job) return;
    try {
      const response = await authFetch(`/api/jobs/${job.id}/files/${artifact}`);
      if (!response.ok) throw new Error((await response.json()).error ?? "Download failed.");
      const blob = await response.blob(); const url = URL.createObjectURL(blob);
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `${artifact}.${artifact === "bundle" ? "zip" : "pptx"}`;
      const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
    } catch (error) { setFormError(error instanceof Error ? error.message : String(error)); }
  };

  return (
    <main className="app-shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">Teacher workspace</p>
          <h1>Collaborative Activity Generator</h1>
          <p className="subtitle">Turn your syllabus and teaching materials into paired group tasks and a compiled, editable PowerPoint debrief.</p>
        </div>
        <div className="local-badge"><span /> {serverlessMode ? "Secure teacher workspace" : "Local & private"}</div>
      </header>

      <section className="workflow" aria-label="Generation workflow">
        {[["01", "Add materials"], ["02", "Set the brief"], ["03", "Generate decks"]].map(([number, label], index) => (
          <div className={`workflow-step ${index === 0 ? "active" : ""}`} key={number}><span>{number}</span><strong>{label}</strong></div>
        ))}
      </section>

      <div className="content-grid">
        <section className="panel upload-panel">
          <div className="section-heading"><div><span className="section-number">1</span><h2>Source materials</h2></div><p>PDF, Word or PowerPoint · up to 50 MB each</p></div>

          <button className="dropzone" type="button" onClick={() => materialsRef.current?.click()}>
            <span className="upload-icon">↑</span><strong>Lecture notes & learning materials</strong><small>Choose one or more files</small>
          </button>
          <input ref={materialsRef} hidden type="file" multiple accept=".pdf,.docx,.pptx" onChange={(event) => addMaterials(event.target.files)} />

          {materials.length > 0 && <div className="file-list">{materials.map((item) => <div className="file-card" key={item.id}>
            <div className="file-type">{item.file.name.split(".").pop()?.toUpperCase()}</div>
            <div className="file-copy"><strong title={item.file.name}>{item.file.name}</strong><span>{fileSize(item.file.size)} · {item.inspecting ? "checking pages…" : item.pages ? `${item.pages} page${item.pages === 1 ? "" : "s"}` : "pages checked at generation"}</span></div>
            <select aria-label={`Role for ${item.file.name}`} value={item.role} onChange={(event) => setMaterials((files) => files.map((file) => file.id === item.id ? {...file, role: event.target.value} : file))}>
              <option>Lecture</option><option>Tutorial</option><option>Answer material</option><option>Other</option>
            </select>
            <button type="button" className="remove" aria-label={`Remove ${item.file.name}`} onClick={() => setMaterials((files) => files.filter((file) => file.id !== item.id))}>×</button>
          </div>)}</div>}

          <button className={`dropzone syllabus-zone ${syllabus ? "has-file" : ""}`} type="button" onClick={() => syllabusRef.current?.click()}>
            <span className="upload-icon">§</span><strong>{syllabus ? syllabus.name : "Syllabus document"}</strong><small>{syllabus ? `${fileSize(syllabus.size)} · ${serverlessMode ? "pages checked during generation" : syllabusPages ? `${syllabusPages} page${syllabusPages === 1 ? "" : "s"}` : "checking pages…"} · click to replace` : "Choose one PDF or Word file"}</small>
          </button>
          <input ref={syllabusRef} hidden type="file" accept=".pdf,.docx" onChange={(event) => void chooseSyllabus(event.target.files?.[0] ?? null)} />

          <div className="reference-heading"><div><strong>Template PowerPoints</strong><span>Formatting and layout only</span></div>{!useDefaultReferences && <button type="button" onClick={() => { setReferenceFiles([]); setUseDefaultReferences(true); }}>Restore default templates</button>}</div>
          <button className="dropzone reference-zone" type="button" onClick={() => referenceRef.current?.click()}>
            <span className="upload-icon">▣</span><strong>Replace template PowerPoints</strong><small>Choose up to three editable PPTX files</small>
          </button>
          <input ref={referenceRef} hidden type="file" multiple accept=".pptx" onChange={(event) => chooseReferences(event.target.files)} />
          <div className="reference-list">
            {(useDefaultReferences ? defaultReferences : referenceFiles.map((file) => ({ name: file.name, size: file.size, slides: 0 }))).map((file) => <div className="reference-card" key={file.name}>
              <span className="reference-badge">{useDefaultReferences ? "TEMPLATE" : "CUSTOM"}</span>
              <div><strong title={file.name}>{file.name}</strong><small>{fileSize(file.size)}{file.slides ? ` · ${file.slides} slides` : ""}</small></div>
            </div>)}
          </div>
        </section>

        <section className="panel brief-panel">
          <div className="section-heading"><div><span className="section-number">2</span><h2>Activity brief</h2></div><p>Set the rules Gemini will follow</p></div>
          <div className="field-label"><label htmlFor="design-prompt">Design prompt</label><div className="prompt-actions">
            <button type="button" onClick={() => setLocked((value) => !value)}>{locked ? "Unlock to edit" : "Lock prompt"}</button>
            <button type="button" onClick={() => setPrompt(DEFAULT_PROMPT)}>Reset</button>
          </div></div>
          <div className={`prompt-wrap ${locked ? "locked" : ""}`}><textarea id="design-prompt" value={prompt} readOnly={locked} onChange={(event) => setPrompt(event.target.value)} />{locked && <span className="lock-label">Locked</span>}</div>
          <label htmlFor="additional">Additional requirements <span>Optional</span></label>
          <textarea id="additional" className="additional" value={additional} onChange={(event) => setAdditional(event.target.value)} placeholder="e.g. Year 10, 25 minutes, six questions, focus on interpretation, use a calm blue palette…" />
          <p className="precedence">Additional requirements override flexible choices in the design prompt. Output safety and editability always remain fixed.</p>
        </section>
      </div>

      {formError && <div className="alert error" role="alert">{formError}</div>}
      {job && <section className="job-panel" aria-live="polite">
        <div className="job-head"><div><p className="eyebrow">Generation status</p><h2>{job.status === "ready" ? "Your PowerPoints are ready" : job.status === "failed" ? "Generation needs attention" : job.status === "cancelled" ? "Generation cancelled" : job.stage}</h2></div><strong>{job.progress}%</strong></div>
        <div className="progress-track"><span style={{ width: `${job.progress}%` }} /></div>
        <div className="stage-list">{STAGES.map((stage, index) => <span className={STAGES.indexOf(job.stage) >= index ? "done" : ""} key={stage}>{stage}</span>)}</div>
        {job.error && <div className="alert error">{job.error}</div>}
        {job.warnings.length > 0 && <div className="alert warning"><strong>Completed with notes</strong>{job.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
        {job.status === "ready" && <div className="downloads">
          <button type="button" onClick={() => void downloadArtifact("setA")}>Download Set A</button><button type="button" onClick={() => void downloadArtifact("setB")}>Download Set B</button><button type="button" onClick={() => void downloadArtifact("answers")}>Download compiled answers</button><button type="button" className="zip" onClick={() => void downloadArtifact("bundle")}>Download all (.zip)</button>
        </div>}
        {busy && <button type="button" className="cancel" onClick={cancel}>Cancel generation</button>}
        {(job.status === "failed" || job.status === "cancelled") && <button type="button" className="retry" onClick={generate}>Retry with these files</button>}
      </section>}
      <section className="generate-bar"><div><strong>Three editable PowerPoints</strong><span>Set A · Set B · Compiled answers</span></div><button type="button" className="generate" disabled={!ready} onClick={generate}>{busy ? "Generating…" : "Generate PowerPoints"} <span>→</span></button></section>
    </main>
  );
}
