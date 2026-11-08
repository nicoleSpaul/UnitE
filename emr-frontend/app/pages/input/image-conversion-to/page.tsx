"use client";

import { useState, useRef, useEffect } from "react";

const MAX_PDF_MB = 10; // matches MAX_PDF_BYTES on the server
const MAX_FHIR_MB = 2; // matches MAX_FHIR_BYTES on the server
type ErrorResponse = { error?: string };

type DropzoneProps = {
  title: string;
  hint: string;
  accept: string;
  dropLabel: string;
  selectedLabel: string;
  file: File | null;
  onSelect: (f: File | null | undefined) => void;
  onRemove: () => void;
};

function Dropzone({
  title,
  hint,
  accept,
  dropLabel,
  selectedLabel,
  file,
  onSelect,
  onRemove,
}: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function remove() {
    if (inputRef.current) inputRef.current.value = "";
    onRemove();
  }

  return (
    <div className="flex-1 min-w-0">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      <p className="text-xs text-slate-500 mt-0.5">{hint}</p>

      {!file ? (
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
            onSelect(e.dataTransfer.files?.[0]);
          }}
          className={`mt-3 flex flex-col items-center justify-center text-center h-52 rounded-b-sm border-2 border-dashed cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
            dragging
              ? "border-indigo-500 bg-indigo-50"
              : "border-slate-300 hover:border-slate-400 bg-slate-50"
          }`}
        >
          <p className="text-sm font-medium text-slate-700 px-4">{dropLabel}</p>
        </div>
      ) : (
        <div className="mt-3">
          <div className="flex items-center justify-center h-52 rounded-b-sm bg-slate-100">
            <span className="text-sm font-medium text-slate-600">{selectedLabel}</span>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-sm text-slate-600 truncate">
              {file.name}{" "}
              <span className="text-slate-400">({(file.size / 1024).toFixed(0)} KB)</span>
            </p>
            <button
              onClick={remove}
              className="shrink-0 rounded-b-sm border border-slate-300 text-slate-700 text-xs font-medium px-3 py-1.5 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => onSelect(e.target.files?.[0])}
      />
    </div>
  );
}

// Browsers often send an empty MIME type for .json / .xml, so check the extension too.
const FHIR_ACCEPT =
  ".json,.xml,application/fhir+json,application/json,application/fhir+xml,application/xml,text/xml";

function isJsonFile(f: File) {
  return f.name.toLowerCase().endsWith(".json") || f.type.includes("json");
}

function isXmlFile(f: File) {
  return f.name.toLowerCase().endsWith(".xml") || f.type.includes("xml");
}

// Same checks the server does, so users get feedback before uploading.
async function validateFhir(f: File): Promise<string | null> {
  if (!isJsonFile(f) && !isXmlFile(f)) {
    return "That file isn't FHIR JSON or XML. Choose a .json or .xml file.";
  }
  if (f.size > MAX_FHIR_MB * 1024 * 1024) {
    return `That FHIR file is over ${MAX_FHIR_MB} MB. Choose a smaller one.`;
  }
  const text = await f.text();
  if (isJsonFile(f)) {
    try {
      const obj = JSON.parse(text);
      if (typeof obj?.resourceType !== "string") {
        return 'That JSON has no "resourceType", so it doesn\'t look like a FHIR resource.';
      }
    } catch {
      return "That file isn't valid JSON.";
    }
  } else if (!/<[A-Za-z]+[^>]*xmlns="http:\/\/hl7\.org\/fhir"/.test(text)) {
    return "That XML is missing the http://hl7.org/fhir namespace.";
  }
  return null;
}

// The server sends the mapping as gzip -> base64 in the X-Field-Mapping header.
async function decodeMapping(b64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function FhirPdfConversion() {
  const [fhir, setFhir] = useState<File | null>(null);
  const [pdf, setPdf] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [mappingJson, setMappingJson] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "uploading">("idle");

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [resultUrl]);

  function clearResult() {
    setResultUrl(null);
    setMappingJson(null);
  }

  async function handleFhir(f: File | null | undefined) {
    setError("");
    clearResult();
    if (!f) return;
    const problem = await validateFhir(f);
    if (problem) {
      setError(problem);
      return;
    }
    setFhir(f);
  }

  function handlePdf(f: File | null | undefined) {
    setError("");
    clearResult();
    if (!f) return;
    if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) {
      setError("That file isn't a PDF. Choose a .pdf file.");
      return;
    }
    if (f.size > MAX_PDF_MB * 1024 * 1024) {
      setError(`That PDF is over ${MAX_PDF_MB} MB. Choose a smaller one.`);
      return;
    }
    setPdf(f);
  }

  function removeFhir() {
    setFhir(null);
    setError("");
    clearResult();
  }

  function removePdf() {
    setPdf(null);
    setError("");
    clearResult();
  }

  function clearAll() {
    removeFhir();
    removePdf();
    setStatus("idle");
  }

  async function upload() {
    if (!fhir || !pdf) return;
    setStatus("uploading");
    setError("");
    clearResult();
    try {
      const body = new FormData();
      body.append("fhir", fhir); // must match form.get("fhir")
      body.append("pdf", pdf); // must match form.get("pdf")

      const res = await fetch("/api/gemini/suggest-mapping-image-output", {
        method: "POST",
        body,
      });
      if (!res.ok) {
        const data: ErrorResponse = await res.json().catch(() => ({}));
        throw new Error(data.error || "The upload failed.");
      }

      const blob = await res.blob();
      const pdfBlob =
        blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" });

      const header = res.headers.get("X-Field-Mapping");
      setMappingJson(header ? await decodeMapping(header) : "No mapping was returned.");
      setResultUrl(URL.createObjectURL(pdfBlob));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The upload failed. Try again.");
    } finally {
      setStatus("idle");
    }
  }

  const baseName = pdf ? pdf.name.replace(/\.[^.]+$/, "") : "output";

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-6xl bg-white rounded-b-sm border-4 border-slate-400 p-6">
        <h1 className="text-xl font-semibold text-slate-900">Upload files</h1>
        <p className="text-sm text-slate-500 mt-1">
          Add a FHIR file (up to {MAX_FHIR_MB} MB) and a PDF form (up to {MAX_PDF_MB} MB).
        </p>

        <div className="mt-5 flex flex-col md:flex-row gap-6">
          <Dropzone
            title="HL7 FHIR R4 data"
            hint="JSON or XML (single resource or Bundle)"
            accept={FHIR_ACCEPT}
            dropLabel="Drag a FHIR .json or .xml file here, or click to browse"
            selectedLabel={fhir && isXmlFile(fhir) ? "FHIR XML selected" : "FHIR JSON selected"}
            file={fhir}
            onSelect={handleFhir}
            onRemove={removeFhir}
          />
          <Dropzone
            title="PDF form"
            hint="PDF document"
            accept="application/pdf,.pdf"
            dropLabel="Drag a PDF here, or click to browse"
            selectedLabel="PDF selected"
            file={pdf}
            onSelect={handlePdf}
            onRemove={removePdf}
          />
        </div>

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}

        {(fhir || pdf) && (
          <div className="mt-5 flex gap-3">
            <button
              onClick={upload}
              disabled={!fhir || !pdf || status === "uploading"}
              className="flex-1 rounded-b-sm bg-indigo-600 text-white text-sm font-medium py-2.5 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              {status === "uploading" ? "Analyzing…" : "Fill PDF from FHIR data"}
            </button>
            <button
              onClick={clearAll}
              className="rounded-b-sm border border-slate-300 text-slate-700 text-sm font-medium px-4 py-2.5 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Remove all
            </button>
          </div>
        )}

        {resultUrl && (
          <section aria-live="polite" className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="min-w-0 rounded-b-sm bg-slate-50 border border-slate-200 p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-slate-900">Filled PDF</h2>
                <a
                  href={resultUrl}
                  download={`${baseName}-filled.pdf`}
                  className="rounded-b-sm bg-indigo-600 text-white text-xs font-medium px-3 py-1.5 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
                >
                  Download .pdf
                </a>
              </div>
              <iframe
                src={resultUrl}
                title="Filled PDF preview"
                className="mt-3 w-full h-[40rem] rounded-b-sm bg-white border border-slate-200"
              />
            </div>

            <div className="min-w-0 rounded-b-sm bg-slate-50 border border-slate-200 p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-slate-900">Field mapping (JSON)</h2>
                <button
                  onClick={() =>
                    mappingJson &&
                    saveBlob(
                      new Blob([mappingJson], { type: "application/json" }),
                      `${baseName}-mapping.json`
                    )
                  }
                  className="rounded-b-sm bg-indigo-600 text-white text-xs font-medium px-3 py-1.5 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
                >
                  Download .json
                </button>
              </div>
              <pre className="mt-3 w-full h-[40rem] overflow-auto rounded-b-sm bg-white border border-slate-200 p-3 text-xs text-slate-800 whitespace-pre-wrap break-words">
                {mappingJson}
              </pre>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}