import Papa from "papaparse";
import { DELIMITERS, type ExportTemplate } from "../exportTemplates";
import type { ExportResult, FhirBundle } from "../types";
import { buildCsvTable } from "./fhirJToCsv";

const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "custom";

export function fhirToCustom(bundle: FhirBundle, baseName: string, tpl: ExportTemplate): ExportResult {
    const { cols, rows, notes } = buildCsvTable(bundle);
    const fmt = DELIMITERS.find((d) => d.value === tpl.delimiter) ?? DELIMITERS[0];
    const filename = `${baseName}-${slug(tpl.name)}.${fmt.ext}`;
    const mime = fmt.ext === "tsv" ? "text/tab-separated-values;charset=utf-8" : "text/plain;charset=utf-8";

    if (tpl.columns.length === 0) {
        return {
            blob: new Blob([""], { type: mime }),
            filename,
            notes: ["This template has no columns yet: add some to see output"],
        };
    }

    const have = new Set(cols);
    const header = tpl.columns.map((c) => c.header || c.source);

    // rows that look identical after choosing columns are merged (e.g. patient-only templates)
    const seen = new Set<string>();
    const data: string[][] = [];
    for (const row of rows) {
        const cells = tpl.columns.map((c) => (have.has(c.source) ? row[c.source] ?? "" : ""));
        const key = JSON.stringify(cells);
        if (seen.has(key)) continue;
        seen.add(key);
        data.push(cells);
    }

    // template-specific loss report
    const out = [...notes];
    const used = new Set(tpl.columns.map((c) => c.source));
    const missing = tpl.columns.filter((c) => !have.has(c.source)).map((c) => c.header || c.source);
    const unused = cols.filter((c) => !used.has(c) && rows.some((r) => (r[c] ?? "") !== ""));
    const merged = rows.length - data.length;

    if (missing.length) out.push(`Left empty (no such data in this file): ${missing.join(", ")}`);
    if (unused.length) {
        const shown = unused.slice(0, 12).join(", ");
        out.push(`Columns with data that this template leaves out: ${shown}${unused.length > 12 ? ` (+${unused.length - 12} more)` : ""}`);
    }
    if (merged > 0) out.push(`${merged} row(s) were identical after choosing these columns and were merged`);

    const text = Papa.unparse({ fields: header, data }, { delimiter: tpl.delimiter });
    return { blob: new Blob([text], { type: mime }), filename, notes: out };
}