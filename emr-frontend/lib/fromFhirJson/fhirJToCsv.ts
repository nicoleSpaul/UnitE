import Papa from "papaparse";
import { EXT_URL, KINDS, TARGET_LIST, type ResourceKind } from "../targets";
import type { ExportResult, FhirBundle, FhirResource } from "../types";

type Row = Record<string, string>;

const BASE_COLS = TARGET_LIST.filter((t) => !t.perColumn).map((t) => t.id);
const STRUCTURAL = ["resourceType", "id", "meta", "text", "subject", "patient"];

// top-level keys the CSV can represent, per resource type
const COVERED = new Map<string, Set<string>>(
    (Object.keys(KINDS) as ResourceKind[]).map((kind) => {
        const s = new Set<string>(STRUCTURAL);
        for (const t of TARGET_LIST) if (t.on === kind) t.covers.forEach((k) => s.add(k));
        return [kind, s] as [string, Set<string>];
    })
);

const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

const extName = (url: string) => {
    const s = url.slice(EXT_URL.length);
    try { return decodeURIComponent(s); } catch { return s; }
};

export function fhirToCsv(bundle: FhirBundle, baseName: string): ExportResult {
    const resources = (bundle.entry ?? [])
        .map((e) => e.resource)
        .filter((r): r is FhirResource => !!r);
    const notes: string[] = [];
    const dropped = new Map<string, number>();      // fields with no column
    const extra = new Map<string, number>();        // repeated entries beyond the first
    const skippedTypes = new Map<string, number>(); // whole resource types
    const extCols = new Set<string>();

    // 1. audit what the CSV cannot hold, and find kept-column extensions
    for (const r of resources) {
        const cov = COVERED.get(r.resourceType);
        if (!cov) continue;
        for (const [k, v] of Object.entries(r)) {
            if (k === "extension") {
                const list = Array.isArray(v) ? (v as { url?: string }[]) : [];
                for (const e of list) {
                    if (typeof e.url === "string" && e.url.startsWith(EXT_URL)) extCols.add(extName(e.url));
                    else bump(dropped, `${r.resourceType}.extension`);
                }
                continue;
            }
            if (!cov.has(k)) { bump(dropped, `${r.resourceType}.${k}`); continue; }
            if (Array.isArray(v) && v.length > 1) bump(extra, `${r.resourceType}.${k}`, v.length - 1);
        }
    }

    const cols = [...BASE_COLS, ...[...extCols].filter((c) => !BASE_COLS.includes(c))];
    const blank = (): Row => Object.fromEntries(cols.map((c) => [c, ""]));
    const fill = (row: Row, r: FhirResource) => {
        for (const t of TARGET_LIST) if (t.on === r.resourceType && !t.perColumn) row[t.id] = t.get(r);
    };

    // 2. patient rows
    const patients = new Map<string, Row>();
    for (const r of resources) {
        if (r.resourceType !== "Patient") continue;
        const row = blank();
        fill(row, r);
        const ext = Array.isArray(r.extension) ? (r.extension as { url?: string; valueString?: string }[]) : [];
        for (const e of ext) {
            if (typeof e.url === "string" && e.url.startsWith(EXT_URL) && e.valueString) {
                const name = extName(e.url);
                row[name] = row[name] ? `${row[name]} | ${e.valueString}` : e.valueString;
            }
        }
        patients.set(r.id, row);
    }
    if (patients.size === 0) notes.push("No Patient resources found");

    // 3. one row per clinical item, patient columns repeated
    const rows: Row[] = [];
    const withRow = new Set<string>();
    let orphans = 0;
    for (const r of resources) {
        if (r.resourceType === "Patient") continue;
        if (!COVERED.has(r.resourceType)) { bump(skippedTypes, r.resourceType); continue; }
        const refObj = (r.subject ?? r.patient) as { reference?: string } | undefined;
        const ref = (refObj?.reference ?? "").replace(/^Patient\//, "");
        const base = patients.get(ref);
        const row = base ? { ...base } : blank();
        fill(row, r);
        if (base) withRow.add(ref); else orphans++;
        rows.push(row);
    }
    for (const [id, row] of patients) if (!withRow.has(id)) rows.push(row);

    // 4. the loss report
    for (const [t, c] of skippedTypes) notes.push(`Dropped ${c} ${t} resource(s): the CSV has no columns for them`);
    if (dropped.size) notes.push("Dropped fields: " + [...dropped].map(([k, c]) => `${k} ×${c}`).join(", "));
    if (extra.size) notes.push("Only the first entry was kept for: " + [...extra].map(([k, c]) => `${k} (${c} more)`).join(", "));
    if (orphans) notes.push(`${orphans} item(s) had no matching Patient, exported with blank patient columns`);

    const csv = Papa.unparse(rows, { columns: cols });
    return {
        blob: new Blob([csv], { type: "text/csv;charset=utf-8" }),
        filename: `${baseName}.csv`,
        notes,
    };
}