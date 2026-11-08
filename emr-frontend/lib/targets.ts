import type { FhirResource } from "./types";

export type ResourceKind =
    | "Patient"
    | "Condition"
    | "MedicationStatement"
    | "Observation"
    | "AllergyIntolerance";

export type Target = {
    id: string;                 // "Patient.birthDate"
    label: string;              // shown in the dropdown
    on: ResourceKind;
    guess?: RegExp;             // header pattern for auto-guessing
    perColumn?: boolean;        // each mapped column makes its own resource (wide lab files)
    covers: string[];           // top-level FHIR keys this target reads (for loss reporting)
    set: (res: FhirResource, value: string, ctx: { column: string }) => string | void; // returns a warning
    get: (res: FhirResource) => string;                                                 // used by exports
};

export const EXTENSION = "__extension__"; // "keep this column, don't lose it"
export const EXT_URL = "urn:emr-unifier:column:";

type Obj = Record<string, unknown>;

// ---------- helpers ----------
const text = (v: unknown): string => (typeof v === "string" ? v : "");

const at = (o: unknown, ...path: (string | number)[]): unknown =>
    path.reduce<unknown>(
        (acc, k) => (acc as Record<string | number, unknown> | null | undefined)?.[k],
        o
    );

const codeText = (c: unknown): string =>
    text(at(c, "text")) || text(at(c, "coding", 0, "display")) || text(at(c, "coding", 0, "code"));

const obj = (res: FhirResource, key: string): Obj => {
    const cur = res[key];
    if (cur && typeof cur === "object" && !Array.isArray(cur)) return cur as Obj;
    const fresh: Obj = {};
    res[key] = fresh;
    return fresh;
};

const first = (res: FhirResource, key: string): Obj => {
    const arr: Obj[] = Array.isArray(res[key]) ? (res[key] as Obj[]) : [];
    if (!arr[0]) arr[0] = {};
    res[key] = arr;
    return arr[0];
};

const validDate = (d: string) => {
    const t = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};

const normDate = (v: string): string | undefined => {
    const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(v.trim());
    if (!m) return undefined;
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    return validDate(d) ? d : undefined;
};

const setCoding = (res: FhirResource, key: string, system: string, code: string) => {
    obj(res, key).coding = [{ system, code }];
};

const getCoding = (res: FhirResource, key: string, systemPart: string) =>
    text(at(res, key, "coding", 0, "system")).includes(systemPart)
        ? text(at(res, key, "coding", 0, "code"))
        : "";

function setValue(r: FhirResource, v: string) {
    const n = Number(v);
    if (v !== "" && Number.isFinite(n)) r.valueQuantity = { value: n };
    else r.valueString = v;
}

const statusTarget = (on: ResourceKind, id: string, label: string, allowed: string[]): Target => ({
    id, label, on, covers: ["status"],
    set: (r, v) => {
        const s = v.toLowerCase();
        const ok = allowed.includes(s);
        r.status = ok ? s : "unknown";
        if (!ok) return `"${v}" is not a valid status, stored as unknown`;
    },
    get: (r) => text(r.status),
});

// ---------- the targets (order matters: first matching guess wins) ----------
export const TARGET_LIST: Target[] = [
    // Patient
    {
        id: "Patient.identifier.value", label: "Patient ID / MRN", on: "Patient",
        guess: /(mrn|patient_?id|identifier|^id$)/i, covers: ["identifier"],
        set: (r, v) => { first(r, "identifier").value = v; },
        get: (r) => text(at(r, "identifier", 0, "value")),
    },
    {
        id: "Patient.name.given", label: "First / given name", on: "Patient",
        guess: /(^|_)(first|given)(_?name)?$/i, covers: ["name"],
        set: (r, v) => { first(r, "name").given = v.split(/\s+/).filter(Boolean); },
        get: (r) => {
            const g = at(r, "name", 0, "given");
            return Array.isArray(g) ? g.join(" ") : "";
        },
    },
    {
        id: "Patient.name.family", label: "Last / family name", on: "Patient",
        guess: /(^|_)(last|family|surname)(_?name)?$/i, covers: ["name"],
        set: (r, v) => { first(r, "name").family = v; },
        get: (r) => text(at(r, "name", 0, "family")),
    },
    {
        id: "Patient.name.text", label: "Full name", on: "Patient",
        guess: /^(pt|patient)?[_ ]?(full)?[_ ]?name$/i, covers: ["name"],
        set: (r, v) => { first(r, "name").text = v; },
        get: (r) => {
            const g = at(r, "name", 0, "given");
            return (
                text(at(r, "name", 0, "text")) ||
                [Array.isArray(g) ? g.join(" ") : "", text(at(r, "name", 0, "family"))]
                    .filter(Boolean).join(" ")
            );
        },
    },
    {
        id: "Patient.birthDate", label: "Birth date", on: "Patient",
        guess: /(dob|birth)/i, covers: ["birthDate"],
        set: (r, v) => {
            const d = normDate(v);
            if (!d) return `"${v}" is not a valid date (use YYYY-MM-DD), left out`;
            r.birthDate = d;
        },
        get: (r) => text(r.birthDate),
    },
    {
        id: "Patient.gender", label: "Sex / gender", on: "Patient",
        guess: /^(sex|gender)$/i, covers: ["gender"],
        set: (r, v) => {
            const map: Record<string, string> = {
                m: "male", male: "male", f: "female", female: "female",
                o: "other", other: "other", u: "unknown", unknown: "unknown",
            };
            const out = map[v.toLowerCase()];
            r.gender = out ?? "unknown";
            if (!out) return `"${v}" is not a recognized gender, stored as unknown`;
        },
        get: (r) => text(r.gender),
    },
    {
        id: "Patient.telecom.phone", label: "Phone", on: "Patient",
        guess: /(phone|mobile|^tel)/i, covers: ["telecom"],
        set: (r, v) => { Object.assign(first(r, "telecom"), { system: "phone", value: v }); },
        get: (r) => text(at(r, "telecom", 0, "value")),
    },
    {
        id: "Patient.address.text", label: "Address", on: "Patient",
        guess: /address/i, covers: ["address"],
        set: (r, v) => { first(r, "address").text = v; },
        get: (r) => {
            const line = at(r, "address", 0, "line");
            return (
                text(at(r, "address", 0, "text")) ||
                [Array.isArray(line) ? line.join(" ") : "", text(at(r, "address", 0, "city")),
                text(at(r, "address", 0, "state")), text(at(r, "address", 0, "postalCode"))]
                    .filter(Boolean).join(", ")
            );
        },
    },

    // Condition
    {
        id: "Condition.onsetDateTime", label: "Condition: onset date", on: "Condition",
        guess: /(onset|(dx|diagnosis)_?date)/i, covers: ["onsetDateTime"],
        set: (r, v) => {
            const d = normDate(v);
            if (!d) return `"${v}" is not a valid date, left out`;
            r.onsetDateTime = d;
        },
        get: (r) => text(r.onsetDateTime),
    },
    {
        id: "Condition.code.icd10", label: "Condition: ICD-10 code", on: "Condition",
        guess: /icd/i, covers: ["code"],
        set: (r, v) => setCoding(r, "code", "http://hl7.org/fhir/sid/icd-10-cm", v),
        get: (r) => getCoding(r, "code", "icd-10"),
    },
    {
        id: "Condition.code.text", label: "Condition: diagnosis", on: "Condition",
        guess: /(dx|diagnos|condition|problem)/i, covers: ["code"],
        set: (r, v) => { obj(r, "code").text = v; },
        get: (r) => codeText(r.code),
    },

    // MedicationStatement
    {
        id: "MedicationStatement.dosage.text", label: "Medication: dosage", on: "MedicationStatement",
        guess: /(dose|dosage|^sig$)/i, covers: ["dosage"],
        set: (r, v) => { first(r, "dosage").text = v; },
        get: (r) => text(at(r, "dosage", 0, "text")),
    },
    {
        id: "MedicationStatement.medicationCodeableConcept.rxnorm", label: "Medication: RxNorm code",
        on: "MedicationStatement", guess: /(rxnorm|rxcui)/i, covers: ["medicationCodeableConcept"],
        set: (r, v) =>
            setCoding(r, "medicationCodeableConcept", "http://www.nlm.nih.gov/research/umls/rxnorm", v),
        get: (r) => getCoding(r, "medicationCodeableConcept", "rxnorm"),
    },
    {
        id: "MedicationStatement.medicationCodeableConcept.text", label: "Medication: name",
        on: "MedicationStatement", guess: /(medication|drug|rx|^med)/i,
        covers: ["medicationCodeableConcept"],
        set: (r, v) => { obj(r, "medicationCodeableConcept").text = v; },
        get: (r) => codeText(r.medicationCodeableConcept),
    },
    statusTarget("MedicationStatement", "MedicationStatement.status", "Medication: status",
        ["active", "completed", "entered-in-error", "intended", "stopped", "on-hold", "unknown", "not-taken"]),

    // Observation (one row = one test: name + value + unit + date ...)
    {
        id: "Observation.date", label: "Lab: date", on: "Observation",
        guess: /(collected|result_?date|obs_?date|effective)/i, covers: ["effectiveDateTime"],
        set: (r, v) => {
            const d = normDate(v);
            if (!d) return `"${v}" is not a valid date, left out`;
            r.effectiveDateTime = d;
        },
        get: (r) => text(r.effectiveDateTime),
    },
    {
        id: "Observation.unit", label: "Lab: unit", on: "Observation",
        guess: /unit/i, covers: [],
        set: (r, v) => { r._unit = v; },   // applied in the Observation "done" step below
        get: (r) => text(at(r, "valueQuantity", "unit")),
    },
    {
        id: "Observation.range", label: "Lab: reference range", on: "Observation",
        guess: /(range|reference)/i, covers: ["referenceRange"],
        set: (r, v) => { first(r, "referenceRange").text = v; },
        get: (r) => text(at(r, "referenceRange", 0, "text")),
    },
    {
        id: "Observation.flag", label: "Lab: abnormal flag", on: "Observation",
        guess: /(flag|abnormal)/i, covers: ["interpretation"],
        set: (r, v) => {
            r.interpretation = [{
                coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: v }],
            }];
        },
        get: (r) =>
            text(at(r, "interpretation", 0, "coding", 0, "code")) || text(at(r, "interpretation", 0, "text")),
    },
    {
        id: "Observation.code.loinc", label: "Lab: LOINC code", on: "Observation",
        guess: /loinc/i, covers: ["code"],
        set: (r, v) => setCoding(r, "code", "http://loinc.org", v),
        get: (r) => getCoding(r, "code", "loinc"),
    },
    {
        id: "Observation.value", label: "Lab: result value", on: "Observation",
        guess: /(result|value)/i,
        covers: ["valueQuantity", "valueString", "valueCodeableConcept", "valueBoolean"],
        set: (r, v) => setValue(r, v),
        get: (r) => {
            const n = at(r, "valueQuantity", "value");
            const b = r.valueBoolean;
            return (
                text(r.valueString) ||
                (typeof n === "number" ? String(n) : "") ||
                codeText(r.valueCodeableConcept) ||
                (typeof b === "boolean" ? String(b) : "")
            );
        },
    },
    {
        id: "Observation.code.text", label: "Lab: test name", on: "Observation",
        guess: /(test_?name|lab_?name|analyte|observation|^test$)/i, covers: ["code"],
        set: (r, v) => { obj(r, "code").text = v; },
        get: (r) => codeText(r.code),
    },
    statusTarget("Observation", "Observation.status", "Lab: status",
        ["registered", "preliminary", "final", "amended", "corrected", "cancelled", "entered-in-error", "unknown"]),
    {
        // wide files: the COLUMN HEADER is the test name, the cell is the result
        id: "Observation.byColumn", label: "Lab result (column name = test name)", on: "Observation",
        perColumn: true, covers: [],
        set: (r, v, ctx) => { obj(r, "code").text = ctx.column; setValue(r, v); },
        get: () => "",
    },

    // AllergyIntolerance
    {
        id: "AllergyIntolerance.code.text", label: "Allergy: allergen", on: "AllergyIntolerance",
        guess: /allerg/i, covers: ["code"],
        set: (r, v) => { obj(r, "code").text = v; },
        get: (r) => codeText(r.code),
    },
];

export const TARGET_BY_ID = new Map(TARGET_LIST.map((t) => [t.id, t] as const));
export const TARGETS = TARGET_LIST.map((t) => t.id); // legacy list of ids

// ---------- per-resource-type rules ----------
type KindDef = {
    init: (id: string, subject: { reference: string }) => FhirResource;
    essential: string;                          // what a resource must have, for the warning text
    has: (r: FhirResource) => boolean;
    done?: (r: FhirResource) => string | void;  // runs after all targets were applied
};

export const KINDS: Record<ResourceKind, KindDef> = {
    Patient: {
        init: (id) => ({ resourceType: "Patient", id }),
        essential: "",
        has: () => true,
        done: (r) => {
            const n = (r.name as Obj[] | undefined)?.[0];
            if (n && !n.text) {
                const t = [(n.given as string[] | undefined)?.join(" "), n.family as string | undefined]
                    .filter(Boolean).join(" ");
                if (t) n.text = t;
            }
        },
    },
    Condition: {
        init: (id, subject) => ({ resourceType: "Condition", id, subject }),
        essential: "a diagnosis",
        has: (r) => !!codeText(r.code),
    },
    MedicationStatement: {
        init: (id, subject) => ({ resourceType: "MedicationStatement", id, status: "unknown", subject }),
        essential: "a medication name",
        has: (r) => !!codeText(r.medicationCodeableConcept),
    },
    Observation: {
        init: (id, subject) => ({ resourceType: "Observation", id, status: "unknown", subject }),
        essential: "a test name",
        has: (r) => !!codeText(r.code),
        done: (r) => {
            const unit = text(r._unit);
            delete r._unit;
            if (!unit) return;
            const q = r.valueQuantity as Obj | undefined;
            if (q) q.unit = unit;
            else return `unit "${unit}" had no numeric result to attach to, dropped`;
        },
    },
    AllergyIntolerance: {
        init: (id, subject) => ({ resourceType: "AllergyIntolerance", id, patient: subject }),
        essential: "an allergen",
        has: (r) => !!codeText(r.code),
    },
};