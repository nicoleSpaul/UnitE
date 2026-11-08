import { toBundle, type FhirResource, type ImportResult } from "../types";

type Obj = Record<string, unknown>;
type Ctx = {
    dropped: Map<string, number>;
    badNarratives: number;
    decimalTrail: boolean;
    resourceTypes: Set<string>;
};

const FHIR_NS = "http://hl7.org/fhir";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const NAME = /^[A-Za-z][A-Za-z0-9]*$/; // also keeps out names like __proto__
const MAX_DEPTH = 40;

// XML doesn't say which elements are lists. These come from FHIR R4 for the common resource types.
const ALWAYS_ARRAY = new Set([
    "contained", "extension", "modifierExtension", "identifier", "telecom", "address", "contact",
    "communication", "generalPractitioner", "link", "photo", "given", "prefix", "suffix", "line", "coding",
    "entry", "category", "evidence", "stage", "note", "basedOn", "partOf", "reasonCode", "reasonReference",
    "performer", "interpretation", "referenceRange", "hasMember", "derivedFrom", "component", "reaction",
    "manifestation", "statusHistory", "classHistory", "episodeOfCare", "appointment", "account",
    "participant", "diagnosis", "result", "imagingStudy", "media", "presentedForm", "conclusionCode",
    "education", "programEligibility", "subpotentReason", "protocolApplied", "complication",
    "complicationDetail", "followUp", "focalDevice", "usedReference", "usedCode", "report",
    "instantiatesCanonical", "instantiatesUri", "dosage", "doseAndRate", "additionalInstruction", "event",
    "dayOfWeek", "timeOfDay", "when", "appliesTo", "profile", "security", "tag", "relationship", "alias",
]);
// lists that depend on the parent: "Parent.element"
const ARRAY_IN = new Set([
    "Patient.name", "Practitioner.name", "RelatedPerson.name", "Person.name",
    "Encounter.type", "Organization.type", "Location.type", "participant.type",
    "Encounter.location", "DiagnosticReport.specimen", "Condition.bodySite", "Procedure.bodySite",
]);
// single values that would otherwise look like lists
const SINGLE_IN = new Set([
    "Bundle.identifier", "contact.name", "contact.address", "Location.address",
    "MedicationStatement.category", "Procedure.category",
]);
const TUNED = new Set([
    "Bundle", "Patient", "Condition", "MedicationStatement", "Observation", "AllergyIntolerance",
    "Encounter", "Procedure", "Immunization", "DiagnosticReport", "Organization", "Practitioner", "Location",
]);

const BOOL_NAMES = new Set([
    "active", "preferred", "primarySource", "doNotPerform", "experimental", "immutable", "abstract",
    "mandatory", "required",
]);
const NUM_NAMES = new Set([
    "sequence", "count", "countMax", "duration", "durationMax", "frequency", "frequencyMax",
    "period", "periodMax", "offset", "total", "size",
]);
const QUANTITY_PARENTS = new Set([
    "low", "high", "numerator", "denominator", "quantity", "age", "duration", "distance", "count",
]);

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

function repeats(parent: string, name: string, siblings: Set<string>): boolean {
    const key = `${parent}.${name}`;
    if (SINGLE_IN.has(key)) return false;
    // Reference.identifier is a single value (its siblings are reference / display)
    if (name === "identifier" && (siblings.has("reference") || siblings.has("display"))) return false;
    return ALWAYS_ARRAY.has(name) || ARRAY_IN.has(key);
}

// XML values are all text: turn booleans and numbers back into JSON types
function typed(name: string, parent: string, v: string, ctx: Ctx): string | number | boolean {
    if (/Boolean$/.test(name) || BOOL_NAMES.has(name)) {
        if (v === "true") return true;
        if (v === "false") return false;
        return v;
    }
    const numeric =
        /(Integer|Decimal|PositiveInt|UnsignedInt)$/.test(name) ||
        NUM_NAMES.has(name) ||
        (name === "value" && (/Quantity$/.test(parent) || QUANTITY_PARENTS.has(parent)));
    if (numeric && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) {
        const n = Number(v);
        if (Number.isFinite(n)) {
            if (/\.\d*0$/.test(v)) ctx.decimalTrail = true;
            return n;
        }
    }
    return v;
}

// the narrative (text.div) is XHTML: keep it as a string, but not if it carries script
function narrative(c: Element, ctx: Ctx): string | undefined {
    const xhtml = new XMLSerializer().serializeToString(c);
    if (/<script|\son\w+\s*=|javascript:/i.test(xhtml)) {
        ctx.badNarratives++;
        return undefined;
    }
    return xhtml;
}

function read(c: Element, parent: string, ctx: Ctx, depth: number): unknown {
    const name = c.localName;

    if (name === "div" && c.namespaceURI === XHTML_NS) return narrative(c, ctx);

    // primitive: <birthDate value="1970-01-01"/>
    if (c.hasAttribute("value")) {
        if (c.children.length > 0 || c.hasAttribute("id")) bump(ctx.dropped, `${parent}.${name} (primitive extension)`);
        return typed(name, parent, c.getAttribute("value") ?? "", ctx);
    }

    // a wrapper around a nested resource: <resource><Patient>…</Patient></resource>, <contained>…
    if (c.children.length === 1) {
        const only = c.children[0];
        if (/^[A-Z][A-Za-z]*$/.test(only.localName)) return convert(only, true, ctx, depth + 1);
    }

    const o = convert(c, false, ctx, depth);
    return Object.keys(o).length ? o : undefined;
}

function convert(el: Element, resource: boolean, ctx: Ctx, depth: number): Obj {
    if (depth > MAX_DEPTH) throw new Error("This XML is nested too deeply to read");
    const here = el.localName;
    const out: Obj = {};

    if (resource) {
        out.resourceType = here;
        ctx.resourceTypes.add(here);
    } else {
        const id = el.getAttribute("id");
        if (id) out.id = id;
        const url = el.getAttribute("url");
        if (url) out.url = url;
    }

    const children = Array.from(el.children);
    const siblings = new Set(children.map((c) => c.localName));
    const groups = new Map<string, unknown[]>();

    for (const c of children) {
        const name = c.localName;
        if (!NAME.test(name) || (resource && name === "resourceType")) {
            bump(ctx.dropped, `${here}.(invalid element name)`);
            continue;
        }
        const v = read(c, here, ctx, depth + 1);
        if (v === undefined) continue;
        const list = groups.get(name);
        if (list) list.push(v);
        else groups.set(name, [v]);
    }

    for (const [name, list] of groups) {
        out[name] = list.length > 1 || repeats(here, name, siblings) ? list : list[0];
    }
    return out;
}

export function fhirXToFhirJ(input: string): ImportResult {
    const empty = (msg: string): ImportResult => ({ bundle: toBundle([]), notes: [msg], patients: 0 });

    const doc = new DOMParser().parseFromString(input.replace(/^\uFEFF/, ""), "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return empty("Not valid XML");

    const root = doc.documentElement;
    if (root.namespaceURI !== FHIR_NS) {
        return empty("Not FHIR XML: the root element isn't in the http://hl7.org/fhir namespace");
    }

    const ctx: Ctx = { dropped: new Map(), badNarratives: 0, decimalTrail: false, resourceTypes: new Set() };
    let top: Obj;
    try {
        top = convert(root, true, ctx, 0);
    } catch (e) {
        return empty(e instanceof Error ? e.message : "Couldn't read this XML");
    }

    const resources: FhirResource[] = [];
    if (top.resourceType === "Bundle") {
        const entries = Array.isArray(top.entry) ? (top.entry as Obj[]) : [];
        for (const e of entries) {
            const r = e?.resource;
            if (r && typeof r === "object") resources.push(r as FhirResource);
        }
    } else {
        resources.push(top as FhirResource);
    }

    let noId = 0;
    for (const r of resources) {
        if (typeof r.id !== "string" || !r.id) {
            r.id = crypto.randomUUID();
            noId++;
        }
    }

    const notes: string[] = [];
    if (resources.length === 0) notes.push("No FHIR resources found in this file");
    if (ctx.dropped.size) {
        notes.push("Dropped: " + [...ctx.dropped].map(([k, c]) => `${k} ×${c}`).join(", "));
    }
    if (ctx.badNarratives) notes.push(`${ctx.badNarratives} narrative block(s) were dropped because they contained script`);
    if (noId) notes.push(`${noId} resource(s) had no id: generated one`);
    if (ctx.decimalTrail) notes.push("Decimal numbers lose trailing zeros in JSON (1.50 becomes 1.5)");
    const odd = [...ctx.resourceTypes].filter((t) => !TUNED.has(t));
    if (odd.length) {
        notes.push(`Single-versus-list rules were tuned for common resource types. Check ${odd.join(", ")}: elements that FHIR allows to repeat may come through as single values`);
    }

    return {
        bundle: toBundle(resources),
        notes,
        patients: resources.filter((r) => r.resourceType === "Patient").length,
    };
}