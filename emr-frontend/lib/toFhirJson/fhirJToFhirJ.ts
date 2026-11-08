import { toBundle, type FhirResource, type ImportResult } from "../types";
// pass through file to make it so an uploaded fhir file is able to be processed.
export function fhirJToFhirJ(text: string): ImportResult {
    let data: { resourceType?: string; entry?: { resource?: FhirResource }[] };
    try {
        data = JSON.parse(text);
    } catch {
        return { bundle: toBundle([]), notes: ["Not valid JSON"], patients: 0 };
    }

    const resources: FhirResource[] =
        data.resourceType === "Bundle"
            ? (data.entry ?? []).map((e) => e.resource).filter((r): r is FhirResource => !!r)
            : data.resourceType
                ? [data as unknown as FhirResource]
                : [];

    const notes: string[] = [];
    if (resources.length === 0) notes.push("No FHIR resources found in this file");
    const patients = resources.filter((r) => r.resourceType === "Patient").length;
    return { bundle: toBundle(resources), notes, patients };
}