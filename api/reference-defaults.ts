import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import JSZip from "jszip";
import { authenticateRequest, rejectMethod, sendError } from "../server/cloud/http.js";

const names = ["Set A.pptx", "Set B.pptx", "Ans for Set A and B.pptx"];

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "GET") return rejectMethod(response, ["GET"]);
  try {
    await authenticateRequest(request);
    const files = await Promise.all(names.map(async (name) => {
      const path = join(process.cwd(), "assets", "templates", name);
      const zip = await JSZip.loadAsync(await readFile(path));
      const slides = Object.keys(zip.files).filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry)).length;
      return { name: basename(path), slides, size: (await stat(path)).size };
    }));
    response.setHeader("Cache-Control", "private, max-age=300");
    response.status(200).json({ files });
  } catch (error) { sendError(response, error); }
}
