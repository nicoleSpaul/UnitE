"use client";

import { useEffect, useState } from "react";
import Papa from "papaparse";
import { TARGET_LIST, EXTENSION } from "@/lib/targets";
import { guessMapping } from "@/lib/guessMapping";
import { IMPORTERS, ACCEPT } from "@/lib/importers";
import { EXPORTERS } from "@/lib/exporters";
import type { FhirBundle } from "@/lib/types";
import {
    loadTemplates, saveTemplates, sanitizeTemplates, matchTemplate, applyTemplate, type Template,
} from "@/lib/templates";
import { csvToFhir, type Mapping } from "@/lib/toFhirJson/csvToFhirJ";

type Row = Record<string, string>;

const KINDS = ["Patient", "Condition", "MedicationStatement", "Observation", "AllergyIntolerance"] as const;

// letters become "a", digits become "9", so Gemini sees structure but never patient content
const shape = (v: string) => v.replace(/[A-Za-z]/g, "a").replace(/\d/g, "9");

export default function ConversionPage() {
    const [fileName, setFileName] = useState("");
    const [headers, setHeaders] = useState<string[]>([]);
    const [rows, setRows] = useState<Row[]>([]);
    const [mapping, setMapping] = useState<Mapping>({});
    const [result, setResult] = useState<ReturnType<typeof csvToFhir> | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [outFormat, setOutFormat] = useState("json");
    const [exportNotes, setExportNotes] = useState<string[]>([]);

    const [templates, setTemplates] = useState<Template[]>([]);
    const [tplName, setTplName] = useState("");
    const [tplNote, setTplNote] = useState("");

    useEffect(() => { setTemplates(loadTemplates()); }, []);

    function persist(next: Template[]) {
        setTemplates(next);
        saveTemplates(next);
    }

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

    function exportTemplates() {
        const body = { format: "emr-unifier-templates", version: 1, templates };
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
            const { templates: incoming, notes } = sanitizeTemplates(JSON.parse(await file.text()));
            const names = new Set(incoming.map((t) => t.name));
            persist([...templates.filter((t) => !names.has(t.name)), ...incoming]);
            setTplNote([`Imported ${incoming.length} template(s).`, ...notes].join(" "));
        } catch {
            setTplNote("That file isn't a valid template file.");
        }
        e.target.value = "";
    }

    async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setFileName(file.name);
        setResult(null);
        setError("");
        setExportNotes([]);

        // non-CSV formats: parse straight to a Bundle, no mapping step
        const ext = file.name.split(".").pop()?.toLowerCase();
        const importer = ext ? IMPORTERS[ext] : undefined;
        if (importer) {
            const { bundle, notes, patients } = importer(await file.text());
            setHeaders([]);
            setRows([]);
            setTplNote("");
            setResult({
                bundle,
                report: {
                    rows: patients,
                    resources: (bundle as { entry: unknown[] }).entry.length,
                    unmapped: [],
                    warnings: notes,
                },
            } as unknown as ReturnType<typeof csvToFhir>);
            return;
        }

        // CSV: parse to rows, then the mapping screen
        Papa.parse<Row>(file, {
            header: true,
            skipEmptyLines: true,
            complete: (res) => {
                const h = res.meta.fields ?? [];
                const base = guessMapping(h);
                const hit = matchTemplate(h, templates);
                setHeaders(h);
                setRows(res.data);
                if (hit) {
                    setMapping(applyTemplate(h, hit.template, base));
                    setTplNote(`Applied saved template "${hit.template.name}" (${Math.round(hit.score * 100)}% header match)`);
                } else {
                    setMapping(base);
                    setTplNote("");
                }
            },
        });
    }

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

    function download() {
        if (!result) return;
        const baseName = fileName.replace(/(\.fhir)?\.[^.]+$/, "") || "converted";
        const out = EXPORTERS[outFormat].run(result.bundle as unknown as FhirBundle, baseName);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(out.blob);
        a.download = out.filename;
        a.click();
        URL.revokeObjectURL(a.href);
        setExportNotes(out.notes);
    }

    return (
        <div className="mx-auto max-w-4xl space-y-6 p-8">
            <h1 className="text-3xl">Convert health records</h1>

            <input type="file" accept={ACCEPT} onChange={onFile} />

            <div className="flex items-center gap-3 text-sm">
                <label className="cursor-pointer rounded border px-3 py-1">
                    Import templates
                    <input type="file" accept=".json" onChange={importTemplates} className="hidden" />
                </label>
                <button onClick={exportTemplates} disabled={templates.length === 0} className="rounded border px-3 py-1">
                    Export templates ({templates.length})
                </button>
            </div>

            {headers.length > 0 && (
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
                            <h2 className="text-xl">Map columns ({rows.length} rows in {fileName})</h2>
                            <button onClick={suggest} disabled={busy} className="rounded border px-3 py-1">
                                {busy ? "Asking Gemini..." : "Suggest mappings (Gemini)"}
                            </button>
                        </div>
                        <p className="text-sm text-gray-500">
                            Optional. Sends only the headers and masked sample shapes (letters become "a", digits become "9") to Gemini.
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

            {error && <p className="text-red-600">{error}</p>}

            {result && (
                <div className="space-y-3">
                    <p>
                        {result.report.resources} resources from {result.report.rows} rows.
                        {result.report.unmapped.length > 0 && ` Skipped columns: ${result.report.unmapped.join(", ")}.`}
                    </p>
                    {result.report.warnings.map((w, i) => (
                        <p key={i} className="text-amber-600">{w}</p>
                    ))}
                    <div className="flex items-center gap-3">
                        <select
                            className="rounded border p-1"
                            value={outFormat}
                            onChange={(e) => setOutFormat(e.target.value)}
                        >
                            {Object.entries(EXPORTERS).map(([key, x]) => (
                                <option key={key} value={key}>{x.label}</option>
                            ))}
                        </select>
                        <button onClick={download} className="rounded border px-3 py-1">Download</button>
                    </div>
                    {exportNotes.map((n, i) => (
                        <p key={i} className="text-amber-600">{n}</p>
                    ))}
                    <pre className="max-h-96 overflow-auto rounded bg-gray-100 p-3 text-xs text-black">
                        {JSON.stringify(result.bundle, null, 2)}
                    </pre>
                </div>
            )}
        </div>
    );
}