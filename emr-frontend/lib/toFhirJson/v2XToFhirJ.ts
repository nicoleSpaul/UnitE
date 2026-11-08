import { toBundle, type ImportResult } from "../types";
import { hl7v2ToFhir } from "./v2JToFhirJ";

const SEGMENT = /^[A-Z][A-Z0-9]{2}$/;
const MAX_DEPTH = 12;

// in a pipe-delimited message, delimiter characters inside text must be escaped
const escV2 = (s: string) =>
    s.replace(/\\/g, "\\E\\").replace(/\|/g, "\\F\\").replace(/\^/g, "\\S\\")
        .replace(/&/g, "\\T\\").replace(/~/g, "\\R\\").replace(/[\r\n]+/g, " ");

// "PID.3" -> 3, "CX.4" -> 4
const num = (name: string) => {
    const m = /\.(\d+)$/.exec(name);
    return m ? Number(m[1]) : 0;
};
const text = (el: Element) => (el.textContent ?? "").trim();

// fill gaps, drop trailing empty parts, join
function join(parts: string[], sep: string): string {
    const out = Array.from(parts, (p) => p ?? "");
    while (out.length && out[out.length - 1] === "") out.pop();
    return out.join(sep);
}

// one component, which may hold sub-components: <CX.4><HD.1>HOSP</HD.1></CX.4>
function component(el: Element): string {
    const subs = Array.from(el.children);
    if (subs.length === 0) return escV2(text(el));
    const parts: string[] = [];
    for (const s of subs) {
        const n = num(s.localName);
        if (n >= 1 && n <= 50) parts[n - 1] = escV2(text(s));
    }
    return join(parts, "&");
}

// one field (or one repetition of it)
function repetition(el: Element): string {
    const comps = Array.from(el.children);
    if (comps.length === 0) return escV2(text(el));
    const parts: string[] = [];
    for (const c of comps) {
        const n = num(c.localName);
        if (n >= 1 && n <= 50) parts[n - 1] = component(c);
    }
    return join(parts, "^");
}

function segmentLine(el: Element): string {
    const seg = el.localName;
    const fields: Record<number, string[]> = {};
    let max = 0;

    for (const f of Array.from(el.children)) {
        if (!f.localName.startsWith(seg + ".")) continue;
        const n = num(f.localName);
        if (n < 1 || n > 200) continue;
        if (seg === "MSH" && n === 1) continue; // the field separator itself
        // MSH.2 holds the delimiter characters and must stay raw
        const value = seg === "MSH" && n === 2 ? text(f) : repetition(f);
        if (!fields[n]) fields[n] = [];
        fields[n].push(value);
        if (n > max) max = n;
    }

    const get = (n: number) => (fields[n] ?? []).join("~");
    if (seg === "MSH") {
        const enc = fields[2]?.[0] || "^~\\&";
        const rest: string[] = [];
        for (let n = 3; n <= max; n++) rest.push(get(n));
        return ["MSH", enc, ...rest].join("|");
    }
    const rest: string[] = [];
    for (let n = 1; n <= max; n++) rest.push(get(n));
    return [seg, ...rest].join("|");
}

// message groups (e.g. ORU_R01.PATIENT_RESULT) are only wrappers, so walk through them in order
function walk(el: Element, lines: string[], depth: number) {
    if (depth > MAX_DEPTH) return;
    for (const c of Array.from(el.children)) {
        if (SEGMENT.test(c.localName)) lines.push(segmentLine(c));
        else walk(c, lines, depth + 1);
    }
}

export function v2XToFhir(input: string): ImportResult {
    const empty = (msg: string): ImportResult => ({ bundle: toBundle([]), notes: [msg], patients: 0 });

    const doc = new DOMParser().parseFromString(input.replace(/^\uFEFF/, ""), "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return empty("Not valid XML");

    const root = doc.documentElement;
    const lines: string[] = [];
    walk(root, lines, 0);
    if (lines.length === 0) return empty(`No HL7 v2 segments found under <${root.localName}>`);

    return hl7v2ToFhir(lines.join("\r"));
}