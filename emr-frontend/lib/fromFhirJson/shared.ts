import type { FhirBundle, FhirResource } from "../types";

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const first = (v: unknown): Obj | undefined => {
    if (!Array.isArray(v)) return undefined;
    const x: unknown = v[0];
    return isObj(x) ? x : undefined;
};

export const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

// keys every resource has that no exporter reports as "dropped"
export const STRUCTURAL = new Set(["resourceType", "id", "meta", "text"]);

// ---------- XML helpers ----------
export const xmlSafe = (s: string) =>
    Array.from(s)
        .filter((ch) => {
            const c = ch.codePointAt(0) ?? 0;
            return c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 0xfffe && c !== 0xffff);
        })
        .join("");

export const xmlEsc = (s: string) =>
    xmlSafe(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// indents compact XML (one tag per line)
export function pretty(xml: string): string {
    let depth = 0;
    return xml
        .replace(/>\s*</g, ">\n<")
        .split("\n")
        .map((line) => {
            if (line.startsWith("</")) depth = Math.max(0, depth - 1);
            const out = "  ".repeat(depth) + line;
            const opens = /^<[^!?/]/.test(line) && !line.endsWith("/>") && !/<\/[^>]+>$/.test(line);
            if (opens) depth++;
            return out;
        })
        .join("\n");
}

// ---------- patient names ----------
export function nameParts(p: Obj): { family: string; given: string[] } {
    const n = first(p.name);
    if (!n) return { family: "", given: [] };
    let family = str(n.family);
    let given: string[] = Array.isArray(n.given)
        ? n.given.filter((g): g is string => typeof g === "string")
        : [];
    if (!family && given.length === 0) {
        const t = str(n.text).trim().split(/\s+/).filter(Boolean);
        family = t.pop() ?? "";
        given = t;
    }
    return { family, given };
}

// ---------- grouping ----------
export type Grouped = {
    patients: Map<string, FhirResource>;
    items: Map<string, FhirResource[]>;
    skippedTypes: Map<string, number>;
    orphans: number;
};

// Sorts a Bundle into patients and their clinical items. Resource types not in `covered` are counted as skipped.
export function groupByPatient(bundle: FhirBundle, covered: Record<string, string[]>): Grouped {
    const entries = (bundle.entry ?? []) as { fullUrl?: string; resource?: FhirResource }[];
    const patients = new Map<string, FhirResource>();
    const alias = new Map<string, string>(); // "Patient/x" or a fullUrl -> patient key

    for (const e of entries) {
        const r = e.resource;
        if (!r || r.resourceType !== "Patient") continue;
        const id = str(r.id) || `patient-${patients.size + 1}`;
        patients.set(id, r);
        alias.set(`Patient/${id}`, id);
        if (e.fullUrl) alias.set(e.fullUrl, id);
    }

    const items = new Map<string, FhirResource[]>();
    const skippedTypes = new Map<string, number>();
    let orphans = 0;

    for (const e of entries) {
        const r = e.resource;
        if (!r || r.resourceType === "Patient") continue;
        if (!covered[r.resourceType]) { bump(skippedTypes, r.resourceType); continue; }
        const who: Obj = isObj(r.subject) ? r.subject : isObj(r.patient) ? r.patient : {};
        const pid = alias.get(str(who.reference));
        if (!pid) { orphans++; continue; }
        const list = items.get(pid) ?? [];
        list.push(r);
        items.set(pid, list);
    }
    return { patients, items, skippedTypes, orphans };
}

// ---------- loss reporting ----------
export function auditFields(resources: FhirResource[], covered: Record<string, string[]>, firstOnly: string[] = []) {
    const dropped = new Map<string, number>();
    const extra = new Map<string, number>();
    for (const r of resources) {
        const ok = covered[r.resourceType];
        if (!ok) continue;
        for (const [k, v] of Object.entries(r)) {
            if (STRUCTURAL.has(k)) continue;
            if (!ok.includes(k)) { bump(dropped, `${r.resourceType}.${k}`); continue; }
            if (firstOnly.includes(k) && Array.isArray(v) && v.length > 1) {
                bump(extra, `${r.resourceType}.${k}`, v.length - 1);
            }
        }
    }
    return { dropped, extra };
}

export function lossNotes(a: ReturnType<typeof auditFields>, g: Grouped, target: string): string[] {
    const notes: string[] = [];
    for (const [t, c] of g.skippedTypes) notes.push(`Dropped ${c} ${t} resource(s): ${target} has no place for them`);
    if (a.dropped.size) notes.push("Dropped fields: " + [...a.dropped].map(([k, c]) => `${k} ×${c}`).join(", "));
    if (a.extra.size) notes.push("Only the first entry was kept for: " + [...a.extra].map(([k, c]) => `${k} (${c} more)`).join(", "));
    if (g.orphans) notes.push(`${g.orphans} item(s) had no matching Patient and were dropped`);
    return notes;
}