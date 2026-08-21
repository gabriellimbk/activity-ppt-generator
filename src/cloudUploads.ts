import * as tus from "tus-js-client";
import { supabase, supabasePublishableKey, supabaseUrl } from "./supabase";

const bucket = "activity-inputs";
const resumableThreshold = 6 * 1024 * 1024;
const mimeByExtension: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const storageSafeName = (name: string) => name.replace(/[^A-Za-z0-9_\-.' ,!&$@=;:+?()]/g, "_").slice(0, 180);
export const acceptedMime = (file: File) => file.type || mimeByExtension[file.name.split(".").pop()?.toLowerCase() ?? ""] || "application/octet-stream";

export async function uploadCloudFile(file: File, path: string, onProgress?: (uploaded: number, total: number) => void, signal?: AbortSignal) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Your session has expired. Please sign in again.");
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  if (file.size <= resumableThreshold) {
    const { error } = await supabase.storage.from(bucket).upload(path, file, { contentType: acceptedMime(file), upsert: false, cacheControl: "3600" });
    if (error) throw error;
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    onProgress?.(file.size, file.size);
    return;
  }
  const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable`,
      headers: { authorization: `Bearer ${session.access_token}`, apikey: supabasePublishableKey, "x-upsert": "false" },
      metadata: { bucketName: bucket, objectName: path, contentType: acceptedMime(file), cacheControl: "3600" },
      chunkSize: 6 * 1024 * 1024,
      retryDelays: [0, 3000, 5000, 10_000, 20_000],
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      fingerprint: () => Promise.resolve(`${bucket}/${path}/${file.size}/${file.lastModified}`),
      onProgress,
      onError: reject,
      onSuccess: () => resolve(),
    });
    const abortUpload = () => { void upload.abort(true).finally(() => reject(new DOMException("Cancelled", "AbortError"))); };
    if (signal?.aborted) return abortUpload();
    signal?.addEventListener("abort", abortUpload, { once: true });
    void upload.findPreviousUploads().then((previous) => {
      if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    }).catch(reject);
  });
}

export async function removeCloudInputs(paths: string[]) {
  if (!supabase || !paths.length) return;
  await supabase.storage.from(bucket).remove(paths);
}
