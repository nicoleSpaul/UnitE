import { EXTENSION, EXT_URL, KINDS, TARGET_BY_ID, type ResourceKind, type Target } from "../targets";
import { toBundle, type FhirResource } from "../types";

export type Mapping = Record<string, string | null>;
type Row = Record<string, string>;
type Item = { col: string; target: Target };

const CLINICAL: ResourceKind[] = ["Condition", "MedicationStatement", "Observation", "AllergyIntolerance"];

export function csvToFhir(rows: Row[], mapping: Mapping) {
    const entries: FhirResource[] = [];
    const warnings: string[] = [];
    const cols = Object.keys(mapping);
    const unmapped = cols.filter((c) => !mapping[c]);
    const kept = cols.filter((c) => mapping[c] === EXTENSION);
    const unknownTargets = new Set<string>();

    const idCol = cols.find((c) => mapping[c] === "Patient.identifier.value");
    const patients = new Map<string, FhirResource>();

    rows.forEach((row, i) => {
        const n = i + 1;
        const val = (c: string) => row[c]?.trim() ?? "";

        // columns that have a value in this row, grouped by resource type
        const byKind = new Map<ResourceKind, Item[]>();
        for (const c of cols) {
            const id = mapping[c];
            if (!id || id === EXTENSION || !val(c)) continue;
            const t = TARGET_BY_ID.get(id);
            if (!t) { unknownTargets.add(id); continue; }
            const list = byKind.get(t.on) ?? [];
            list.push({ col: c, target: t });
            byKind.set(t.on, list);
        }

        const apply = (res: FhirResource, items: Item[]) => {
            for (const { col, target } of items) {
                const w = target.set(res, val(col), { column: col });
                if (w) warnings.push(`Row ${n}, "${col}": ${w}`);
            }
            const w = KINDS[res.resourceType as ResourceKind].done?.(res);
            if (w) warnings.push(`Row ${n}: ${w}`);
        };

        // --- patient: one per ID, the first row defines it ---
        const key = (idCol && val(idCol)) || `row-${i}`;
        let patient = patients.get(key);
        if (!patient) {
            patient = KINDS.Patient.init(crypto.randomUUID(), { reference: "" });
            apply(patient, byKind.get("Patient") ?? []);
            patients.set(key, patient);
            entries.push(patient);
        } else {
            for (const { col, target } of byKind.get("Patient") ?? []) {
                const probe = KINDS.Patient.init("probe", { reference: "" });
                target.set(probe, val(col), { column: col });
                const a = target.get(patient);
                const b = target.get(probe);
                if (a !== b) {
                    warnings.push(`Row ${n}, "${col}": "${b}" differs from "${a}" in the first row for this patient, kept the first`);
                }
            }
        }
        const subject = { reference: `Patient/${patient.id}` };

        // --- kept columns ride along on the Patient as extensions ---
        for (const c of kept) {
            const v = val(c);
            if (!v) continue;
            const url = EXT_URL + encodeURIComponent(c);
            const ext = (patient.extension as { url: string; valueString: string }[] | undefined) ?? [];
            if (!ext.some((e) => e.url === url && e.valueString === v)) ext.push({ url, valueString: v });
            patient.extension = ext;
        }

        // --- clinical resources ---
        for (const kind of CLINICAL) {
            const items = byKind.get(kind) ?? [];
            if (!items.length) continue;
            const shared = items.filter((x) => !x.target.perColumn);
            const single = items.filter((x) => x.target.perColumn);
            const groups: Item[][] = [...(shared.length ? [shared] : []), ...single.map((x) => [x])];

            for (const g of groups) {
                const res = KINDS[kind].init(crypto.randomUUID(), subject);
                apply(res, g);
                if (KINDS[kind].has(res)) {
                    entries.push(res);
                } else {
                    const from = g.map((x) => `"${x.col}"`).join(", ");
                    warnings.push(`Row ${n}: ${kind} from ${from} has no ${KINDS[kind].essential}, dropped`);
                }
            }
        }
    });

    for (const id of unknownTargets) warnings.push(`Unknown mapping target "${id}" ignored`);
    if (kept.length) warnings.push(`Kept ${kept.length} unmapped column(s) as extensions: ${kept.join(", ")}`);

    return {
        bundle: toBundle(entries),
        report: { rows: rows.length, resources: entries.length, unmapped, warnings },
    };
}