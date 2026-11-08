import Papa from "papaparse";
import { TARGETS } from "../targets";
import type { ExportResult, FhirBundle, FhirResource } from "../types";

type Row = Record<string, string>;
const COLS = [...TARGETS] as string[];
const blank = (): Row => Object.fromEntries(COLS.map((c) => [c, ""]));

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const at = (o: unknown, ...path: (string | number)[]): unknown =>
    path.reduce<unknown>(
        (acc, k) => (acc as Record<string | number, unknown> | null | undefined)?.[k],
        o
    );

const codeText = (c: unknown): string =>
    text(at(c, "text")) || text(at(c, "coding", 0, "display")) || text(at(c, "coding", 0, "code"));

function patientName(p: FhirResource): string {
    const t = text(at(p, "name", 0, "text"));
    if (t) return t;
    const given = at(p, "name", 0, "given");
    return [Array.isArray(given) ? given.join(" ") : "", text(at(p, "name", 0, "family"))]
        .join(" ")
        .trim();
}

function observationValue(r: FhirResource): string {
    const s = text(r.valueString);
    if (s) return s;
    const v = at(r, "valueQuantity", "value");
    if (typeof v === "number") return `${v} ${text(at(r, "valueQuantity", "unit"))}`.trim();
    return "";
}

export function fhirToCsv(bundle: FhirBundle, baseName: string): ExportResult {
    const resources = (bundle.entry ?? [])
        .map((e) => e.resource)
        .filter((r): r is FhirResource => !!r);
    const notes: string[] = [];

    const patients = new Map<string, Row>();
    for (const r of resources) {
        if (r.resourceType !== "Patient") continue;
        patients.set(r.id, {
            ...blank(),
            "Patient.identifier.value": text(at(r, "identifier", 0, "value")),
            "Patient.name.text": patientName(r),
            "Patient.birthDate": text(r.birthDate),
            "Patient.gender": text(r.gender),
        });
    }
    if (patients.size === 0) notes.push("No Patient resources found");

    const rows: Row[] = [];
    const withClinicalRow = new Set<string>();
    const skipped: Record<string, number> = {};
    let orphans = 0;

    for (const r of resources) {
        if (r.resourceType === "Patient") continue;
        const ref = text(at(r, "subject", "reference")).replace(/^Patient\//, "");
        const base = patients.get(ref);
        const row: Row = { ...(base ?? blank()) };

        if (r.resourceType === "Condition") {
            row["Condition.code.text"] = codeText(r.code);
        } else if (r.resourceType === "MedicationStatement") {
            row["MedicationStatement.medicationCodeableConcept.text"] = codeText(r.medicationCodeableConcept);
        } else if (r.resourceType === "Observation") {
            row["Observation.code.text"] = codeText(r.code);
            row["Observation.valueString"] = observationValue(r);
        } else {
            skipped[r.resourceType] = (skipped[r.resourceType] ?? 0) + 1;
            continue;
        }

        if (base) withClinicalRow.add(ref);
        else orphans++;
        rows.push(row);
    }

    // patients with no clinical items still get a row
    for (const [id, row] of patients) if (!withClinicalRow.has(id)) rows.push(row);

    for (const [t, n] of Object.entries(skipped))
        notes.push(`Dropped ${n} ${t} resource(s): CSV has no column for them`);
    if (orphans) notes.push(`${orphans} item(s) had no matching Patient, exported with blank patient columns`);
    notes.push("Observation code and value are separate columns, so re-importing the CSV creates separate Observations");

    const csv = Papa.unparse(rows, { columns: COLS });
    return {
        blob: new Blob([csv], { type: "text/csv;charset=utf-8" }),
        filename: `${baseName}.csv`,
        notes,
    };
}