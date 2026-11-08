"use client";
 
import { useState, useRef, useEffect, useMemo } from "react";
 
const MAX_MB = 5;
type UploadResponse = { text?: string; error?: string };
 
// Models often wrap JSON in ```json fences. Strip them, then pretty-print if valid.
function formatOutput(raw: string): { text: string; isJson: boolean } {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return { text: JSON.stringify(JSON.parse(cleaned), null, 2), isJson: true };
  } catch {
    return { text: cleaned, isJson: false };
  }
}
 
export default function ImageConversion() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<"idle" | "uploading">("idle");
  const inputRef = useRef<HTMLInputElement>(null);
 
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);
 
  // Cleaned / pretty-printed version of the produced file
  const output = useMemo(() => (result ? formatOutput(result) : null), [result]);
 
  function handleFile(f: File | null | undefined) {
    setError("");
    setResult("");
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setError("That file isn't an image. Choose a PNG, JPG, GIF or WebP.");
      return;
    }
    if (f.size > MAX_MB * 1024 * 1024) {
      setError(`That image is over ${MAX_MB} MB. Choose a smaller one.`);
      return;
    }
    setFile(f);
    setPreview(URL.createObjectURL(f));
  }
 
  function clear() {
    setFile(null);
    setPreview(null);
    setError("");
    setResult("");
    setCopied(false);
    setStatus("idle");
    if (inputRef.current) inputRef.current.value = "";
  }
 
  async function upload() {
    if (!file) return;
    setStatus("uploading");
    setError("");
    setResult("");
    setCopied(false);
    try {
      const body = new FormData();
      body.append("image", file);
 
      const res = await fetch("/api/gemini/suggest-mapping-image", { method: "POST", body });
      const data: UploadResponse = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The upload failed.");
 
      setResult(data.text ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The upload failed. Try again.");
    } finally {
      setStatus("idle");
    }
  }
 
  function download() {
    if (!output) return;
    const baseName = file ? file.name.replace(/\.[^.]+$/, "") : "output";
    const ext = output.isJson ? "json" : "txt";
    const mime = output.isJson ? "application/fhir+json" : "text/plain";
    const blob = new Blob([output.text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
 
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}-fhir-r4.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
 
  async function copy() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy to the clipboard.");
    }
  }
 
  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-3xl bg-white rounded-b-sm border-4 border-slate-400 p-6">
        <h1 className="text-xl font-semibold text-slate-900">Upload an image</h1>
        <p className="text-sm text-slate-500 mt-1">
          PNG, JPG, GIF or WebP, up to {MAX_MB} MB.
        </p>
 
        {!file || !preview ? (
          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleFile(e.dataTransfer.files?.[0]);
            }}
            className={`mt-5 flex flex-col items-center justify-center text-center h-52 rounded-b-sm border-2 border-dashed cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
              dragging
                ? "border-indigo-500 bg-indigo-50"
                : "border-slate-300 hover:border-slate-400 bg-slate-50"
            }`}
          >
            <p className="text-sm font-medium text-slate-700">
              Drag an image here, or click to browse
            </p>
          </div>
        ) : (
          <div className="mt-5">
            <img
              src={preview}
              alt="Selected upload preview"
              className="w-full max-h-72 object-contain rounded-b-sm bg-slate-100"
            />
            <p className="text-sm text-slate-600 mt-3 truncate">
              {file.name}{" "}
              <span className="text-slate-400">({(file.size / 1024).toFixed(0)} KB)</span>
            </p>
          </div>
        )}
 
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
 
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}
 
        {file && (
          <div className="mt-5 flex gap-3">
            <button
              onClick={upload}
              disabled={status === "uploading"}
              className="flex-1 rounded-b-sm bg-indigo-600 text-white text-sm font-medium py-2.5 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              {status === "uploading" ? "Analyzing…" : "Convert To HL7 FHIR R4"}
            </button>
            <button
              onClick={clear}
              className="rounded-b-sm border border-slate-300 text-slate-700 text-sm font-medium px-4 py-2.5 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Remove
            </button>
          </div>
        )}
 
        {output && (
          <section
            aria-live="polite"
            className="mt-5 rounded-b-sm bg-slate-50 border border-slate-200 p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-900">
                {output.isJson ? "FHIR R4 output" : "Response"}
              </h2>
              <div className="flex gap-2">
                <button
                  onClick={copy}
                  className="rounded-b-sm border border-slate-300 text-slate-700 text-xs font-medium px-3 py-1.5 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  onClick={download}
                  className="rounded-b-sm bg-indigo-600 text-white text-xs font-medium px-3 py-1.5 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
                >
                  Download .{output.isJson ? "json" : "txt"}
                </button>
              </div>
            </div>
 
            {!output.isJson && (
              <p className="mt-2 text-xs text-amber-700">
                The response isn&apos;t valid JSON, so it will download as plain text.
              </p>
            )}
 
            <pre
              tabIndex={0}
              aria-label="Produced file preview"
              className="mt-3 max-h-96 overflow-auto rounded-b-sm bg-white border border-slate-200 p-3 text-xs leading-relaxed text-slate-800 font-mono whitespace-pre focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {output.text}
            </pre>
          </section>
        )}
      </div>
    </main>
  );
}