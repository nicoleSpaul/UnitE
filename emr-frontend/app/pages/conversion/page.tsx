"use client";

import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import { TARGET_BY_ID, TARGET_LIST, EXTENSION } from "@/lib/targets";
import { guessMapping } from "@/lib/guessMapping";
import { FORMATS, acceptFor, detectFormat, type FormatId } from "@/lib/formats";
import type { FhirBundle } from "@/lib/types";
import {
    loadTemplates, saveTemplates, sanitizeTemplates, matchTemplate, applyTemplate, type Template,
} from "@/lib/templates";
import {
    blankExportTemplate, loadExportTemplates, saveExportTemplates, sanitizeExportTemplates,
    type ExportTemplate,
} from "@/lib/exportTemplates";
import { csvToFhir, type Mapping } from "@/lib/toFhirJson/csvToFhirJ";
import { buildCsvTable } from "@/lib/fromFhirJson/fhirJToCsv";
import { fhirToCustom } from "@/lib/fromFhirJson/fhirJToCustom";
import ExportTemplateEditor, { type SourceGroup } from "@/app/components/ExportTemplateEditor";

type Row = Record<string, string>;
type Src = { name: string; text: string };
type Conversion = {
    bundle: object;
    report: { rows: number; resources: number; unmapped: string[]; warnings: string[] };
};
type Output = { blob: Blob; filename: string; notes: string[] } | { error: string } | null;

const KINDS = ["Patient", "Condition", "MedicationStatement", "Observation", "AllergyIntolerance"] as const;
const MAX_BYTES = 10 * 1024 * 1024;
const PREVIEW_CHARS = 4000;

// letters become "a", digits become "9", so Gemini sees structure but never patient content
const shape = (v: string) => v.replace(/[A-Za-z]/g, "a").replace(/\d/g, "9");
const labelOf = (id: FormatId) => FORMATS.find((f) => f.id === id)?.label ?? id;
const entryCount = (b: object) => (b as { entry?: unknown[] }).entry?.length ?? 0;
const preview = (t: string) =>
    t.length > PREVIEW_CHARS
        ? `${t.slice(0, PREVIEW_CHARS)}\n… (${(t.length - PREVIEW_CHARS).toLocaleString()} more characters)`
        : t;

export default function ConversionPage() {
    const [from, setFrom] = useState<FormatId | "auto">("auto");
    const [outFormat, setOutFormat] = useState<string>("fhir-json");
    const [src, setSrc] = useState<Src | null>(null);
    const [detected, setDetected] = useState<FormatId | null>(null);
    const [notices, setNotices] = useState<string[]>([]);
    const [dragging, setDragging] = useState(false);

    const [headers, setHeaders] = useState<string[]>([]);
    const [rows, setRows] = useState<Row[]>([]);
    const [mapping, setMapping] = useState<Mapping>({});
    const [result, setResult] = useState<Conversion | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [outText, setOutText] = useState("");

    const [templates, setTemplates] = useState<Template[]>([]);
    const [tplName, setTplName] = useState("");
    const [tplNote, setTplNote] = useState("");
    const [exportList, setExportList] = useState<ExportTemplate[]>([]);
    const [draft, setDraft] = useState<ExportTemplate | null>(null);

    useEffect(() => {
        setTemplates(loadTemplates());
        setExportList(loadExportTemplates());
    }, []);

    function persist(next: Template[]) {
        setTemplates(next);
        saveTemplates(next);
    }

    function persistExport(next: ExportTemplate[]) {
        setExportList(next);
        saveExportTemplates(next);
    }

    // ---------- mapping templates (unchanged) ----------
    function saveTemplate() {
        const name = tplName.trim();
        if (!name) return;
        persist([
            ...templates.filter((t) => t.name !== name),
            { id: crypto.randomUUID(), name, mapping: { ...mapping }, savedAt: new Date().toISOString() },
        ]);
        setTplName("");
        setTplNote(`Saved template "${name}"`);
    }

    function applySaved(id: string) {
        const t = templates.find((x) => x.id === id);
        if (!t) return;
        setMapping(applyTemplate(headers, t, guessMapping(headers)));
        setTplNote(`Applied template "${t.name}"`);
    }

    function deleteTemplate(id: string) {
        persist(templates.filter((t) => t.id !== id));
    }

    // one file holds both kinds of template
    function downloadTemplates() {
        const body = { format: "emr-unifier-templates", version: 1, templates, exportTemplates: exportList };
        const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "emr-templates.json";
        a.click();
        URL.revokeObjectURL(a.href);
    }

    async function importTemplates(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const json: unknown = JSON.parse(await file.text());
            const hasMapping = Array.isArray(json) || Array.isArray((json as { templates?: unknown } | null)?.templates);
            const hasExport = Array.isArray((json as { exportTemplates?: unknown } | null)?.exportTemplates);
            if (!hasMapping && !hasExport) throw new Error("not a template file");

            const msgs: string[] = [];
            if (hasMapping) {
                const { templates: incoming, notes } = sanitizeTemplates(json);
                const names = new Set(incoming.map((t) => t.name));
                persist([...templates.filter((t) => !names.has(t.name)), ...incoming]);
                msgs.push(`Imported ${incoming.length} mapping template(s).`, ...notes);
            }
            if (hasExport) {
                const { templates: incoming, notes } = sanitizeExportTemplates(json);
                const names = new Set(incoming.map((t) => t.name));
                persistExport([...exportList.filter((t) => !names.has(t.name)), ...incoming]);
                msgs.push(`Imported ${incoming.length} export template(s).`, ...notes);
            }
            setTplNote(msgs.join(" "));
        } catch {
            setTplNote("That file isn't a valid template file.");
        }
        e.target.value = "";
    }

    // ---------- loading and converting the input file ----------
    function process(name: string, text: string, fromId: FormatId | "auto") {
        setError("");
        setResult(null);
        setHeaders([]);
        setRows([]);
        setTplNote("");

        const guess = detectFormat(name, text);
        setDetected(guess);
        const notes: string[] = [];
        if (fromId !== "auto" && guess && guess !== fromId) {
            notes.push(`This file looks like ${labelOf(guess)}, but ${labelOf(fromId)} is selected.`);
        }
        setNotices(notes);

        const id = fromId === "auto" ? guess : fromId;
        if (!id) {
            setError("Couldn't tell what format this file is. Choose one under Convert from.");
            return;
        }
        const fmt = FORMATS.find((f) => f.id === id);
        if (!fmt || !fmt.canImport) {
            setError(`${fmt?.label ?? id} import isn't built yet.`);
            return;
        }

        if (id === "csv") {
            const res = Papa.parse<Row>(text, { header: true, skipEmptyLines: true });
            const h = res.meta.fields ?? [];
            if (h.length === 0) {
                setError("No columns found. Does the CSV have a header row?");
                return;
            }
            const base = guessMapping(h);
            const hit = matchTemplate(h, templates);
            setHeaders(h);
            setRows(res.data);
            if (hit) {
                setMapping(applyTemplate(h, hit.template, base));
                setTplNote(`Applied saved template "${hit.template.name}" (${Math.round(hit.score * 100)}% header match)`);
            } else {
                setMapping(base);
            }
            return;
        }

        if (!fmt.importer) return;
        const { bundle, notes: importNotes, patients } = fmt.importer(text);
        setResult({
            bundle,
            report: { rows: patients, resources: entryCount(bundle), unmapped: [], warnings: importNotes },
        });
    }

    async function handleFile(file: File) {
        if (file.size > MAX_BYTES) {
            setError("That file is over 10 MB. Try a smaller one.");
            return;
        }
        const text = await file.text();
        setSrc({ name: file.name, text });
        process(file.name, text, from);
    }

    function onPick(e: React.ChangeEvent<HTMLInputElement>) {
        const f = e.target.files?.[0];
        if (f) void handleFile(f);
        e.target.value = "";
    }

    function changeFrom(id: FormatId | "auto") {
        setFrom(id);
        if (src) process(src.name, src.text, id);
    }

    // ---------- Gemini suggestions (unchanged) ----------
    async function suggest() {
        setBusy(true);
        setError("");
        try {
            const r = await fetch("/api/gemini/suggest-mapping", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: AbortSignal.timeout(20000),
                // if it times out, an error shows and the user can map manually
                body: JSON.stringify({
                    headers,
                    sampleRows: rows.slice(0, 3).map((row) =>
                        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, shape(v)]))
                    ),
                }),
            });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error ?? "Suggestion failed");
            const next: Mapping = { ...mapping };
            for (const m of data.mappings ?? []) {
                if (headers.includes(m.column) && TARGET_LIST.some((t) => t.id === m.fhirPath && !t.perColumn)) {
                    next[m.column] = m.fhirPath;
                }
            }
            setMapping(next);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Suggestion failed");
        } finally {
            setBusy(false);
        }
    }

    // ---------- output side ----------
    function changeOut(v: string) {
        setOutFormat(v);
        if (v === "custom:new") {
            setDraft(blankExportTemplate());
        } else if (v.startsWith("custom:")) {
            const t = exportList.find((x) => x.id === v.slice(7));
            setDraft(t ? { ...t, columns: t.columns.map((c) => ({ ...c })) } : null);
        } else {
            setDraft(null);
        }
    }

    function saveDraft() {
        if (!draft) return;
        const t: ExportTemplate = {
            ...draft,
            name: draft.name.trim() || "My export",
            savedAt: new Date().toISOString(),
        };
        persistExport([...exportList.filter((x) => x.id !== t.id), t]);
        setDraft(t);
        setOutFormat(`custom:${t.id}`);
    }

    function deleteDraft() {
        if (!draft) return;
        persistExport(exportList.filter((x) => x.id !== draft.id));
        setDraft(null);
        setOutFormat("fhir-json");
    }

    // the converted file, rebuilt whenever the result, the target format or the custom template changes
    const output = useMemo<Output>(() => {
        if (!result) return null;
        const baseName = (src?.name ?? "converted").replace(/(\.fhir)?\.[^.]+$/, "") || "converted";
        const bundle = result.bundle as unknown as FhirBundle;
        try {
            if (outFormat.startsWith("custom:")) {
                return draft ? fhirToCustom(bundle, baseName, draft) : null;
            }
            const fmt = FORMATS.find((f) => f.id === outFormat);
            if (!fmt?.exporter) return { error: `${fmt?.label ?? outFormat} export isn't built yet.` };
            return fmt.exporter(bundle, baseName);
        } catch (e) {
            return { error: e instanceof Error ? e.message : "Export failed" };
        }
    }, [result, outFormat, draft, src]);

    useEffect(() => {
        let cancelled = false;
        const blob = output && "blob" in output ? output.blob : null;
        (async () => {
            const t = await (blob ? blob.text() : Promise.resolve(""));
            if (!cancelled) setOutText(t);
        })();
        return () => { cancelled = true; };
    }, [output]);

    // fields a custom template can pick from: the built-in targets plus any kept columns in this file
    const extCols = useMemo(() => {
        if (!result) return [] as string[];
        return buildCsvTable(result.bundle as unknown as FhirBundle).cols.filter((c) => !TARGET_BY_ID.has(c));
    }, [result]);

    const groups = useMemo<SourceGroup[]>(
        () => [
            ...KINDS.map((kind) => ({
                label: kind,
                options: TARGET_LIST.filter((t) => t.on === kind && !t.perColumn).map((t) => ({ id: t.id, label: t.label })),
            })),
            ...(extCols.length ? [{ label: "Kept columns", options: extCols.map((c) => ({ id: c, label: c })) }] : []),
        ],
        [extCols]
    );

    function download() {
        if (!output || !("blob" in output)) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(output.blob);
        a.download = output.filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    const canDownload = !!output && "blob" in output;
    const fromCsv = headers.length > 0;

    return (
        <div className="mx-auto max-w-6xl space-y-6 p-8">
            <h1 className="text-3xl">Convert health records</h1>

            <div className="grid items-start gap-4 md:grid-cols-[1fr_auto_1fr]">
                {/* ---------- FROM ---------- */}
                <section className="space-y-3 rounded border p-4">
                    <label htmlFor="from" className="block text-sm font-semibold">Convert from</label>
                    <select
                        id="from"
                        className="w-full rounded border p-2"
                        value={from}
                        onChange={(e) => changeFrom(e.target.value as FormatId | "auto")}
                    >
                        <option value="auto">Auto-detect</option>
                        {FORMATS.map((f) => (
                            <option key={f.id} value={f.id} disabled={!f.canImport}>
                                {f.label}
                                {f.hint ? ` (${f.hint})` : ""}
                                {!f.canImport ? " (coming soon)" : ""}
                            </option>
                        ))}
                    </select>

                    <label
                        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded border-2 border-dashed p-6 text-center ${dragging ? "border-black bg-gray-100 text-black" : ""
                            }`}
                        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={(e) => {
                            e.preventDefault();
                            setDragging(false);
                            const f = e.dataTransfer.files?.[0];
                            if (f) void handleFile(f);
                        }}
                    >
                        <span className="text-sm">Drop a file here or</span>
                        <span className="rounded border px-3 py-1">Choose file</span>
                        <input type="file" className="hidden" accept={acceptFor(from)} onChange={onPick} />
                    </label>

                    {src && (
                        <p className="text-sm">
                            {src.name}
                            {from === "auto" && detected ? ` · detected ${labelOf(detected)}` : ""}
                        </p>
                    )}

                    <h3 className="text-sm font-semibold">File preview</h3>
                    <pre className="min-h-40 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-gray-100 p-3 text-xs text-black">
                        {src ? preview(src.text) : "Choose a file to see a preview."}
                    </pre>

                    {error && <p className="text-red-600">{error}</p>}
                    {notices.map((n, i) => (
                        <p key={i} className="text-sm text-amber-600">{n}</p>
                    ))}
                    {result && (
                        <div className="space-y-1 text-sm">
                            <p>
                                {result.report.resources} resources{" "}
                                {fromCsv ? `from ${result.report.rows} rows.` : `for ${result.report.rows} patient(s).`}
                                {result.report.unmapped.length > 0 && ` Skipped columns: ${result.report.unmapped.join(", ")}.`}
                            </p>
                            {result.report.warnings.map((w, i) => (
                                <p key={i} className="text-amber-600">{w}</p>
                            ))}
                        </div>
                    )}
                </section>

                <div className="hidden self-center text-3xl md:block" aria-hidden="true">→</div>

                {/* ---------- TO ---------- */}
                <section className="space-y-3 rounded border p-4">
                    <label htmlFor="to" className="block text-sm font-semibold">Convert to</label>
                    <select
                        id="to"
                        className="w-full rounded border p-2"
                        value={outFormat}
                        onChange={(e) => changeOut(e.target.value)}
                    >
                        {FORMATS.map((f) => (
                            <option key={f.id} value={f.id} disabled={!f.exporter}>
                                {f.label}
                                {f.hint ? ` (${f.hint})` : ""}
                                {!f.exporter ? " (coming soon)" : ""}
                            </option>
                        ))}
                        <optgroup label="Custom templates">
                            {exportList.map((t) => (
                                <option key={t.id} value={`custom:${t.id}`}>{t.name}</option>
                            ))}
                            <option value="custom:new">+ New custom template…</option>
                        </optgroup>
                    </select>

                    <div className="rounded border-2 border-dashed p-6 text-center text-sm">
                        <button
                            onClick={download}
                            disabled={!canDownload}
                            className="rounded border px-3 py-1 disabled:opacity-50"
                        >
                            Download
                        </button>
                        <p className="mt-2 text-xs text-gray-500">
                            {output && "blob" in output ? output.filename : "Your converted file will appear here"}
                        </p>
                    </div>

                    <h3 className="text-sm font-semibold">Output preview</h3>
                    <pre className="min-h-40 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-gray-100 p-3 text-xs text-black">
                        {!result
                            ? fromCsv
                                ? "Map your columns below, then click Convert."
                                : "Converted output appears here."
                            : output && "error" in output
                                ? output.error
                                : preview(outText)}
                    </pre>

                    {output && "notes" in output && output.notes.map((n, i) => (
                        <p key={i} className="text-sm text-amber-600">{n}</p>
                    ))}
                </section>
            </div>

            {/* ---------- templates: import / export (unchanged look) ---------- */}
            <div className="flex items-center gap-3 text-sm">
                <label className="cursor-pointer rounded border px-3 py-1">
                    Import templates
                    <input type="file" accept=".json" onChange={importTemplates} className="hidden" />
                </label>
                <button
                    onClick={downloadTemplates}
                    disabled={templates.length + exportList.length === 0}
                    className="rounded border px-3 py-1"
                >
                    Export templates ({templates.length + exportList.length})
                </button>
            </div>
            {!fromCsv && tplNote && <p className="text-sm text-green-700">{tplNote}</p>}

            {/* ---------- CSV mapping (unchanged) ---------- */}
            {fromCsv && (
                <>
                    <div className="space-y-2 rounded border p-3">
                        <h3 className="font-semibold">Mapping templates</h3>
                        {tplNote && <p className="text-sm text-green-700">{tplNote}</p>}
                        <div className="flex flex-wrap items-center gap-2">
                            <select
                                className="rounded border p-1"
                                value=""
                                onChange={(e) => e.target.value && applySaved(e.target.value)}
                            >
                                <option value="">Apply a saved template...</option>
                                {templates.map((t) => (
                                    <option key={t.id} value={t.id}>{t.name}</option>
                                ))}
                            </select>
                            <input
                                className="rounded border p-1"
                                placeholder="Template name"
                                value={tplName}
                                onChange={(e) => setTplName(e.target.value)}
                            />
                            <button onClick={saveTemplate} disabled={!tplName.trim()} className="rounded border px-3 py-1">
                                Save current mapping
                            </button>
                        </div>
                        {templates.length > 0 && (
                            <ul className="text-sm">
                                {templates.map((t) => (
                                    <li key={t.id} className="flex items-center gap-2">
                                        <span>{t.name}</span>
                                        <button onClick={() => deleteTemplate(t.id)} className="text-red-600" aria-label={`Delete ${t.name}`}>
                                            ✕
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center gap-3">
                            <h2 className="text-xl">Map columns ({rows.length} rows in {src?.name})</h2>
                            <button onClick={suggest} disabled={busy} className="rounded border px-3 py-1">
                                {busy ? "Asking Gemini..." : "Suggest mappings (Gemini)"}
                            </button>
                        </div>
                        <p className="text-sm text-gray-500">
                            Optional. Sends only the headers and masked sample shapes (letters become &quot;a&quot;, digits become &quot;9&quot;) to Gemini.
                        </p>
                        {headers.map((h) => (
                            <div key={h} className="flex items-center gap-3">
                                <span className="w-48 truncate font-mono">{h}</span>
                                <select
                                    className="rounded border p-1"
                                    value={mapping[h] ?? ""}
                                    onChange={(e) => setMapping({ ...mapping, [h]: e.target.value || null })}
                                >
                                    <option value="">(skip)</option>
                                    <option value={EXTENSION}>Keep as extension (don&apos;t lose it)</option>
                                    {KINDS.map((kind) => (
                                        <optgroup key={kind} label={kind}>
                                            {TARGET_LIST.filter((t) => t.on === kind).map((t) => (
                                                <option key={t.id} value={t.id}>{t.label}</option>
                                            ))}
                                        </optgroup>
                                    ))}
                                </select>
                            </div>
                        ))}
                    </div>

                    <button
                        onClick={() => setResult(csvToFhir(rows, mapping))}
                        className="rounded bg-black px-4 py-2 text-white"
                    >
                        Convert
                    </button>
                </>
            )}

            {/* ---------- custom export template editor ---------- */}
            {draft && (
                <ExportTemplateEditor
                    draft={draft}
                    groups={groups}
                    saved={exportList.some((t) => t.id === draft.id)}
                    onChange={setDraft}
                    onSave={saveDraft}
                    onDelete={deleteDraft}
                />
            )}
        </div>
    );
}