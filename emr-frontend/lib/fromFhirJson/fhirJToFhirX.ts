import type { ExportResult, FhirBundle } from "../types";
import { bump, isObj, pretty, str, xmlEsc, xmlSafe, type Obj } from "./shared";

const NS = "http://hl7.org/fhir";
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

type Ctx = { dropped: Map<string, number>; narratives: string[]; badNarratives: number };

// attribute values: newlines must be encoded or an XML parser will turn them into spaces
const attr = (s: string) =>
    xmlEsc(s).replace(/\n/g, "&#10;").replace(/\r/g, "&#13;").replace(/\t/g, "&#9;");

// Narrative (text.div) is XHTML. Keep it only if it's well-formed, namespaced and script-free.
function narrative(div: string, ctx: Ctx): string {
    const clean = xmlSafe(div);
    const parsed = new DOMParser().parseFromString(clean, "application/xml");
    const ok =
        clean.includes("http://www.w3.org/1999/xhtml") &&
        !/<script/i.test(clean) &&
        parsed.getElementsByTagName("parsererror").length === 0;
    if (!ok) { ctx.badNarratives++; return ""; }
    ctx.narratives.push(clean);
    return `<!--NARR${ctx.narratives.length - 1}-->`; // swapped back in after pretty-printing
}

function parts(o: Obj, ctx: Ctx, where: string, isRes: boolean, elName: string) {
    let attrs = "";
    let body = "";
    for (const [k, v] of Object.entries(o)) {
        if (isRes && k === "resourceType") continue;
        if (k.startsWith("_")) { bump(ctx.dropped, `${where}.${k}`); continue; } // primitive extensions
        if (!NAME.test(k)) { bump(ctx.dropped, `${where}.(invalid element name)`); continue; }
        if (!isRes && k === "id" && typeof v === "string") { attrs += ` id="${attr(v)}"`; continue; }
        if (
            !isRes && k === "url" && typeof v === "string" &&
            (elName === "extension" || elName === "modifierExtension")
        ) { attrs += ` url="${attr(v)}"`; continue; }
        if (k === "div" && typeof v === "string" && where.endsWith(".text")) { body += narrative(v, ctx); continue; }
        body += emit(k, v, ctx, `${where}.${k}`);
    }
    return { attrs, body };
}

function emit(name: string, v: unknown, ctx: Ctx, where: string): string {
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.map((x) => emit(name, x, ctx, where)).join("");
    if (typeof v === "string") return `<${name} value="${attr(v)}"/>`;
    if (typeof v === "number" || typeof v === "boolean") return `<${name} value="${v}"/>`;
    if (!isObj(v)) return "";

    const t = str(v.resourceType);
    if (t) {
        // a nested resource (Bundle.entry.resource, contained[]): wrapped in its own element
        if (!NAME.test(t)) { bump(ctx.dropped, `${where}.(invalid resource type)`); return ""; }
        const { body } = parts(v, ctx, t, true, t);
        return `<${name}><${t}>${body}</${t}></${name}>`;
    }

    const { attrs, body } = parts(v, ctx, where, false, name);
    if (!attrs && !body) return "";
    return body ? `<${name}${attrs}>${body}</${name}>` : `<${name}${attrs}/>`;
}

export function fhirJToFhirX(bundle: FhirBundle, baseName: string): ExportResult {
    const ctx: Ctx = { dropped: new Map(), narratives: [], badNarratives: 0 };
    const { body } = parts(bundle as unknown as Obj, ctx, "Bundle", true, "Bundle");
    const xml = pretty(`<Bundle xmlns="${NS}">${body}</Bundle>`).replace(
        /<!--NARR(\d+)-->/g,
        (_m, i: string) => ctx.narratives[Number(i)] ?? ""
    );

    const notes: string[] = [];
    if (ctx.dropped.size) {
        notes.push(
            "Dropped: " + [...ctx.dropped].map(([k, c]) => `${k} ×${c}`).join(", ") +
            " (primitive extensions and invalid element names aren't supported)"
        );
    }
    if (ctx.badNarratives) {
        notes.push(`${ctx.badNarratives} narrative block(s) were dropped because they weren't well-formed XHTML`);
    }
    notes.push("Not schema-validated: elements keep the order they had in the JSON, and strict FHIR XML validators require the spec's order");

    return {
        blob: new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${xml}\n`], { type: "application/fhir+xml" }),
        filename: `${baseName}.fhir.xml`,
        notes,
    };
}