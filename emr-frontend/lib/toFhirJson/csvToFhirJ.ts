export type Mapping = Record<string, string | null>; // CSV column -> target

type Row = Record<string, string>;

export function csvToFhir(rows: Row[], mapping: Mapping) {
    const entries: object[] = [];
    const warnings: string[] = [];
    const unmapped = Object.keys(mapping).filter((c) => !mapping[c]);

    rows.forEach((row, i) => {
        const pid = crypto.randomUUID();
        const patient: Record<string, unknown> = { resourceType: "Patient", id: pid };
        const others: object[] = [];
        const subject = { reference: `Patient/${pid}` };

        for (const [col, target] of Object.entries(mapping)) {
            const v = row[col]?.trim();
            if (!target || !v) continue;

            switch (target) {
                case "Patient.name.text":
                    patient.name = [{ text: v }];
                    break;
                case "Patient.birthDate":
                    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
                        patient.birthDate = v;
                    } else {
                        warnings.push(`Row ${i + 1}: "${v}" is not YYYY-MM-DD, left out of birthDate`);
                    }
                    break;
                case "Patient.gender": {
                    const g = v.toLowerCase();
                    patient.gender = ["m", "male"].includes(g) ? "male"
                        : ["f", "female"].includes(g) ? "female"
                            : ["o", "other"].includes(g) ? "other" : "unknown";
                    break;
                }
                case "Patient.identifier.value":
                    patient.identifier = [{ value: v }];
                    break;
                case "Condition.code.text":
                    others.push({ resourceType: "Condition", id: crypto.randomUUID(), subject, code: { text: v } });
                    break;
                case "MedicationStatement.medicationCodeableConcept.text":
                    others.push({
                        resourceType: "MedicationStatement", id: crypto.randomUUID(),
                        status: "unknown", subject, medicationCodeableConcept: { text: v },
                    });
                    break;
                case "Observation.code.text":
                    others.push({
                        resourceType: "Observation", id: crypto.randomUUID(),
                        status: "unknown", subject, code: { text: v },
                    });
                    break;
                case "Observation.valueString":
                    others.push({
                        resourceType: "Observation", id: crypto.randomUUID(),
                        status: "unknown", subject, code: { text: col }, valueString: v,
                    });
                    break;
            }
        }
        entries.push(patient, ...others);
    });

    const bundle = {
        resourceType: "Bundle",
        type: "collection",
        entry: entries.map((resource) => ({ resource })),
    };
    return { bundle, report: { rows: rows.length, resources: entries.length, unmapped, warnings } };
}