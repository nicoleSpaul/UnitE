import type { ExportResult, FhirBundle, FhirResource } from "../types";
import { auditFields, first, groupByPatient, isObj, lossNotes, nameParts, str, type Obj } from "./shared";

const COVERED: Record<string, string[]> = {
    Patient: ["identifier", "name", "birthDate", "gender"],
    Condition: ["code", "subject", "onsetDateTime"],
    AllergyIntolerance: ["code", "patient"],
    MedicationStatement: ["medicationCodeableConcept", "subject"],
    Observation: [
        "code", "subject", "status", "valueQuantity", "valueString", "valueCodeableConcept",
        "valueBoolean", "valueInteger", "referenceRange", "interpretation", "effectiveDateTime",
    ],
};

type Ctx = { multiCoding: number; timeDropped: boolean; idSystems: boolean };

const SEX: Record<string, string> = { male: "M", female: "F", other: "O", unknown: "U" };
const OBX_STATUS: Record<string, string> = {
    final: "F", preliminary: "P", corrected: "C", amended: "C", cancelled: "X", "entered-in-error": "W",
};
const SYSTEMS: [string, string][] = [
    ["loinc.org", "LN"], ["snomed.info", "SCT"], ["rxnorm", "RXNORM"], ["icd-10", "I10"], ["icd-9", "I9"],
];
const systemName = (url: string) => (url ? (SYSTEMS.find(([k]) => url.includes(k))?.[1] ?? url) : "");

// HL7 v2 escape sequences for free text
const esc = (s: string) =>
    s.replace(/\\/g, "\\E\\").replace(/\|/g, "\\F\\").replace(/\^/g, "\\S\\")
        .replace(/&/g, "\\T\\").replace(/~/g, "\\R\\").replace(/[\r\n]+/g, " ");

const line = (...f: (string | number)[]) => f.join("|").replace(/\|+$/, "");

// 2026-01-31 -> 20260131
function v2Date(v: unknown, ctx: Ctx): string {
    const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(T.*)?$/.exec(str(v));
    if (!m) return "";
    if (m[4]) ctx.timeDropped = true;
    return `${m[1]}${m[2] ?? ""}${m[3] ?? ""}`;
}

// code^display^system
function cwe(cc: unknown, ctx: Ctx): string {
    const o: Obj = isObj(cc) ? cc : {};
    const codings = Array.isArray(o.coding) ? o.coding : [];
    if (codings.length > 1) ctx.multiCoding++;
    const c0: Obj = isObj(codings[0]) ? codings[0] : {};
    const code = str(c0.code);
    const display = str(c0.display) || str(o.text);
    if (!code && !display) return "";
    return [esc(code), esc(display), esc(systemName(str(c0.system)))].join("^").replace(/\^+$/, "");
}

function pidIds(p: Obj, ctx: Ctx): string {
    const ids = Array.isArray(p.identifier) ? p.identifier : [];
    const out: string[] = [];
    for (const i of ids) {
        if (!isObj(i) || !str(i.value)) continue;
        if (str(i.system)) ctx.idSystems = true;
        out.push(`${esc(str(i.value))}^^^^MR`);
    }
    return out.join("~");
}

function pidName(p: Obj): string {
    const { family, given } = nameParts(p);
    if (!family && given.length === 0) return "";
    return [esc(family), esc(given[0] ?? ""), esc(given.slice(1).join(" "))].join("^").replace(/\^+$/, "");
}

function obxValue(r: Obj, ctx: Ctx): { type: string; value: string; unit: string } {
    const q = r.valueQuantity;
    const n = isObj(q) ? q.value : undefined;
    if (isObj(q) && typeof n === "number") return { type: "NM", value: String(n), unit: str(q.unit) || str(q.code) };
    if (typeof r.valueInteger === "number") return { type: "NM", value: String(r.valueInteger), unit: "" };
    if (typeof r.valueString === "string") return { type: "ST", value: esc(str(r.valueString)), unit: "" };
    if (isObj(r.valueCodeableConcept)) return { type: "CWE", value: cwe(r.valueCodeableConcept, ctx), unit: "" };
    if (typeof r.valueBoolean === "boolean") return { type: "ST", value: String(r.valueBoolean), unit: "" };
    return { type: "ST", value: "", unit: "" };
}

function rangeText(r: Obj): string {
    const rr = first(r.referenceRange);
    if (!rr) return "";
    if (str(rr.text)) return str(rr.text);
    const num = (x: unknown) => {
        const v = isObj(x) ? x.value : undefined;
        return typeof v === "number" ? v : undefined;
    };
    const lo = num(rr.low);
    const hi = num(rr.high);
    if (lo !== undefined && hi !== undefined) return `${lo}-${hi}`;
    if (lo !== undefined) return `>${lo}`;
    if (hi !== undefined) return `<${hi}`;
    return "";
}

function flagCode(r: Obj): string {
    const i = first(r.interpretation);
    const c = first(i?.coding);
    return str(c?.code);
}

// builds the pipe-delimited message text (shared with the HL7 v2 XML exporter)
export function buildV2(bundle: FhirBundle): { text: string; notes: string[] } {
    const ctx: Ctx = { multiCoding: 0, timeDropped: false, idSystems: false };
    const g = groupByPatient(bundle, COVERED);
    const exported: FhirResource[] = [];
    const out: string[] = [];
    let noCode = 0;
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

    for (const [pid, p] of g.patients) {
        const list = g.items.get(pid) ?? [];
        exported.push(p, ...list);

        out.push(`MSH|^~\\&|EMR-UNIFIER|EXPORT|||${stamp}||ADT^A08|${crypto.randomUUID().slice(0, 8)}|P|2.5`);
        out.push(line("PID", 1, "", pidIds(p, ctx), "", pidName(p), "", v2Date(p.birthDate, ctx), SEX[str(p.gender)] ?? ""));

        let dg = 0;
        let al = 0;
        let ob = 0;
        for (const r of list) {
            if (r.resourceType === "Condition") {
                const code = cwe(r.code, ctx);
                if (!code) { noCode++; continue; }
                out.push(line("DG1", ++dg, "", code, "", v2Date(r.onsetDateTime, ctx)));
            } else if (r.resourceType === "AllergyIntolerance") {
                const code = cwe(r.code, ctx);
                if (!code) { noCode++; continue; }
                out.push(line("AL1", ++al, "", code));
            } else if (r.resourceType === "MedicationStatement") {
                const code = cwe(r.medicationCodeableConcept, ctx);
                if (!code) { noCode++; continue; }
                out.push(line("RXE", "", code));
            } else if (r.resourceType === "Observation") {
                const code = cwe(r.code, ctx);
                if (!code) { noCode++; continue; }
                const v = obxValue(r, ctx);
                out.push(line(
                    "OBX", ++ob, v.type, code, "", v.value, esc(v.unit), esc(rangeText(r)), esc(flagCode(r)),
                    "", "", OBX_STATUS[str(r.status)] ?? "", "", "", v2Date(r.effectiveDateTime, ctx),
                ));
            }
        }
    }

    const notes = lossNotes(auditFields(exported, COVERED, ["name", "referenceRange", "interpretation"]), g, "HL7 v2");
    if (g.patients.size === 0) notes.push("No Patient resources found: nothing to export");
    if (noCode) notes.push(`${noCode} item(s) had no code or name and were skipped`);
    if (ctx.multiCoding) notes.push("Only the first coding of each code was kept");
    if (ctx.timeDropped) notes.push("Time of day was dropped from dates");
    if (ctx.idSystems) notes.push("Identifier systems were not carried over; IDs are exported with type MR");
    if (g.patients.size) {
        notes.push("Message type ADT^A08 was used; strict HL7 profiles may not allow the OBX and RXE segments included here");
    }

    return { text: out.length ? out.join("\r") + "\r" : "", notes };
}

export function fhirJToV2J(bundle: FhirBundle, baseName: string): ExportResult {
    const { text, notes } = buildV2(bundle);
    return {
        blob: new Blob([text], { type: "text/plain;charset=utf-8" }),
        filename: `${baseName}.hl7`,
        notes,
    };
}