import { fhirToCsv } from "./fromFhirJson/fhirJToCsv";
import { fhirJToFhirX } from "./fromFhirJson/fhirJToFhirX";
import { fhirJToV2J } from "./fromFhirJson/fhirJToV2J";
import { fhirJToCda } from "./fromFhirJson/fhirJToCda";
import type { ExportResult, Exporter, FhirBundle } from "./types";

const fhirToJson = (bundle: FhirBundle, baseName: string): ExportResult => ({
    blob: new Blob([JSON.stringify(bundle, null, 2)], { type: "application/fhir+json" }),
    filename: `${baseName}.fhir.json`,
    notes: [],
});

export const EXPORTERS: Record<string, { label: string; run: Exporter }> = {
    json: { label: "FHIR JSON (.fhir.json)", run: fhirToJson },
    xml: { label: "FHIR XML (.fhir.xml)", run: fhirJToFhirX },
    csv: { label: "CSV (.csv)", run: fhirToCsv },
    v2: { label: "HL7 v2 (.hl7)", run: fhirJToV2J },
    cda: { label: "CDA (.cda.xml)", run: fhirJToCda },
};