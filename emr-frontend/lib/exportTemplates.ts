export type Delimiter = "," | ";" | "\t" | "|";

export const DELIMITERS: { value: Delimiter; label: string; ext: string }[] = [
    { value: ",", label: "Comma (.csv)", ext: "csv" },
    { value: ";", label: "Semicolon (.csv)", ext: "csv" },
    { value: "\t", label: "Tab (.tsv)", ext: "tsv" },
    { value: "|", label: "Pipe (.txt)", ext: "txt" },
];

export type ExportColumn = { header: string; source: string };

export type ExportTemplate = {
    id: string;
    name: string;
    delimiter: Delimiter;
    columns: ExportColumn[]; // output order; source = a target id or a kept-column name
    savedAt: string;
};

export const MAX_COLUMNS = 100;
const KEY = "emr-unifier:export-templates:v1";

export function blankExportTemplate(): ExportTemplate {
    return {
        id: crypto.randomUUID(),
        name: "My export",
        delimiter: ",",
        columns: [],
        savedAt: new Date().toISOString(),
    };
}

// Validates anything that came from storage or an uploaded file. Reads the "exportTemplates" list;
// a file with no such list simply yields nothing (it may only hold mapping templates).
export function sanitizeExportTemplates(input: unknown, keepIds = false) {
    const raw = (input as { exportTemplates?: unknown } | null)?.exportTemplates;
    const templates: ExportTemplate[] = [];
    const notes: string[] = [];
    if (!Array.isArray(raw)) return { templates, notes };

    let skipped = 0;
    let trimmed = 0;
    for (const item of raw) {
        const t = item as { id?: unknown; name?: unknown; delimiter?: unknown; columns?: unknown; savedAt?: unknown } | null;
        const name = typeof t?.name === "string" ? t.name.trim().slice(0, 80) : "";
        const cols = t?.columns;
        if (!name || !Array.isArray(cols)) { skipped++; continue; }

        const columns: ExportColumn[] = [];
        for (const c of cols) {
            const col = c as { header?: unknown; source?: unknown } | null;
            const source = typeof col?.source === "string" ? col.source.slice(0, 200) : "";
            if (!source) continue;
            if (columns.length >= MAX_COLUMNS) { trimmed++; break; }
            const header = typeof col?.header === "string" ? col.header.trim().slice(0, 80) : "";
            columns.push({ header: header || source.slice(0, 80), source });
        }

        const delimiter = DELIMITERS.find((d) => d.value === t?.delimiter)?.value ?? ",";
        const id =
            keepIds && typeof t?.id === "string" && /^[\w-]{1,64}$/.test(t.id) ? t.id : crypto.randomUUID();
        templates.push({
            id,
            name,
            delimiter,
            columns,
            savedAt: typeof t?.savedAt === "string" ? t.savedAt : new Date().toISOString(),
        });
    }
    if (skipped) notes.push(`Skipped ${skipped} malformed export template(s).`);
    if (trimmed) notes.push(`Some export templates were cut to ${MAX_COLUMNS} columns.`);
    return { templates, notes };
}

export function loadExportTemplates(): ExportTemplate[] {
    try {
        const raw = localStorage.getItem(KEY);
        return raw ? sanitizeExportTemplates({ exportTemplates: JSON.parse(raw) }, true).templates : [];
    } catch {
        return [];
    }
}

export function saveExportTemplates(list: ExportTemplate[]) {
    try {
        localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
        /* storage blocked or full: templates just won't persist */
    }
}