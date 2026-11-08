import { fhirToCsv } from "./fromFhirJson/fhirJToCsv";
import type { ExportResult, Exporter, FhirBundle } from "./types";

const fhirToJson = (bundle: FhirBundle, baseName: string): ExportResult => ({
    blob: new Blob([JSON.stringify(bundle, null, 2)], { type: "application/fhir+json" }),
    filename: `${baseName}.fhir.json`,
    notes: [],
});

export const EXPORTERS: Record<string, { label: string; run: Exporter }> = {
    json: { label: "FHIR JSON (.fhir.json)", run: fhirToJson },
    csv: { label: "CSV (.csv)", run: fhirToCsv },
    // v2: { label: "HL7 v2 (.hl7)", run: fhirToV2 },
    // cda: { label: "CDA (.xml)", run: fhirToCda },
};