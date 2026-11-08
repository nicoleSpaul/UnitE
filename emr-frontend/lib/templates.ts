import { EXTENSION, TARGET_BY_ID } from "./targets";
import type { Mapping } from "./toFhirJson/csvToFhirJ";

export type Template = {
    id: string;
    name: string;
    mapping: Mapping; // header -> target id | EXTENSION | null
    savedAt: string;
};

const KEY = "emr-unifier:templates:v1";
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const norm = (h: string) => h.trim().toLowerCase();

// Validates anything that came from storage or an uploaded file. Throws if it isn't a template file.
export function sanitizeTemplates(input: unknown): { templates: Template[]; notes: string[] } {
    const list = Array.isArray(input)
        ? input
        : Array.isArray((input as { templates?: unknown })?.templates)
            ? (input as { templates: unknown[] }).templates
            : null;
    if (!list) throw new Error("not a template file");

    const templates: Template[] = [];
    let skipped = 0;
    let unknownTargets = 0;

    for (const item of list) {
        const t = item as { name?: unknown; mapping?: unknown; savedAt?: unknown } | null;
        const name = typeof t?.name === "string" ? t.name.trim().slice(0, 80) : "";
        const raw = t?.mapping;
        if (!name || !raw || typeof raw !== "object" || Array.isArray(raw)) { skipped++; continue; }

        const mapping: Mapping = {};
        for (const [header, target] of Object.entries(raw as Record<string, unknown>)) {
            if (BAD_KEYS.has(header) || header.length > 200) continue;
            if (target === null || target === EXTENSION || (typeof target === "string" && TARGET_BY_ID.has(target))) {
                mapping[header] = target as string | null;
            } else {
                mapping[header] = null;
                unknownTargets++;
            }
        }
        templates.push({
            id: crypto.randomUUID(),
            name,
            mapping,
            savedAt: typeof t?.savedAt === "string" ? t.savedAt : new Date().toISOString(),
        });
    }

    const notes: string[] = [];
    if (skipped) notes.push(`Skipped ${skipped} malformed template(s).`);
    if (unknownTargets) notes.push(`${unknownTargets} unknown target(s) were set to skip.`);
    return { templates, notes };
}

export function loadTemplates(): Template[] {
    try {
        const raw = localStorage.getItem(KEY);
        return raw ? sanitizeTemplates(JSON.parse(raw)).templates : [];
    } catch {
        return [];
    }
}

export function saveTemplates(list: Template[]) {
    try {
        localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
        /* storage blocked or full: templates just won't persist */
    }
}

// Best template whose headers overlap the file's by at least 80% (Jaccard).
export function matchTemplate(headers: string[], templates: Template[]) {
    const file = new Set(headers.map(norm));
    let best: { template: Template; score: number } | null = null;
    for (const t of templates) {
        const tpl = new Set(Object.keys(t.mapping).map(norm));
        let inter = 0;
        for (const h of tpl) if (file.has(h)) inter++;
        const union = file.size + tpl.size - inter;
        const score = union ? inter / union : 0;
        if (score >= 0.8 && (!best || score > best.score)) best = { template: t, score };
    }
    return best;
}

// Template entries override the guesses; headers the template doesn't know keep their guess.
export function applyTemplate(headers: string[], t: Template, base: Mapping): Mapping {
    const byNorm = new Map(Object.entries(t.mapping).map(([h, v]) => [norm(h), v] as const));
    const out: Mapping = { ...base };
    for (const h of headers) {
        const v = byNorm.get(norm(h));
        if (v !== undefined) out[h] = v;
    }
    return out;
}