import type { ExportResult, FhirBundle } from "../types";
import { pretty, xmlEsc } from "./shared";
import { buildV2 } from "./fhirJToV2J";

const NS = "urn:hl7-org:v2xml";
const SEGMENT = /^[A-Z][A-Z0-9]{2}$/;

// data types of the fields our HL7 v2 export writes (HL7 v2.5)
const TYPES: Record<string, string> = {
    "MSH.3": "HD", "MSH.4": "HD", "MSH.5": "HD", "MSH.6": "HD", "MSH.7": "TS", "MSH.9": "MSG", "MSH.12": "VID",
    "PID.3": "CX", "PID.5": "XPN", "PID.7": "TS",
    "DG1.3": "CE", "DG1.5": "TS",
    "AL1.3": "CE",
    "RXE.2": "CE",
    "OBR.4": "CE", "OBR.7": "TS",
    "OBX.3": "CE", "OBX.6": "CE", "OBX.14": "TS",
};

type Ctx = { generic: boolean };

// in XML the delimiters are literal characters, so undo the pipe-format escapes
const unesc = (s: string) =>
    s.replace(/\\([FSTRE])\\/g, (_m, c: string) =>
        ({ F: "|", S: "^", T: "&", R: "~", E: "\\" } as Record<string, string>)[c] ?? ""
    );

function fieldXml(seg: string, n: number, raw: string, type: string | undefined, ctx: Ctx): string {
    if (raw === "") return "";
    const tag = `${seg}.${n}`;
    return raw
        .split("~")
        .filter((rep) => rep !== "")
        .map((rep) => {
            const comps = rep.split("^");
            if (!type && comps.length === 1) return `<${tag}>${xmlEsc(unesc(rep))}</${tag}>`;
            if (!type) ctx.generic = true;
            const inner = comps
                .map((c, i) => {
                    if (c === "") return "";
                    const t = `${type ?? tag}.${i + 1}`;
                    const v = xmlEsc(unesc(c));
                    // HL7 v2.5: the family name of an XPN is a composite of its own
                    return type === "XPN" && i === 0 ? `<${t}><FN.1>${v}</FN.1></${t}>` : `<${t}>${v}</${t}>`;
                })
                .join("");
            return `<${tag}>${inner}</${tag}>`;
        })
        .join("");
}

function segmentXml(line: string, structure: string, ctx: Ctx): string {
    const f = line.split("|");
    const seg = f[0];
    if (!SEGMENT.test(seg)) return "";

    let body = "";
    if (seg === "MSH") body += `<MSH.1>|</MSH.1><MSH.2>${xmlEsc(f[1] ?? "^~\\&")}</MSH.2>`;

    for (let i = seg === "MSH" ? 2 : 1; i < f.length; i++) {
        const n = seg === "MSH" ? i + 1 : i; // MSH.1 is the separator, so its fields are shifted by one
        let raw = f[i] ?? "";
        if (seg === "MSH" && n === 9 && raw && raw.split("^").length < 3) raw = `${raw}^${structure}`;
        let type = TYPES[`${seg}.${n}`];
        if (seg === "OBX" && n === 5 && ["CE", "CWE", "CNE"].includes(f[2] ?? "")) type = f[2];
        body += fieldXml(seg, n, raw, type, ctx);
    }
    return `<${seg}>${body}</${seg}>`;
}

export function fhirJToV2X(bundle: FhirBundle, baseName: string): ExportResult {
    const { text, notes } = buildV2(bundle);
    const filename = `${baseName}.v2.xml`;
    const lines = text.split(/\r\n|\r|\n/).filter(Boolean);
    if (lines.length === 0) return { blob: new Blob([""], { type: "application/xml" }), filename, notes };

    // XML holds one message per file
    const starts = lines.flatMap((l, i) => (l.startsWith("MSH|") ? [i] : []));
    const first = lines.slice(starts[0] ?? 0, starts[1] ?? lines.length);

    const mt = (first[0].split("|")[8] ?? "").split("^");
    const guess = mt[0] && mt[1] ? `${mt[0]}_${mt[1]}` : "";
    const structure = /^[A-Z0-9_]+$/.test(guess) ? guess : "ADT_A08";

    const ctx: Ctx = { generic: false };
    const segs = first.map((l) => segmentXml(l, structure, ctx)).join("");
    const xml = pretty(`<${structure} xmlns="${NS}">${segs}</${structure}>`);

    const out = [...notes];
    if (starts.length > 1) {
        out.push(`HL7 v2 XML holds one message per file: exported the first of ${starts.length} patients`);
    }
    out.push("Segments are written without HL7's message-group wrappers, so strict v2 XML validators may reject the file. It re-imports into this tool");
    if (ctx.generic) out.push("Components of fields outside the common set are named by position (for example OBX.5.1)");

    return {
        blob: new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${xml}\n`], { type: "application/xml" }),
        filename,
        notes: out,
    };
}