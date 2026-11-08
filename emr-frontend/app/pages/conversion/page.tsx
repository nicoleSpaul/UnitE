"use client";

import { useState } from "react";
import Papa from "papaparse";
import { TARGETS } from "@/lib/targets";
import { csvToFhir, type Mapping } from "@/lib/toFhirJson/csvToFhirJ";

type Row = Record<string, string>;

export default function ConversionPage() {
    const [fileName, setFileName] = useState("");
    const [headers, setHeaders] = useState<string[]>([]);
    const [rows, setRows] = useState<Row[]>([]);
    const [mapping, setMapping] = useState<Mapping>({});
    const [result, setResult] = useState<ReturnType<typeof csvToFhir> | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const shape = (v: string) => v.replace(/[A-Za-z]/g, "a").replace(/\d/g, "9");

    function onFile(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setFileName(file.name);
        setResult(null);
        setError("");
        Papa.parse<Row>(file, {
            header: true,
            skipEmptyLines: true,
            complete: (res) => {
                const h = res.meta.fields ?? [];
                setHeaders(h);
                setRows(res.data);
                setMapping(Object.fromEntries(h.map((c) => [c, null])));
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
                //if timeout show error and allow user to map manually
                //only send the structure and replace leters w "a"'s and numbers with "9"'s
                body: JSON.stringify({
                    headers,
                    sampleRows: rows.slice(0, 3).map((r) =>
                        Object.fromEntries(Object.entries(r).map(([k, v]) => [k, shape(v)]))
                    ),
                }),
            });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error ?? "Suggestion failed");
            const next: Mapping = { ...mapping };
            for (const m of data.mappings ?? []) {
                if (headers.includes(m.column) && (TARGETS as readonly string[]).includes(m.fhirPath)) {
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
        const blob = new Blob([JSON.stringify(result.bundle, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "bundle.fhir.json";
        a.click();
        URL.revokeObjectURL(a.href);
    }

    return (
        <div className="mx-auto max-w-4xl space-y-6 p-8">
            <h1 className="text-3xl">Convert CSV to FHIR</h1>

            <input type="file" accept=".csv" onChange={onFile} />

            {headers.length > 0 && (
                <>
                    <div className="space-y-2">
                        <div className="flex items-center gap-3">
                            <h2 className="text-xl">Map columns ({rows.length} rows in {fileName})</h2>
                            <button onClick={suggest} disabled={busy} className="rounded border px-3 py-1">
                                {busy ? "Asking Gemini..." : "Suggest mappings (Gemini)"}
                            </button>
                        </div>
                        <p className="text-sm text-gray-500">
                            Optional. Sends only the headers and 3 sample rows to Gemini. Use synthetic data only.
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
                                    {TARGETS.map((t) => (
                                        <option key={t} value={t}>{t}</option>
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
                    <button onClick={download} className="rounded border px-3 py-1">Download bundle</button>
                    <pre className="max-h-96 overflow-auto rounded bg-gray-100 p-3 text-xs text-black">
                        {JSON.stringify(result.bundle, null, 2)}
                    </pre>
                </div>
            )}
        </div>
    );
}